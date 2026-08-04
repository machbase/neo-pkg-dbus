'use strict';

const path = require('path');
const { error } = require('../config/errors.js');
const { loadSettings } = require('../config/settings-loader.js');
const { buildTypedArguments } = require('./arguments.js');
const { createDbusAdapter } = require('./adapter.js');
const { decodeOutput } = require('../output/decoder.js');
const { ProfileStore } = require('../profiles/store.js');
const { validateMethod, validateProfile } = require('../profiles/validator.js');
const { generateLsTags } = require('../tag/ls.js');

const DBUS_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function invalid(reason, details) {
  throw error('REQUEST_INVALID', reason, details);
}

function sameDefinition(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

class TestCallManager {
  constructor(options) {
    const settings = options || {};
    this.cgiRoot = settings.cgiRoot;
    this.profileStore = settings.profileStore || (this.cgiRoot ? new ProfileStore({ cgiRoot: this.cgiRoot }) : null);
    this.settings = settings.settings || (this.cgiRoot
      ? loadSettings(path.join(this.cgiRoot, 'conf.d', 'settings.json')) : null);
    this.dbusFactory = settings.dbusFactory || (() => createDbusAdapter());
    this.now = settings.now || (() => new Date());
  }

  resolve(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('Test Call body는 객체여야 합니다.');
    let profile;
    if (payload.profile && typeof payload.profile === 'object' && !Array.isArray(payload.profile)) {
      profile = validateProfile(payload.profile);
    } else if (typeof payload.profileId === 'string' && this.profileStore) {
      profile = this.profileStore.find(payload.profileId);
      if (!profile) throw error('PROFILE_NOT_FOUND', 'Test Call Profile을 찾을 수 없습니다.', { id: payload.profileId });
    } else invalid('현재 Profile draft 또는 profileId가 필요합니다.');

    let method;
    if (payload.method && typeof payload.method === 'object' && !Array.isArray(payload.method)) {
      method = validateMethod(payload.method);
      const profileMethod = profile.methods.find((candidate) => candidate.id === method.id);
      if (!profileMethod || !sameDefinition(profileMethod, method)) {
        invalid('Test Call Method draft는 같은 요청의 Profile methods에 동일하게 들어 있어야 합니다.');
      }
    } else if (typeof payload.methodId === 'string') {
      method = profile.methods.find((candidate) => candidate.id === payload.methodId);
      if (!method) throw error('METHOD_NOT_FOUND', 'Test Call Method를 찾을 수 없습니다.', { id: payload.methodId });
    } else invalid('현재 Method draft 또는 methodId가 필요합니다.');

    const dbus = payload.dbus;
    if (!dbus || typeof dbus !== 'object' || Array.isArray(dbus)
      || !['system', 'session'].includes(dbus.busType) || !DBUS_NAME.test(dbus.destination || '')) {
      invalid('Test Call DBus 설정이 잘못되었습니다.');
    }
    if (!payload.inputs || typeof payload.inputs !== 'object' || Array.isArray(payload.inputs)) {
      invalid('Test Call inputs는 객체여야 합니다.');
    }
    if (!this.settings || !this.settings.limits) invalid('Test Call settings limits를 읽을 수 없습니다.');
    return { profile, method, dbus: { busType: dbus.busType, destination: dbus.destination }, inputs: payload.inputs };
  }

  suggestedTags(method, inputs) {
    if (!method.tagGeneration || method.tagGeneration.capability !== 'ls-get-device-data') return [];
    return generateLsTags(
      inputs[method.tagGeneration.addressInputId],
      inputs[method.tagGeneration.countInputId],
      this.settings.limits.maxGeneratedTagsPerCall,
    );
  }

  call(payload, callback) {
    let dbus = null;
    try {
      const request = this.resolve(payload);
      const requested = this.now();
      const args = buildTypedArguments(request.method.inputs, request.inputs);
      const suggestedTags = this.suggestedTags(request.method, request.inputs);
      const count = suggestedTags.length ? suggestedTags.length : undefined;
      try {
        dbus = this.dbusFactory();
        dbus.connect(request.dbus.busType);
      } catch (_) {
        throw error('DBUS_UNAVAILABLE', 'DBus에 연결할 수 없습니다.');
      }
      let response;
      try {
        response = dbus.call(request.dbus, request.method, args);
      } catch (_) {
        throw error('DBUS_CALL_FAILED', 'DBus Method 호출에 실패했습니다.');
      }
      const decoded = decodeOutput(response.body, request.method.output, request.inputs, count);
      const completed = this.now();
      callback(null, {
        requestedAt: requested.toISOString(),
        durationMs: Math.max(0, completed.getTime() - requested.getTime()),
        success: true,
        valueCount: decoded.values.length,
        returnedCount: decoded.returnedCount,
        values: decoded.values,
        suggestedTags,
        body: decoded.body,
      });
    } catch (callError) {
      callback(callError);
    } finally {
      if (dbus) dbus.close();
    }
  }
}

module.exports = { TestCallManager };
