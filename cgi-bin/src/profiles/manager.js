'use strict';

const { error } = require('../config/errors.js');
const { profileLockKey } = require('../config/profile-lock-key.js');
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('../config/settings-loader.js');
const { createControllerAdapter } = require('../service/controller-adapter.js');
const { createLsRuntime } = require('../collector/ls-runtime.js');
const { loadProductPolicy } = require('../config/product-policy.js');
const { validateMethod, validateProfile } = require('./validator.js');
const { ProfileStore } = require('./store.js');
const { ReferenceAnalyzer } = require('./references.js');
const { createJobOperationLock } = require('../jobs/operation-lock.js');

class ProfileManager {
  constructor(options) {
    const settings = options || {};
    const productPolicy = settings.productPolicy || loadProductPolicy(settings.cgiRoot);
    this.store = settings.store || new ProfileStore({
      cgiRoot: settings.cgiRoot,
      runtimeNeoVersion: settings.runtimeNeoVersion,
    });
    this.controller = settings.controller || createControllerAdapter(settings.serviceModule);
    const lsRuntime = productPolicy.target === 'ls' ? createLsRuntime({
      cgiRoot: settings.cgiRoot,
      controller: this.controller,
      // Profile guards only call inspect(), but retain a complete adapter
      // shape so the data-plane implementation remains encapsulated here.
      repository: { list: () => [] },
    }) : null;
    this.references = settings.references || new ReferenceAnalyzer({
      cgiRoot: settings.cgiRoot,
      controller: this.controller,
      stateInspector: lsRuntime && lsRuntime.inspect,
    });
    this.profileMutationLock = settings.profileMutationLock || createJobOperationLock({
      directory: path.join(settings.cgiRoot, 'conf.d', '.profile-mutation-locks'),
    });
    this.jobOperationLock = settings.jobOperationLock || createJobOperationLock({
      directory: path.join(settings.cgiRoot, 'conf.d', '.job-operation-locks'),
    });
    this.profileReaderLock = settings.profileReaderLock || createJobOperationLock({
      directory: path.join(settings.cgiRoot, 'conf.d', '.profile-mutation-readers'),
    });
  }

  execute(callback, operation) {
    try {
      callback(null, operation());
    } catch (operationError) {
      callback(operationError);
    }
  }

  requiredProfile(id) {
    const profile = this.store.find(id);
    if (!profile) throw error('PROFILE_NOT_FOUND', 'Profile을 찾을 수 없습니다.', { id });
    return profile;
  }

  writableProfile(id) {
    const profile = this.requiredProfile(id);
    if (profile.builtIn) throw error('PROFILE_READ_ONLY', 'Built-in Profile은 바꿀 수 없습니다.', { id });
    return profile;
  }

  listProfiles(callback) {
    this.execute(callback, () => {
      const settings = loadSettings(path.join(this.store.cgiRoot, 'conf.d', 'settings.json'));
      return this.store.list().map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        vendor: profile.vendor,
        builtIn: profile.builtIn,
        profileVersion: profile.profileVersion,
        methodCount: profile.methods.length,
        compatible: this.store.isCompatible(profile),
        compatibilityReason: this.store.isCompatible(profile)
          ? null
          : `Neo ${this.store.runtimeNeoVersion}에서는 최소 ${profile.compatibility.minNeoVersion} Profile을 사용할 수 없습니다.`,
        default: settings.defaultProfileId === profile.id,
      }));
    });
  }

  getProfile(id, callback) {
    let profile;
    let refs;
    try {
      profile = this.requiredProfile(id);
      refs = this.references.find(id);
    } catch (getError) {
      callback(getError);
      return;
    }
    this.references.withStates(refs, (_error, references) => callback(null, {
      profile,
      compatible: this.store.isCompatible(profile),
      compatibilityReason: this.store.isCompatible(profile)
        ? null
        : `Neo ${this.store.runtimeNeoVersion}에서는 최소 ${profile.compatibility.minNeoVersion} Profile을 사용할 수 없습니다.`,
      references,
    }));
  }

  createProfile(value, callback) {
    let profileId;
    try {
      profileId = validateProfile({ ...value, builtIn: false, profileVersion: 1 }).id;
    } catch (createError) {
      callback(createError);
      return;
    }
    this.guardMutation(profileId, 'PROFILE_IN_USE_BY_RUNNING_JOB', [], callback, () => {
      const valid = validateProfile({ ...value, builtIn: false, profileVersion: 1 });
      if (this.store.find(valid.id)) throw error('PROFILE_ALREADY_EXISTS', '같은 Profile ID가 이미 있습니다.', { id: valid.id });
      return this.store.save({ ...valid, builtIn: false });
    }, () => this.references.find(profileId));
  }

  guardMutation(profileId, code, references, callback, operation, refreshReferences) {
    let fence;
    const handles = [];
    let completed = false;
    const done = (failure, value) => {
      if (completed) return;
      completed = true;
      let releaseFailure = null;
      [...handles].reverse().forEach((handle) => {
        try { handle.release(); } catch (cleanupError) { if (!releaseFailure) releaseFailure = cleanupError; }
      });
      try { if (fence) fence.release(); } catch (cleanupError) { if (!releaseFailure) releaseFailure = cleanupError; }
      if (failure && releaseFailure && typeof failure === 'object') failure.cleanupError = releaseFailure;
      callback(failure || releaseFailure, value);
    };
    try {
      fence = this.profileMutationLock.acquire(profileLockKey(profileId));
      const readerPrefix = `${profileLockKey(profileId)}--`;
      fs.readdirSync(path.join(this.store.cgiRoot, 'conf.d', '.profile-mutation-readers'))
        .filter((entry) => entry.startsWith(readerPrefix) && entry.endsWith('.lock'))
        .forEach((entry) => {
          const reader = this.profileReaderLock.acquire(entry.slice(0, -5));
          reader.release();
        });
      references = refreshReferences ? refreshReferences() : references;
      const invalidJob = references.find((reference) => reference.invalidConfig);
      if (invalidJob) throw error('JOB_INVALID_CONFIG', 'Job 파일명과 document name이 달라 안전하게 변경할 수 없습니다.', {
        fileName: invalidJob.name, documentName: invalidJob.documentName,
      });
      [...new Set(references.map((reference) => reference.name))].sort()
        .forEach((name) => handles.push(this.jobOperationLock.acquire(name)));
    } catch (acquireError) { done(acquireError); return; }
    try {
      references = refreshReferences ? refreshReferences() : references;
      const invalidJob = references.find((reference) => reference.invalidConfig);
      if (invalidJob) throw error('JOB_INVALID_CONFIG', 'Job 파일명과 document name이 달라 안전하게 변경할 수 없습니다.', {
        fileName: invalidJob.name, documentName: invalidJob.documentName,
      });
    } catch (refreshError) { done(refreshError); return; }
    this.references.withStates(references, (_stateError, values) => {
      const invalidJob = values.find((reference) => reference.invalidConfig);
      if (invalidJob) {
        done(error('JOB_INVALID_CONFIG', 'Job 파일명과 document name이 달라 안전하게 변경할 수 없습니다.', {
          fileName: invalidJob.name,
          documentName: invalidJob.documentName,
        }));
        return;
      }
      const blocking = values.filter((reference) => ['RUNNING', 'STARTING', 'STOPPING', 'UNKNOWN'].includes(reference.controllerState));
      if (blocking.length) {
        done(error(code, '실행 중이거나 상태를 알 수 없는 참조 Job 때문에 바꿀 수 없습니다.', { jobs: blocking }));
        return;
      }
      this.execute(done, operation);
    });
  }

  withProfileFence(profileId, callback, operation) {
    let fence;
    try {
      fence = this.profileMutationLock.acquire(profileLockKey(profileId));
      const readerPrefix = `${profileLockKey(profileId)}--`;
      fs.readdirSync(path.join(this.store.cgiRoot, 'conf.d', '.profile-mutation-readers'))
        .filter((entry) => entry.startsWith(readerPrefix) && entry.endsWith('.lock'))
        .forEach((entry) => {
          const reader = this.profileReaderLock.acquire(entry.slice(0, -5));
          reader.release();
        });
    } catch (failure) {
      let releaseFailure = null;
      try { if (fence) fence.release(); } catch (cleanupError) { releaseFailure = cleanupError; }
      if (releaseFailure && failure && typeof failure === 'object') failure.cleanupError = releaseFailure;
      callback(failure || releaseFailure);
      return;
    }
    let finished = false;
    const done = (failure, value) => {
      if (finished) return;
      finished = true;
      let releaseFailure = null;
      try { fence.release(); } catch (cleanupError) { releaseFailure = cleanupError; }
      if (failure && releaseFailure && typeof failure === 'object') failure.cleanupError = releaseFailure;
      callback(failure || releaseFailure, value);
    };
    this.execute(done, operation);
  }

  updateProfile(value, callback) {
    let profileId;
    try {
      profileId = validateProfile({ ...value, builtIn: false }).id;
    } catch (updateError) {
      callback(updateError);
      return;
    }
    this.guardMutation(profileId, 'PROFILE_IN_USE_BY_RUNNING_JOB', [], callback, () => {
      const current = this.writableProfile(profileId);
      const valid = validateProfile({ ...value, builtIn: false });
      const nextMethodIds = new Set(valid.methods.map((method) => method.id));
      const removed = current.methods.filter((method) => !nextMethodIds.has(method.id));
      for (const removedMethod of removed) {
        const methodRefs = this.references.find(current.id, removedMethod.id);
        if (methodRefs.length) throw error('METHOD_IN_USE', 'Job이 참조하는 Method는 Profile PUT으로 지울 수 없습니다.', {
          profileId: current.id,
          id: removedMethod.id,
          jobs: methodRefs,
        });
      }
      return this.store.save({
        ...valid,
        builtIn: false,
        profileVersion: current.profileVersion + 1,
      });
    }, () => this.references.find(profileId));
  }

  deleteProfile(id, callback) {
    this.withProfileFence(id, callback, () => {
      this.writableProfile(id);
      const settings = loadSettings(path.join(this.store.cgiRoot, 'conf.d', 'settings.json'));
      if (settings.defaultProfileId === id) {
        throw error('PROFILE_DEFAULT', '기본 Profile은 다른 기본값을 선택하기 전에 지울 수 없습니다.', {
          id, defaultProfileId: settings.defaultProfileId,
        });
      }
      const refs = this.references.find(id);
      const invalidJob = refs.find((reference) => reference.invalidConfig);
      if (invalidJob) throw error('JOB_INVALID_CONFIG', 'Job 파일명과 document name이 달라 안전하게 변경할 수 없습니다.', {
        fileName: invalidJob.name,
        documentName: invalidJob.documentName,
      });
      if (refs.length) throw error('PROFILE_IN_USE', 'Job이 참조하는 Profile은 지울 수 없습니다.', { jobs: refs });
      this.store.remove(id);
      return { id };
    });
  }

  listMethods(profileId, callback) {
    this.execute(callback, () => this.requiredProfile(profileId).methods.map((method) => ({
      id: method.id,
      displayName: method.displayName,
      inputCount: method.inputs.length,
      outputShape: method.output.shape,
    })));
  }

  getMethod(profileId, id, callback) {
    let profile;
    let method;
    let refs;
    try {
      profile = this.requiredProfile(profileId);
      method = profile.methods.find((item) => item.id === id);
      if (!method) throw error('METHOD_NOT_FOUND', 'Method를 찾을 수 없습니다.', { profileId, id });
      refs = this.references.find(profileId, id);
    } catch (getError) {
      callback(getError);
      return;
    }
    this.references.withStates(refs, (_error, references) => callback(null, { method, references }));
  }

  createMethod(profileId, value, callback) {
    this.guardMutation(profileId, 'METHOD_IN_USE_BY_RUNNING_JOB', [], callback, () => {
      const profile = this.writableProfile(profileId);
      const method = validateMethod(value);
      if (profile.methods.some((item) => item.id === method.id)) {
        throw error('METHOD_ALREADY_EXISTS', '같은 Method ID가 이미 있습니다.', { profileId, id: method.id });
      }
      this.store.save({ ...profile, profileVersion: profile.profileVersion + 1, methods: [...profile.methods, method] });
      return method;
    }, () => this.references.find(profileId));
  }

  updateMethod(profileId, value, callback) {
    let methodId;
    try { methodId = validateMethod(value).id; } catch (updateError) { callback(updateError); return; }
    this.guardMutation(profileId, 'METHOD_IN_USE_BY_RUNNING_JOB', [], callback, () => {
      const profile = this.writableProfile(profileId);
      const method = validateMethod(value);
      const index = profile.methods.findIndex((item) => item.id === method.id);
      if (index < 0) throw error('METHOD_NOT_FOUND', 'Method를 찾을 수 없습니다.', { profileId, id: method.id });
      const methods = profile.methods.slice();
      methods[index] = method;
      this.store.save({ ...profile, profileVersion: profile.profileVersion + 1, methods });
      return method;
    }, () => this.references.find(profileId, methodId));
  }

  deleteMethod(profileId, id, callback) {
    this.withProfileFence(profileId, callback, () => {
      const profile = this.writableProfile(profileId);
      const index = profile.methods.findIndex((item) => item.id === id);
      if (index < 0) throw error('METHOD_NOT_FOUND', 'Method를 찾을 수 없습니다.', { profileId, id });
      const invalidProfileJob = this.references.find(profileId).find((reference) => reference.invalidConfig);
      if (invalidProfileJob) throw error('JOB_INVALID_CONFIG', 'Job 파일명과 document name이 달라 안전하게 변경할 수 없습니다.', {
        fileName: invalidProfileJob.name,
        documentName: invalidProfileJob.documentName,
      });
      const refs = this.references.find(profileId, id);
      const invalidJob = refs.find((reference) => reference.invalidConfig);
      if (invalidJob) throw error('JOB_INVALID_CONFIG', 'Job 파일명과 document name이 달라 안전하게 변경할 수 없습니다.', {
        fileName: invalidJob.name,
        documentName: invalidJob.documentName,
      });
      if (refs.length) throw error('METHOD_IN_USE', 'Job이 참조하는 Method는 지울 수 없습니다.', { jobs: refs });
      const methods = profile.methods.slice();
      methods.splice(index, 1);
      this.store.save({ ...profile, profileVersion: profile.profileVersion + 1, methods });
      return { profileId, id };
    });
  }
}

module.exports = { ProfileManager };
