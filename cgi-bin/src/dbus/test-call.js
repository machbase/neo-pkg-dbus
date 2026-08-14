'use strict';

const path = require('path');
const { error } = require('../config/errors.js');
const { loadSettings } = require('../config/settings-loader.js');
const { buildTypedArguments } = require('./arguments.js');
const { createDbusAdapter } = require('./adapter.js');
const { InterfaceStore } = require('../interfaces/store.js');

function invalid(reason, details) { throw error('REQUEST_INVALID', reason, details); }

class TestCallManager {
  constructor(options) {
    const settings = options || {};
    this.cgiRoot = settings.cgiRoot;
    this.interfaceStore = settings.interfaceStore || (this.cgiRoot ? new InterfaceStore({ cgiRoot: this.cgiRoot }) : null);
    this.settings = settings.settings || (this.cgiRoot ? loadSettings(path.join(this.cgiRoot, 'conf.d', 'settings.json')) : null);
    this.dbusFactory = settings.dbusFactory || (() => createDbusAdapter());
    this.now = settings.now || (() => new Date());
  }

  resolve(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('Test Call body는 객체여야 합니다.');
    if (Object.keys(payload).some((key) => !['interfaceId', 'methodId', 'inputs'].includes(key))) invalid('Test Call은 interfaceId, methodId, inputs만 받을 수 있습니다.');
    if (typeof payload.interfaceId !== 'string' || !payload.interfaceId) invalid('Test Call interfaceId가 필요합니다.');
    if (typeof payload.methodId !== 'string' || !payload.methodId) invalid('Test Call methodId가 필요합니다.');
    if (!payload.inputs || typeof payload.inputs !== 'object' || Array.isArray(payload.inputs)) invalid('Test Call inputs는 객체여야 합니다.');
    if (!this.interfaceStore) invalid('DBus Interface 저장소를 읽을 수 없습니다.');
    const dbusInterface = this.interfaceStore.find(payload.interfaceId);
    if (!dbusInterface) throw error('DBUS_INTERFACE_NOT_FOUND', 'Test Call DBus Interface를 찾을 수 없습니다.', { id: payload.interfaceId });
    const method = dbusInterface.methods.find((item) => item.id === payload.methodId);
    if (!method) throw error('DBUS_METHOD_NOT_FOUND', 'Test Call DBus Method를 찾을 수 없습니다.', { interfaceId: payload.interfaceId, methodId: payload.methodId });
    if (!this.settings || !this.settings.limits) invalid('Test Call settings limits를 읽을 수 없습니다.');
    return {
      dbusInterface, method,
      dbus: { busType: dbusInterface.busType, destination: dbusInterface.destination },
      callMethod: { objectPath: dbusInterface.objectPath, interface: dbusInterface.interface, methodName: method.member },
      inputs: payload.inputs,
    };
  }

  call(payload, callback) {
    let dbus = null;
    try {
      const request = this.resolve(payload);
      const requested = this.now();
      const args = buildTypedArguments(request.method.inputs, request.inputs);
      try { dbus = this.dbusFactory(); dbus.connect(request.dbus.busType); } catch (_) { throw error('DBUS_UNAVAILABLE', 'DBus에 연결할 수 없습니다.'); }
      let response;
      try { response = dbus.call(request.dbus, request.callMethod, args); } catch (_) { throw error('DBUS_CALL_FAILED', 'DBus Method 호출에 실패했습니다.'); }
      const completed = this.now();
      callback(null, { requestedAt: requested.toISOString(), durationMs: Math.max(0, completed.getTime() - requested.getTime()), success: true, valueCount: response.body.length, values: response.body, body: response.body });
    } catch (failure) { callback(failure); } finally { if (dbus) dbus.close(); }
  }
}

module.exports = { TestCallManager };
