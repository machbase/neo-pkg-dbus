'use strict';

const path = require('path');
const { error } = require('../config/errors.js');
const { loadSettings } = require('../config/settings-loader.js');
const { loadProductPolicy } = require('../config/product-policy.js');
const { resolveIntervalPolicy } = require('../ls/interval-policy.js');
const { createDatabaseValidationAdapter } = require('../db/validation-adapter.js');
const { jobNeedsStringValueColumn } = require('../output/storage-policy.js');
const { InterfaceStore } = require('../interfaces/store.js');
const { profileLockKey: interfaceLockKey } = require('../config/profile-lock-key.js');
const { classifyControllerState } = require('../service/controller-state.js');
const { createControllerAdapter, isNotInstalled } = require('../service/controller-adapter.js');
const { createLsRuntime } = require('../collector/ls-runtime.js');
const { createServerStore } = require('../db/server-store.js');
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

function tagsForCall(call) {
  if (Array.isArray(call && call.outputSelections)) {
    return call.outputSelections.flatMap((selection) => Array.isArray(selection.tags) ? selection.tags : []);
  }
  return Array.isArray(call && call.tags) ? call.tags : [];
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
    'startedAt', 'completedAt', 'status',
    'lastRunAt', 'lastSuccessfulRunAt', 'lastStoredAt', 'lastError',
    'overrunCount', 'queueSkipped', 'lastOverrunAt',
  ]);
  if (Array.isArray(value.methodCalls)) {
    result.methodCalls = value.methodCalls.map((method) => pick(method, [
      'id', 'name', 'interfaceId', 'methodId', 'requestedAt', 'completedAt', 'status', 'storedCount', 'error',
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
    this.interfaceStore = settings.interfaceStore || new InterfaceStore({ cgiRoot: this.cgiRoot });
    this.productPolicy = settings.productPolicy || loadProductPolicy(this.cgiRoot);
    this.dbusFactory = settings.dbusFactory;
    this.isLs = this.productPolicy.target === 'ls';
    this.serverStore = settings.serverStore || createServerStore({ cgiRoot: this.cgiRoot });
    this.lsRuntime = this.isLs ? (settings.lsRuntime || createLsRuntime({
      cgiRoot: this.cgiRoot,
      controller: this.controller,
      repository: this.repository,
      serverStore: this.serverStore,
      process: settings.process,
    })) : null;
    this.operationLock = settings.operationLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.job-operation-locks'),
    });
    this.packageLifecycleLock = settings.packageLifecycleLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.package-lifecycle-locks'),
    });
    this.interfaceMutationLock = settings.interfaceMutationLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.interface-mutation-locks'),
    });
    this.interfaceReaderLock = settings.interfaceReaderLock || createJobOperationLock({
      directory: path.join(this.cgiRoot, 'conf.d', '.interface-mutation-readers'),
    });
    this.settingsFile = settings.settingsFile || path.join(this.cgiRoot, 'conf.d', 'settings.json');
    this.collectorPath = settings.collectorPath || path.join(this.cgiRoot, 'neo-collector.js');
  }

  get jobDir() { return this.repository.directory; }

  validateName(name) { return validateJobName(name); }

  serviceName(name) { return serviceName(name); }

  configPath(name) { return this.repository.file(name); }

  settings() { return loadSettings(this.settingsFile); }

  requestJsonMaxBytes() { return this.productPolicy.maxRequestJsonBytes; }

  validateConfig(config, options) {
    const productLimits = this.productPolicy.validationLimits || {};
    // Reading an existing configuration must not contact the PLC.  Older Jobs
    // can legitimately contain an interval which predates the task-cycle
    // policy; enforce it only when a user creates or saves a Job.
    const enforceInterval = options?.enforceInterval !== false;
    const intervalPolicy = enforceInterval
      ? resolveIntervalPolicy({ settings: this.settings(), productPolicy: this.productPolicy, dbusFactory: this.dbusFactory })
      : { cycleMs: 1 };
    const validated = validateJobConfig(config, {
      interfaceStore: this.interfaceStore,
      limits: { ...this.settings().limits, ...productLimits },
      minimumIntervalMs: this.productPolicy.minimumIntervalMs || 1000,
      intervalCycleMs: intervalPolicy.cycleMs,
      maxJobJsonBytes: this.productPolicy.maxJobJsonBytes,
    });
    const productValidated = this.productPolicy.validateProductConfig(validated);
    if (this.isLs && options?.enforceDatabaseProfile !== false
      && productValidated.database.server !== this.settings().defaults.database.server) {
      throw error('LS_DATABASE_PROFILE_REQUIRED', 'LS Job은 기본 Database 설정만 사용할 수 있습니다.', {
        server: this.settings().defaults.database.server,
      });
    }
    return productValidated;
  }

  validateDatabase(config, callback) {
    if (!this.isLs) { this.database.validate(config.database, callback); return; }
    this.serverStore.get(config.database.server, (serverError, server) => {
      if (serverError) { callback(serverError); return; }
      if (!server) { callback(error('DB_SERVER_NOT_FOUND', '등록 DB server를 찾을 수 없습니다.', { server: config.database.server })); return; }
      // The DB server record is the LS database profile. Keep the Job document
      // compatible, but always validate/save its table mapping from that one
      // shared profile rather than accepting an inline table override.
      config.database = {
        ...config.database,
        table: server.defaultTable || config.database.table,
        valueColumn: server.valueColumn || config.database.valueColumn,
        stringValueColumn: server.stringValueColumn || config.database.stringValueColumn,
      };
      this.database.validate(config.database, callback);
    });
  }

  databaseOptions(config) {
    return {
      needsStringValueColumn: jobNeedsStringValueColumn(config, this.interfaceStore),
    };
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

  assertInterfaceMutationAvailable(interfaceId, name) {
    try {
      this.interfaceMutationLock.assertAvailable(interfaceLockKey(interfaceId));
    } catch (failure) {
      if (failure && failure.code === 'JOB_CONFLICT') {
        throw error('JOB_CONFLICT', 'DBus Interface 변경이 Job 시작 또는 저장을 진행하고 있습니다.', { name, interfaceId });
      }
      throw failure;
    }
  }

  withMutation(name, callback, operation) {
    let handle;
    let holdInterfaces;
    const readers = [];
    const heldInterfaceIds = new Set();
    try {
      this.assertPackageLifecycleAvailable(name);
      handle = this.operationLock.acquire(name);
      this.assertPackageLifecycleAvailable(name);
      holdInterfaces = (config) => {
        const ids = [...new Set(((config && config.methodCalls) || []).map((call) => call && call.interfaceId)
          .filter((id) => typeof id === 'string'))].sort();
        ids.forEach((interfaceId) => {
          if (heldInterfaceIds.has(interfaceId)) return;
          this.assertInterfaceMutationAvailable(interfaceId, name);
          const reader = this.interfaceReaderLock.acquire(`${interfaceLockKey(interfaceId)}--${name}`);
          readers.push(reader);
          heldInterfaceIds.add(interfaceId);
          this.assertInterfaceMutationAvailable(interfaceId, name);
        });
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
    try { operation(handle, done, holdInterfaces); } catch (failure) { done(failure); }
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
    if (this.isLs) { this.lsRuntime.inspect(name, callback); return; }
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
      return { document, config: this.validateConfig(stripName(document), { enforceInterval: false, enforceDatabaseProfile: false }), revision };
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
      interfaceIds: config ? [...new Set((config.methodCalls || []).map((call) => call.interfaceId))].sort() : [],
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
    if (this.isLs) { this.lsRuntime.lastRun(name, callback); return; }
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
    if (this.isLs) { this.createLs(payload, callback); return; }
    this.callback(callback, () => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw error('JOB_INVALID', 'Job create body는 객체여야 합니다.');
      }
      const unknown = Object.keys(payload).filter((key) => !['name', 'config'].includes(key));
      if (unknown.length || !Object.prototype.hasOwnProperty.call(payload, 'config')) {
        throw error('JOB_INVALID', 'Job create body는 name과 config만 포함해야 합니다.', { fields: unknown });
      }
      const name = this.validateName(payload.name);
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        let config;
        try {
          holdInterfaces(payload.config);
          config = this.validateConfig(payload.config);
        } catch (validationError) { done(validationError); return; }
        this.inspect(name, (_unused, state) => {
          if (state.statusError) { done(state.statusError); return; }
          if (state.controllerState !== 'NOT_INSTALLED') {
            done(error('SERVICE_ALREADY_INSTALLED', '같은 이름의 Controller service가 이미 있습니다.', {
              name, controllerState: state.controllerState,
            }));
            return;
          }
          this.database.ensure(config.database, this.databaseOptions(config), (databaseError) => {
            if (databaseError) { done(databaseError); return; }
            let document;
            const discardConfig = (failure) => {
              try {
                handle.assertOwned();
                this.repository.remove(name);
              } catch (cleanupError) {
                failure.details = { ...(failure.details || {}), cleanupError: cleanupError.message };
              }
              done(failure);
            };
            try {
              handle.assertOwned();
              document = this.repository.create(name, config);
            } catch (createError) {
              done(createError);
              return;
            }
            const descriptor = {
              name: this.serviceName(name),
              enable: false,
              working_dir: this.cgiRoot,
              executable: this.collectorPath,
              args: [`${name}.json`],
            };
            try { handle.assertOwned(); } catch (ownershipError) { discardConfig(ownershipError); return; }
            this.callController('install', [descriptor], (installError) => {
              if (installError) {
                discardConfig(controllerFailure(
                  'CONTROLLER_UNAVAILABLE', 'Job service를 자동 설치하지 못했습니다.',
                  name, 'NOT_INSTALLED', installError.message,
                ));
                return;
              }
              this.inspect(name, (_inspectError, after) => {
                if (!after.statusError && after.controllerState === 'STOPPED') {
                  done(null, this.view(name, config, after, null, revisionOf(document)));
                  return;
                }
                const failure = after.statusError || controllerFailure(
                  'CONTROLLER_OPERATION_FAILED', '자동 설치한 service가 STOPPED 상태가 아닙니다.',
                  name, after.controllerState, after.controllerDetail,
                );
                try { handle.assertOwned(); } catch (ownershipError) { discardConfig(ownershipError); return; }
                this.callController('uninstall', [this.serviceName(name)], (cleanupError) => {
                  if (cleanupError) failure.details = { ...(failure.details || {}), cleanupError: cleanupError.message };
                  discardConfig(failure);
                });
              });
            });
          });
        });
      });
    });
  }

  warnings(name, config) {
    const currentTags = new Set();
    config.methodCalls.forEach((call) => tagsForCall(call).forEach((tag) => currentTags.add(tag.name)));
    const jobs = [];
    const tags = new Set();
    this.repository.list().forEach((record) => {
      if (!record.document || record.name === name) return;
      const other = stripName(record.document);
      if (!other.database || other.database.server !== config.database.server
        || other.database.table !== config.database.table || !Array.isArray(other.methodCalls)) return;
      let matched = false;
      other.methodCalls.forEach((call) => {
        tagsForCall(call).forEach((tag) => {
          if (currentTags.has(tag.name)) { matched = true; tags.add(tag.name); }
        });
      });
      if (matched) jobs.push(record.name);
    });
    if (!jobs.length) return [];
    return [{
      code: 'TAG_NAME_USED_BY_ANOTHER_JOB',
      reason: '같은 DB table의 Tag name을 다른 Job도 사용합니다.',
      path: '/methodCalls',
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
        try { callback(null, { valid: true, warnings: this.warnings(name, config) }); }
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
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        this.guardMutable(name, (guardError, current) => {
          if (guardError) { done(guardError); return; }
          if (!Number.isSafeInteger(patch.revision) || patch.revision < 1) {
            done(error('JOB_REVISION_REQUIRED', 'Job 수정에는 GET으로 받은 revision이 필요합니다.', { name }));
            return;
          }
          try {
            const { revision, ...configPatch } = patch;
            const existing = current.config;
            holdInterfaces(existing);
            const merged = deepMerge(deepMerge(jobDefaults(), existing), configPatch);
            holdInterfaces(merged);
            const config = this.validateConfig(merged);
            this.database.ensure(config.database, this.databaseOptions(config), (databaseError) => {
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

  // Log level is operational metadata rather than a data-plane configuration.
  // LS can apply it to the daemon without stopping a reader or resetting its
  // runtime checkpoint. All other Job edits remain blocked while running.
  updateLog(name, patch, callback) {
    if (!this.isLs) {
      callback(error('LOG_HOT_APPLY_NOT_AVAILABLE', '실행 중 Log Level 변경은 LS 제품에서만 지원합니다.', { name }));
      return;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.keys(patch).some((key) => !['revision', 'level'].includes(key))) {
      callback(error('JOB_INVALID', 'Log Level 변경은 revision과 level만 포함해야 합니다.', { name }));
      return;
    }
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        let current;
        try {
          current = this.readValidated(name);
          holdInterfaces(current.config);
        } catch (readError) { done(readError); return; }
        if (!Number.isSafeInteger(patch.revision) || patch.revision < 1) {
          done(error('JOB_REVISION_REQUIRED', 'Log Level 변경에는 GET으로 받은 revision이 필요합니다.', { name }));
          return;
        }
        let config;
        try {
          config = this.validateConfig({
            ...current.config,
            log: { ...current.config.log, level: patch.level },
          }, { enforceDatabaseProfile: false });
        } catch (validationError) { done(validationError); return; }
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          let document;
          try {
            handle.assertOwned();
            document = this.repository.save(name, { ...config, name, revision: patch.revision + 1 }, patch.revision);
            this.lsRuntime.snapshot();
          } catch (saveError) { done(saveError); return; }
          const complete = () => this.inspect(name, (_ignored, after) => done(
            after.statusError,
            this.view(name, config, after, null, revisionOf(document)),
          ));
          if (before.controllerState !== 'RUNNING') { complete(); return; }
          this.lsRuntime.refreshLog(name, (controlError) => {
            if (controlError) {
              done(controllerFailure('CONTROLLER_OPERATION_FAILED', 'LS Job Log Level을 즉시 반영하지 못했습니다.', name, 'RUNNING', controlError.message));
              return;
            }
            complete();
          });
        });
      });
    });
  }

  clearOverrun(name, callback) {
    if (!this.isLs) {
      callback(error('OVERRUN_CLEAR_NOT_AVAILABLE', 'Skipped cycle 초기화는 LS 제품에서만 지원합니다.', { name }));
      return;
    }
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        try { this.readValidated(name); } catch (readError) { done(readError); return; }
        try { handle.assertOwned(); } catch (lockError) { done(lockError); return; }
        this.lsRuntime.clearOverrun(name, (controlError) => {
          if (controlError) {
            done(controllerFailure('CONTROLLER_OPERATION_FAILED', 'LS Job skipped cycle 초기화에 실패했습니다.', name, 'UNKNOWN', controlError.message));
            return;
          }
          this.lsRuntime.lastRun(name, (runtimeError, lastRun) => {
            if (runtimeError) { done(runtimeError); return; }
            done(null, { lastRun: projectLastRun(lastRun) });
          });
        });
      });
    });
  }

  install(name, callback) {
    if (this.isLs) { this.installLs(name, callback); return; }
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        const current = this.readValidated(name);
        try { holdInterfaces(current.config); } catch (interfaceConflict) { done(interfaceConflict); return; }
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
            enable: false,
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
    if (this.isLs) { this.startLs(name, callback); return; }
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        const current = this.readValidated(name);
        try { holdInterfaces(current.config); }
        catch (interfaceConflict) { done(interfaceConflict); return; }
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          if (['RUNNING', 'STARTING', 'STOPPING'].includes(before.controllerState)) {
            done(error('JOB_RUNNING', '실행 중이거나 전환 중인 Job은 시작할 수 없습니다.', {
              name, controllerState: before.controllerState,
            }));
            return;
          }
          const startInstalled = (installedState) => this.validateDatabase(current.config, (databaseError) => {
            if (databaseError) { done(databaseError); return; }
            try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
            this.callController('start', [this.serviceName(name)], (startError) => {
              if (startError) {
                done(controllerFailure(
                  'CONTROLLER_UNAVAILABLE', 'Job service를 시작하지 못했습니다.',
                  name, installedState.controllerState, startError.message,
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
          if (before.controllerState !== 'NOT_INSTALLED') { startInstalled(before); return; }
          const descriptor = {
            name: this.serviceName(name),
            enable: false,
            working_dir: this.cgiRoot,
            executable: this.collectorPath,
            args: [`${name}.json`],
          };
          try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
          this.callController('install', [descriptor], (installError) => {
            if (installError) {
              done(controllerFailure(
                'CONTROLLER_UNAVAILABLE', 'Job service를 자동 설치하지 못했습니다.',
                name, 'NOT_INSTALLED', installError.message,
              ));
              return;
            }
            this.inspect(name, (_inspectError, installedState) => {
              if (installedState.statusError) { done(installedState.statusError); return; }
              if (installedState.controllerState !== 'STOPPED') {
                done(controllerFailure(
                  'CONTROLLER_OPERATION_FAILED', '자동 설치한 service가 STOPPED 상태가 아닙니다.',
                  name, installedState.controllerState, installedState.controllerDetail,
                ));
                return;
              }
              startInstalled(installedState);
            });
          });
        });
      });
    });
  }

  stop(name, callback) {
    if (this.isLs) { this.stopLs(name, callback); return; }
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
    if (this.isLs) { this.stopForPackageLs(name, callback); return; }
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
    if (this.isLs) { this.deleteLs(name, callback); return; }
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

  // LS keeps the public Job lifecycle but maps it to one daemon service and
  // logical per-Job control commands. Generic deliberately does not use this
  // path until its separate migration branch.
  createLs(payload, callback) {
    this.callback(callback, () => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some((key) => !['name', 'config'].includes(key))
        || !Object.prototype.hasOwnProperty.call(payload, 'config')) {
        throw error('JOB_INVALID', 'Job create body는 name과 config만 포함해야 합니다.');
      }
      const name = this.validateName(payload.name);
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        let config;
        try { holdInterfaces(payload.config); config = this.validateConfig(payload.config); }
        catch (validationError) { done(validationError); return; }
        this.database.ensure(config.database, this.databaseOptions(config), (databaseError) => {
          if (databaseError) { done(databaseError); return; }
          let document;
          try { handle.assertOwned(); document = this.repository.create(name, config); this.lsRuntime.snapshot(); }
          catch (createError) { done(createError); return; }
          this.lsRuntime.install((installError) => {
            if (installError) {
              try { this.repository.remove(name); this.lsRuntime.snapshot(); } catch (_) {}
              done(controllerFailure('CONTROLLER_UNAVAILABLE', 'LS collector daemon을 설치하지 못했습니다.', name, 'NOT_INSTALLED', installError.message));
              return;
            }
            this.inspect(name, (_unused, state) => done(state.statusError, this.view(
              name, config, state, null, revisionOf(document),
            )));
          });
        });
      });
    });
  }

  installLs(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        let current;
        try { current = this.readValidated(name); holdInterfaces(current.config); this.lsRuntime.snapshot(); }
        catch (readError) { done(readError); return; }
        try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
        this.lsRuntime.install((installError) => {
          if (installError) { done(controllerFailure('CONTROLLER_UNAVAILABLE', 'LS collector daemon을 설치하지 못했습니다.', name, 'NOT_INSTALLED', installError.message)); return; }
          this.inspect(name, (_unused, state) => done(state.statusError, this.view(name, current.config, state, null, current.revision)));
        });
      });
    });
  }

  startLs(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done, holdInterfaces) => {
        let current;
        try { current = this.readValidated(name); holdInterfaces(current.config); }
        catch (readError) { done(readError); return; }
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          if (before.controllerState === 'RUNNING') { done(error('JOB_RUNNING', '실행 중인 Job은 시작할 수 없습니다.', { name })); return; }
          this.validateDatabase(current.config, (databaseError) => {
            if (databaseError) { done(databaseError); return; }
            try { handle.assertOwned(); this.lsRuntime.snapshot(); } catch (snapshotError) { done(snapshotError); return; }
            this.lsRuntime.ensureRunning((startError) => {
              if (startError) { done(controllerFailure('CONTROLLER_UNAVAILABLE', 'LS collector daemon을 시작하지 못했습니다.', name, before.controllerState, startError.message)); return; }
              this.lsRuntime.start(name, (controlError) => {
                if (controlError) { done(controllerFailure('CONTROLLER_OPERATION_FAILED', 'LS Job 시작 제어에 실패했습니다.', name, 'STOPPED', controlError.message)); return; }
                this.inspect(name, (_ignored, after) => {
                  if (after.statusError || after.controllerState !== 'RUNNING') {
                    done(after.statusError || controllerFailure('CONTROLLER_OPERATION_FAILED', 'LS Job 시작 상태를 확인하지 못했습니다.', name, after.controllerState, after.controllerDetail));
                  } else done(null, this.view(name, current.config, after, null, current.revision));
                });
              });
            });
          });
        });
      });
    });
  }

  stopLs(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        let current;
        try { current = this.readValidated(name); } catch (readError) { done(readError); return; }
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          if (before.controllerState !== 'RUNNING') { done(error('SERVICE_NOT_RUNNING', '실행 중인 LS Job만 멈출 수 있습니다.', { name })); return; }
          try { handle.assertOwned(); } catch (ownershipError) { done(ownershipError); return; }
          this.lsRuntime.stop(name, (stopError) => {
            if (stopError) { done(controllerFailure('CONTROLLER_OPERATION_FAILED', 'LS Job 중지 제어에 실패했습니다.', name, 'RUNNING', stopError.message)); return; }
            this.inspect(name, (_ignored, after) => done(after.statusError, this.view(name, current.config, after, null, current.revision)));
          });
        });
      });
    });
  }

  stopForPackageLs(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        let current;
        try { current = this.readValidated(name); } catch (readError) { done(readError); return; }
        this.inspect(name, (_unused, before) => {
          if (before.statusError) { done(before.statusError); return; }
          // Package stop only stops the one daemon after all Job locks have
          // been acquired. Keep logical active state for package start.
          try { handle.assertOwned(); done(null, this.view(name, current.config, before, null, current.revision)); }
          catch (ownershipError) { done(ownershipError); }
        });
      });
    });
  }

  deleteLs(name, callback) {
    this.callback(callback, () => {
      this.validateName(name);
      this.withMutation(name, callback, (handle, done) => {
        this.guardMutable(name, (guardError) => {
          if (guardError) { done(guardError); return; }
          try {
            handle.assertOwned();
            const removed = this.repository.remove(name);
            this.lsRuntime.snapshot();
            // The daemon belongs to the package, not to its last logical Job.
            // Package uninstall owns controller unregistering.
            done(null, removed);
          } catch (deleteError) { done(deleteError); }
        });
      });
    });
  }

  installPackageService(callback) {
    if (!this.isLs) { callback(null); return; }
    try { this.lsRuntime.installPackage(callback); } catch (installError) { callback(installError); }
  }

  startDaemonForPackage(callback) {
    if (!this.isLs) { callback(null); return; }
    this.lsRuntime.startDaemon(callback);
  }

  stopDaemonForPackage(callback) {
    if (!this.isLs) { callback(null); return; }
    this.lsRuntime.stopDaemon(callback);
  }

  uninstallDaemonForPackage(callback) {
    if (!this.isLs) { callback(null); return; }
    this.lsRuntime.uninstall(callback);
  }

  daemonStatus(callback) {
    if (!this.isLs) { callback(null, null); return; }
    this.lsRuntime.daemonStatus(callback);
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
