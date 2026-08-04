'use strict';

const path = require('path');
const { error } = require('../config/errors.js');
const { profileLockKey } = require('../config/profile-lock-key.js');
const { loadSettings } = require('../config/settings-loader.js');
const { createDatabaseValidationAdapter } = require('../db/validation-adapter.js');
const { ProfileStore } = require('../profiles/store.js');
const { classifyControllerState } = require('../service/controller-state.js');
const { createControllerAdapter, isNotInstalled } = require('../service/controller-adapter.js');
const { jobDefaults } = require('./defaults.js');
const { createJobOperationLock } = require('./operation-lock.js');
const { JobRepository, revisionOf } = require('./repository.js');
const { deepMerge, validateJobConfig, validateJobName } = require('./validator.js');

const SERVICE_PREFIX = '_dbu_';

function serviceName(name) {
  return `${SERVICE_PREFIX}${validateJobName(name)}`;
}

function publicError(source) {
  return {
    code: (source && source.code) || 'INTERNAL_ERROR',
    reason: source && source.message ? source.message : String(source || 'unknown error'),
    details: (source && source.details) || {},
  };
}

function controllerFailure(code, reason, name, state, detail) {
  return error(code, reason, {
    name,
    controllerState: state || 'UNKNOWN',
    controllerDetail: detail || null,
  });
}

function stripName(document) {
  const config = { ...document };
  delete config.name;
  delete config.revision;
  return config;
}

function pick(source, fields) {
  const result = {};
  fields.forEach((field) => {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
  });
  return result;
}

function projectLastRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = pick(value, [
    'startedAt', 'completedAt', 'status', 'profileId', 'profileVersion',
    'lastRunAt', 'lastSuccessfulRunAt', 'lastStoredAt', 'lastError',
  ]);
  if (Array.isArray(value.methodCalls)) {
    result.methodCalls = value.methodCalls.map((method) => pick(method, [
      'id', 'name', 'requestedAt', 'completedAt', 'status', 'storedCount', 'error',
    ]));
  }
  return result;
}

class JobManager {
  constructor(options) {
    const settings = options || {};
    this.cgiRoot = settings.cgiRoot;
    this.controller = settings.controller || createControllerAdapter(settings.serviceModule);
    this.database = settings.databaseAdapter || createDatabaseValidationAdapter({ cgiRoot: this.cgiRoot });
    this.repository = settings.repository || new JobRepository({
      cgiRoot: this.cgiRoot,
      jobDir: settings.jobDir,
    });
    this.profileStore = settings.profileStore || new ProfileStore({
      cgiRoot: this.cgiRoot,
      runtimeNeoVersion: settings.runtimeNeoVersion,
    });
    this.operationLock = settings.operationLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.job-operation-locks'),
    });
    this.packageLifecycleLock = settings.packageLifecycleLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.package-lifecycle-locks'),
    });
    this.profileMutationLock = settings.profileMutationLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.profile-mutation-locks'),
    });
    this.profileReaderLock = settings.profileReaderLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.profile-mutation-readers'),
    });
    this.settingsFile = settings.settingsFile || path.join(this.cgiRoot, 'conf.d', 'settings.json');
    this.collectorPath = settings.collectorPath || path.join(this.cgiRoot, 'neo-collector.js');
  }

  get jobDir() { return this.repository.directory; }

  validateName(name) { return validateJobName(name); }

  serviceName(name) { return serviceName(name); }

  configPath(name) { return this.repository.file(name); }

  settings() { return loadSettings(this.settingsFile); }

  validateConfig(config) {
    return validateJobConfig(config, {
      profileStore: this.profileStore,
      limits: this.settings().limits,
    });
  }

  validateDatabase(config, callback) {
    this.database.validate(config.database, callback);
  }

  callback(callback, operation) {
    try { operation(); } catch (operationError) { callback(operationError); }
  }

  assertPackageLifecycleAvailable(name) {
    try {
      this.packageLifecycleLock.assertAvailable('package-lifecycle');
    } catch (failure) {
      if (failure && failure.code === 'JOB_CONFLICT') {
        throw error('JOB_CONFLICT', 'package lifecycle이 Job 변경을 진행하고 있습니다.', { name });
      }
      throw failure;
    }
  }

  assertProfileMutationAvailable(profileId, name) {
    try {
      this.profileMutationLock.assertAvailable(profileLockKey(profileId));
    } catch (failure) {
      if (failure && failure.code === 'JOB_CONFLICT') {
        throw error('JOB_CONFLICT', 'Profile 변경이 Job 시작 또는 저장을 진행하고 있습니다.', { name, profileId });
      }
      throw failure;
    }
  }

  withMutation(name, callback, operation) {
    let handle;
    let holdProfile;
    const readers = [];
    try {
      this.assertPackageLifecycleAvailable(name);
      handle = this.operationLock.acquire(name);
      this.assertPackageLifecycleAvailable(name);
      holdProfile = (profileId) => {
        this.assertProfileMutationAvailable(profileId, name);
        const reader = this.profileReaderLock.acquire(`${profileLockKey(profileId)}--${name}`);
        readers.push(reader);
        this.assertProfileMutationAvailable(profileId, name);
      };
    } catch (failure) {
      readers.reverse().forEach((reader) => { try { reader.release(); } catch (_) {} });
      if (handle) {
        try { handle.release(); } catch (cleanupError) {
          if (failure && (typeof failure === 'object' || typeof failure === 'function')) {
            failure.cleanupError = cleanupError;
          }
        }
      }
      callback(failure);
      return;
    }
    let finished = false;
    const done = (failure, value) => {
      if (finished) return;
      finished = true;
      let releaseFailure = null;
      readers.reverse().forEach((reader) => { try { reader.release(); } catch (cleanupError) { if (!releaseFailure) releaseFailure = cleanupError; } });
      try { handle.release(); } catch (cleanupError) { releaseFailure = cleanupError; }
      if (failure && releaseFailure && (typeof failure === 'object' || typeof failure === 'function')) {
        failure.cleanupError = releaseFailure;
      }
      callback(failure || releaseFailure, value);
    };
    try { operation(handle, done, holdProfile); } catch (failure) { done(failure); }
  }

  withLifecycleHandle(name, handles, callback, operation) {
    let finished = false;
    const done = (failure, value) => {
      if (finished) return;
      finished = true;
      callback(failure, value);
    };
    try {
      const validatedName = this.validateName(name);
      const handle = handles.get(validatedName);
      if (!handle) throw error('JOB_CONFLICT', 'package lifecycle 대상 Job lock이 없습니다.', { name: validatedName });
      handle.assertOwned();
      operation(validatedName, handle, done);
    } catch (failure) {
      done(failure);
    }
  }

  acquirePackageLifecycle(names) {
    const handles = new Map();
    let fence = null;
    const releaseAll = () => {
      let releaseFailure = null;
      [...handles.entries()].reverse().forEach(([name, handle]) => {
        try {
          handle.release();
          handles.delete(name);
        } catch (failure) {
          if (!releaseFailure) releaseFailure = failure;
        }
      });
      if (handles.size === 0 && fence) {
        try {
          fence.release();
          fence = null;
        } catch (failure) {
          if (!releaseFailure) releaseFailure = failure;
        }
      }
      if (releaseFailure) throw releaseFailure;
    };

    fence = this.packageLifecycleLock.acquire('package-lifecycle');
    const releaseSession = () => {
      if (handles.size === 0 && !fence) return;
      releaseAll();
    };
    const acquireNames = (requestedNames) => {
      if (!fence) throw error('JOB_CONFLICT', 'package lifecycle lock이 이미 해제되었습니다.');
      try {
        const orderedNames = [...new Set(
          (requestedNames || []).map((name) => this.validateName(name)),
        )].sort();
        orderedNames.forEach((name) => {
          if (!handles.has(name)) handles.set(name, this.operationLock.acquire(name));
        });
      } catch (failure) {
        try { releaseSession(); } catch (cleanupError) {
          if (failure && (typeof failure === 'object' || typeof failure === 'function')) {
            failure.cleanupError = cleanupError;
          }
        }
        throw failure;
      }
    };

    acquireNames(names);

    return {
      acquire: acquireNames,
      stopForPackage: (name, callback) => this.withLifecycleHandle(
        name, handles, callback,
        (validatedName, handle, done) => this.stopForPackageWithHandle(validatedName, handle, done),
      ),
      delete: (name, callback) => this.withLifecycleHandle(
        name, handles, callback,
        (validatedName, handle, done) => this.deleteWithHandle(validatedName, handle, done),
      ),
      release: () => {
        releaseSession();
      },
    };
  }

  callController(method, args, callback) {
    let finished = false;
    const done = (callError, value) => {
      if (finished) return;
      finished = true;
      callback(callError, value);
    };
    try {
      if (!this.controller || typeof this.controller[method] !== 'function') {
        done(new Error(`Controller service.${method}()을 사용할 수 없습니다.`));
        return;
      }
      this.controller[method](...args, done);
    } catch (callError) {
      done(callError);
    }
  }

  inspect(name, callback) {
    const target = this.serviceName(name);
    this.callController('status', [target], (statusError, info) => {
      if (statusError && isNotInstalled(statusError)) {
        callback(null, {
          controllerState: 'NOT_INSTALLED', controllerDetail: null, info: null, statusError: null,
        });
        return;
      }
      if (statusError) {
        const failure = controllerFailure(
          'CONTROLLER_UNAVAILABLE', 'Controller 상태를 읽을 수 없습니다.', name, 'UNKNOWN', statusError.message,
        );
        callback(null, {
          controllerState: 'UNKNOWN', controllerDetail: statusError.message || null, info: null, statusError: failure,
        });
        return;
      }
      const classified = classifyControllerState(info);
      const stateError = classified.known ? null : controllerFailure(
        'CONTROLLER_UNKNOWN', 'Controller 상태를 알 수 없어 안전하게 작업할 수 없습니다.',
        name, 'UNKNOWN', classified.detail || '지원하지 않거나 비어 있는 Controller 응답입니다.',
      );
      callback(null, {
        controllerState: classified.state,
        controllerDetail: classified.detail || null,
        info,
        statusError: stateError,
      });
    });
  }

  view(name, config, state, configError, revision) {
    const statusKnown = !state.statusError && state.controllerState !== 'UNKNOWN';
    const installed = statusKnown ? state.controllerState !== 'NOT_INSTALLED' : null;
    const running = statusKnown
      ? ['RUNNING', 'STARTING', 'STOPPING'].includes(state.controllerState)
      : null;
    return {
      name,
      config,
      configState: statusKnown ? (installed ? 'installed' : 'config-only') : null,
      executionState: statusKnown ? (running ? 'running' : 'stopped') : null,
      controllerState: state.controllerState,
      controllerDetail: state.controllerDetail,
      statusKnown,
      installed,
      running,
      ...(Number.isInteger(revision) ? { revision } : {}),
      ...(configError ? { error: publicError(configError) } : {}),
      ...(state.statusError ? { controllerError: publicError(state.statusError) } : {}),
    };
  }

  readValidated(name) {
    const document = this.repository.read(name);
    const revision = revisionOf(document);
    try {
      return { document, config: this.validateConfig(stripName(document)), revision };
    } catch (validationError) {
      if (validationError && validationError.code === 'JOB_INVALID_CONFIG') throw validationError;
      throw error('JOB_INVALID_CONFIG', '저장된 Job 설정이 schemaVersion 1 계약과 맞지 않습니다.', {
        name,
        cause: validationError.message,
        revision,
      });
    }
  }

  diagnostic(name, callback) {
    let value;
    try {
      value = this.readValidated(name);
    } catch (configError) {
      if (configError.code !== 'JOB_INVALID_CONFIG') {
        callback(configError);
        return;
      }
      callback(null, this.view(name, null, {
        controllerState: 'UNKNOWN', controllerDetail: configError.message, statusError: null,
      }, configError, configError.details && configError.details.revision));
      return;
    }
    this.inspect(name, (_unused, state) => callback(null, this.view(name, value.config, state, null, value.revision)));
  }

  get(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.diagnostic(name, callback);
    });
  }

  summary(detail, lastRun) {
    const config = detail.config;
    return {
      name: detail.name,
      profileId: config && config.profileId || null,
      destination: config && config.dbus && config.dbus.destination || null,
      methodCallCount: config && Array.isArray(config.methodCalls) ? config.methodCalls.length : 0,
      configState: detail.configState,
      executionState: detail.executionState,
      controllerState: detail.controllerState,
      controllerDetail: detail.controllerDetail,
      statusKnown: detail.statusKnown,
      installed: detail.installed,
      running: detail.running,
      lastStoredAt: lastRun && lastRun.lastStoredAt || null,
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.controllerError ? { controllerError: detail.controllerError } : {}),
    };
  }

  readLastRun(name, state, callback) {
    if (state.installed === false) { callback(null, null); return; }
    if (state.installed === null) { callback(state.statusError || controllerFailure(
      'CONTROLLER_UNKNOWN', 'Controller 상태를 알 수 없어 service details를 읽을 수 없습니다.',
      name, state.controllerState, state.controllerDetail,
    )); return; }
    this.callController('details', [this.serviceName(name), 'lastRun'], callback);
  }

  list(callback) {
    let records;
    try { records = this.repository.list(); } catch (listError) { callback(listError); return; }
    if (!records.length) { callback(null, []); return; }
    const values = new Array(records.length);
    let pending = records.length;
    records.forEach((record, index) => {
      this.diagnostic(record.name, (detailError, detail) => {
        const resolved = detailError
          ? this.view(record.name, null, {
            controllerState: 'UNKNOWN', controllerDetail: detailError.message, statusError: null,
          }, detailError)
          : detail;
        if (resolved.installed !== true) {
          values[index] = this.summary(resolved, null);
          pending -= 1;
          if (pending === 0) callback(null, values);
          return;
        }
        this.readLastRun(record.name, resolved, (lastRunError, lastRun) => {
          if (lastRunError && !resolved.controllerError) {
            resolved.controllerError = publicError(controllerFailure(
              'CONTROLLER_UNAVAILABLE', 'service details를 읽지 못했습니다.',
              record.name, resolved.controllerState, lastRunError.message,
            ));
          }
          values[index] = this.summary(resolved, projectLastRun(lastRun));
          pending -= 1;
          if (pending === 0) callback(null, values);
        });
      });
    });
  }

  create(payload, callback) {
    this.callback(callback, () => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw error('JOB_INVALID', 'Job create body는 객체여야 합니다.');
      }
      const name = this.validateName(payload.name);
      this.withMutation(name, callback, (handle, done, holdProfile) => {
        let config;
        try {
          const requestedProfileId = payload.config && payload.config.profileId;
          holdProfile(requestedProfileId);
          config = this.validateConfig(payload.config);
        } catch (profileConflict) { done(profileConflict); return; }
        try { this.assertProfileMutationAvailable(config.profileId, name); }
        catch (profileConflict) { done(profileConflict); return; }
        this.inspect(name, (_unused, state) => {
          if (state.statusError) { done(state.statusError); return; }
          if (state.controllerState !== 'NOT_INSTALLED') {
            done(error('SERVICE_ALREADY_INSTALLED', '같은 이름의 Controller service가 이미 있습니다.', {
              name, controllerState: state.controllerState,
            }));
            return;
          }
          this.validateDatabase(config, (databaseError) => {
            if (databaseError) { done(databaseError); return; }
            try {
              handle.assertOwned();
              const document = this.repository.create(name, config);
              done(null, this.view(name, config, state, null, revisionOf(document)));
            } catch (createError) {
              done(createError);
            }
          });
        });
      });
    });
  }

  warnings(name, config) {
    const currentTags = new Set();
    config.methodCalls.forEach((call) => call.tags.forEach((tag) => currentTags.add(tag.name)));
    const jobs = [];
    const tags = new Set();
    this.repository.list().forEach((record) => {
      if (!record.document || record.name === name) return;
      const other = stripName(record.document);
      if (!other.database || other.database.server !== config.database.server
        || other.database.table !== config.database.table || !Array.isArray(other.methodCalls)) return;
      let matched = false;
      other.methodCalls.forEach((call) => {
        if (!Array.isArray(call.tags)) return;
        call.tags.forEach((tag) => {
          if (currentTags.has(tag.name)) { matched = true; tags.add(tag.name); }
        });
      });
      if (matched) jobs.push(record.name);
    });
    if (!jobs.length) return [];
    return [{
      code: 'TAG_NAME_USED_BY_ANOTHER_JOB',
      details: { jobs: jobs.sort(), tags: [...tags].sort() },
    }];
  }

  validate(payload, callback) {
    this.callback(callback, () => {
      const source = payload && Object.prototype.hasOwnProperty.call(payload, 'config')
        ? payload.config : payload;
      const name = payload && Object.prototype.hasOwnProperty.call(payload, 'name')
        ? this.validateName(payload.name) : null;
      const config = this.validateConfig(source);
      this.validateDatabase(config, (databaseError) => {
        if (databaseError) { callback(databaseError); return; }
        try { callback(null, { valid: true, warnings: this.warnings(name, config), config }); }
        catch (warningError) { callback(warningError); }
      });
    });
  }

  guardMutable(name, callback) {
    let value;
    try { value = this.readValidated(name); } catch (readError) { callback(readError); return; }
    this.inspect(name, (_unused, state) => {
      if (state.statusError) { callback(state.statusError); return; }
      if (['RUNNING', 'STARTING', 'STOPPING'].includes(state.controllerState)) {
        callback(error('JOB_RUNNING', '실행 중이거나 전환 중인 Job은 바꾸거나 지울 수 없습니다.', {
          name, controllerState: state.controllerState,
        }));
        return;
      }
      callback(null, value, state);
    });
  }

  update(name, patch, callback) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'name')) {
      callback(error('JOB_NAME_IMMUTABLE', 'Job name은 바꿀 수 없습니다.', { name }));
      return;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      callback(error('JOB_INVALID', 'Job patch는 JSON 객체여야 합니다.'));
      return;
    }
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done, holdProfile) => {
        this.guardMutable(name, (guardError, current) => {
          if (guardError) { done(guardError); return; }
          if (!Number.isSafeInteger(patch.revision) || patch.revision < 1) {
            done(error('JOB_REVISION_REQUIRED', 'Job 수정에는 GET으로 받은 revision이 필요합니다.', { name }));
            return;
          }
          try {
            const { revision, ...configPatch } = patch;
            const existing = current.config;
            const targetProfileId = configPatch.profileId || existing.profileId || this.settings().defaultProfileId;
            holdProfile(existing.profileId);
            if (targetProfileId !== existing.profileId) holdProfile(targetProfileId);
            const profile = this.profileStore.find(targetProfileId);
            const merged = deepMerge(deepMerge(jobDefaults(targetProfileId, profile), existing), configPatch);
            const config = this.validateConfig(merged);
            this.validateDatabase(config, (databaseError) => {
              if (databaseError) { done(databaseError); return; }
              try {
                handle.assertOwned();
                const document = this.repository.save(name, { ...config, name, revision: revision + 1 }, revision);
                this.inspect(name, (_unused, state) => done(null, this.view(
                  name, stripName(document), state, null, revisionOf(document),
                )));
              } catch (saveError) {
                done(saveError);
              }
            });
          } catch (updateError) {
            done(updateError);
          }
        });
      });
    });
  }

  install(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        const current = this.readValidated(name);
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          if (before.controllerState !== 'NOT_INSTALLED') {
            done(error('SERVICE_ALREADY_INSTALLED', 'Job service가 이미 설치되어 있습니다.', {
              name, controllerState: before.controllerState,
            }));
            return;
          }
          const descriptor = {
            name: this.serviceName(name),
            enable: true,
            working_dir: this.cgiRoot,
            executable: this.collectorPath,
            args: [`${name}.json`],
          };
          try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
          this.callController('install', [descriptor], (installError) => {
            if (installError) {
              done(controllerFailure(
                'CONTROLLER_UNAVAILABLE', 'Job service를 설치하지 못했습니다.',
                name, 'NOT_INSTALLED', installError.message,
              ));
              return;
            }
            this.inspect(name, (_inspectError, after) => {
              if (!after.statusError && after.controllerState === 'STOPPED') {
                done(null, this.view(name, current.config, after));
                return;
              }
              const failure = after.statusError || controllerFailure(
                'CONTROLLER_OPERATION_FAILED', '설치한 service가 STOPPED 상태가 아닙니다.',
                name, after.controllerState, after.controllerDetail,
              );
              try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
              this.callController('uninstall', [this.serviceName(name)], (cleanupError) => {
                if (cleanupError) failure.details.cleanupError = cleanupError.message;
                done(failure);
              });
            });
          });
        });
      });
    });
  }

  start(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done, holdProfile) => {
        const current = this.readValidated(name);
        try { holdProfile(current.config.profileId); }
        catch (profileConflict) { done(profileConflict); return; }
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          if (before.controllerState === 'NOT_INSTALLED') {
            done(error('SERVICE_NOT_INSTALLED', 'Job service를 먼저 설치해야 합니다.', { name }));
            return;
          }
          if (['RUNNING', 'STARTING', 'STOPPING'].includes(before.controllerState)) {
            done(error('JOB_RUNNING', '실행 중이거나 전환 중인 Job은 시작할 수 없습니다.', {
              name, controllerState: before.controllerState,
            }));
            return;
          }
          this.validateDatabase(current.config, (databaseError) => {
            if (databaseError) { done(databaseError); return; }
            try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
            this.callController('start', [this.serviceName(name)], (startError) => {
              if (startError) {
                done(controllerFailure(
                  'CONTROLLER_UNAVAILABLE', 'Job service를 시작하지 못했습니다.',
                  name, before.controllerState, startError.message,
                ));
                return;
              }
              this.inspect(name, (_inspectError, after) => {
                if (after.statusError) done(after.statusError);
                else if (!['RUNNING', 'STARTING'].includes(after.controllerState)) done(controllerFailure(
                  'CONTROLLER_OPERATION_FAILED', '시작 요청 뒤 service가 시작 상태가 아닙니다.',
                  name, after.controllerState, after.controllerDetail,
                ));
                else done(null, this.view(name, current.config, after));
              });
            });
          });
        });
      });
    });
  }

  stop(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        const current = this.readValidated(name);
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          if (before.controllerState === 'NOT_INSTALLED') {
            done(error('SERVICE_NOT_INSTALLED', 'Job service가 설치되어 있지 않습니다.', { name }));
            return;
          }
          if (['STARTING', 'STOPPING'].includes(before.controllerState)) {
            done(error('JOB_RUNNING', '전환 중인 Job은 새 lifecycle 요청을 받을 수 없습니다.', {
              name, controllerState: before.controllerState,
            }));
            return;
          }
          if (before.controllerState !== 'RUNNING') {
            done(error('SERVICE_NOT_RUNNING', '실행 중인 Job service만 멈출 수 있습니다.', {
              name, controllerState: before.controllerState,
            }));
            return;
          }
          try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
          this.callController('stop', [this.serviceName(name)], (stopError) => {
            if (stopError) {
              done(controllerFailure(
                'CONTROLLER_UNAVAILABLE', 'Job service를 멈추지 못했습니다.',
                name, before.controllerState, stopError.message,
              ));
              return;
            }
            this.inspect(name, (_inspectError, after) => {
              if (after.statusError) done(after.statusError);
              else if (!['STOPPING', 'STOPPED'].includes(after.controllerState)) done(controllerFailure(
                'CONTROLLER_OPERATION_FAILED', '중지 요청 뒤 service가 중지 상태가 아닙니다.',
                name, after.controllerState, after.controllerDetail,
              ));
              else done(null, this.view(name, current.config, after));
            });
          });
        });
      });
    });
  }

  stopForPackage(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        this.stopForPackageWithHandle(name, handle, done);
      });
    });
  }

  stopForPackageWithHandle(name, handle, done) {
    const current = this.readValidated(name);
    this.inspect(name, (_unused, before) => {
      if (before.statusError) { done(before.statusError); return; }
      if (['NOT_INSTALLED', 'STOPPED', 'FAILED'].includes(before.controllerState)) {
        done(null, this.view(name, current.config, before));
        return;
      }
      if (!['RUNNING', 'STARTING', 'STOPPING'].includes(before.controllerState)) {
        done(controllerFailure(
          'CONTROLLER_UNKNOWN', 'Controller 상태를 알 수 없어 package stop을 진행할 수 없습니다.',
          name, before.controllerState, before.controllerDetail,
        ));
        return;
      }
      try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
      this.callController('stop', [this.serviceName(name)], (stopError) => {
        if (stopError) {
          done(controllerFailure(
            'CONTROLLER_UNAVAILABLE', 'package stop 중 Job service를 멈추지 못했습니다.',
            name, before.controllerState, stopError.message,
          ));
          return;
        }
        this.inspect(name, (_inspectError, after) => {
          if (after.statusError) { done(after.statusError); return; }
          if (!['NOT_INSTALLED', 'STOPPED', 'FAILED'].includes(after.controllerState)) {
            done(controllerFailure(
              'CONTROLLER_OPERATION_FAILED', 'package stop 뒤 service가 안전한 정지 상태가 아닙니다.',
              name, after.controllerState, after.controllerDetail,
            ));
            return;
          }
          done(null, this.view(name, current.config, after));
        });
      });
    });
  }

  delete(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        this.deleteWithHandle(name, handle, done);
      });
    });
  }

  deleteWithHandle(name, handle, done) {
    this.guardMutable(name, (guardError, _current, state) => {
      if (guardError) { done(guardError); return; }
      const removeConfig = () => {
        try {
          handle.assertOwned();
          done(null, this.repository.remove(name));
        } catch (removeError) {
          done(removeError);
        }
      };
      if (state.controllerState === 'NOT_INSTALLED') { removeConfig(); return; }
      try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
      this.callController('uninstall', [this.serviceName(name)], (uninstallError) => {
        if (uninstallError && !isNotInstalled(uninstallError)) {
          done(controllerFailure(
            'CONTROLLER_UNAVAILABLE', 'Job service를 정리하지 못했습니다.',
            name, state.controllerState, uninstallError.message,
          ));
          return;
        }
        removeConfig();
      });
    });
  }

  lastRun(name, callback) {
    let current;
    try { current = this.readValidated(name); } catch (readError) { callback(readError); return; }
    this.inspect(name, (_unused, state) => {
      if (state.statusError) { callback(state.statusError); return; }
      if (state.controllerState === 'NOT_INSTALLED') { callback(null, { lastRun: null }); return; }
      this.readLastRun(name, this.view(name, current.config, state), (detailsError, lastRun) => {
        if (detailsError) {
          callback(controllerFailure('CONTROLLER_UNAVAILABLE', 'service details를 읽지 못했습니다.', name, state.controllerState, detailsError.message));
          return;
        }
        callback(null, { lastRun: projectLastRun(lastRun) });
      });
    });
  }
}

module.exports = { JobManager, SERVICE_PREFIX, serviceName };
