'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TestCallManager } = require('../src/dbus/test-call.js');

function call(manager, payload) {
  return new Promise((resolve, reject) => manager.call(payload, (failure, value) => (failure ? reject(failure) : resolve(value))));
}

function lsInterface() {
  return {
    schemaVersion: 1, id: 'ls-plc-device', builtIn: true, busType: 'system', destination: 'ls.plc',
    objectPath: '/ls/plc/device', interface: 'ls.plc.device', methods: [{
      id: 'get-device-data', source: 'manual', member: 'GetDeviceData',
      inputs: [{ name: 'dataCount', type: 'uint16' }, { name: 'memoryAddress', type: 'string' }], outputs: [],
    }],
  };
}

function customInterface() {
  return {
    schemaVersion: 1, id: 'custom-device', builtIn: false, busType: 'session', destination: 'custom.device',
    objectPath: '/custom/device', interface: 'custom.device.Status', methods: [{
      id: 'read-value', source: 'manual', member: 'ReadValue', inputs: [], outputs: [{ name: 'value', type: 'uint16' }],
    }],
  };
}

function interfaceStore(...items) { return { find(id) { return items.find((item) => item.id === id) || null; } }; }

async function testCallResolvesInterfaceAndMethod() {
  const seen = [];
  const instants = [new Date('2026-08-03T00:00:00.000Z'), new Date('2026-08-03T00:00:00.025Z')];
  const manager = new TestCallManager({
    interfaceStore: interfaceStore(lsInterface()), settings: { limits: { maxGeneratedTagsPerCall: 1000 } }, now() { return instants.shift(); },
    dbusFactory() { return {
      connect(type) { assert.equal(type, 'system'); },
      call(config, method, args) { seen.push({ config, method, args }); return { body: ['{"rtn":1,"data-count":2,"data":[1,"READY"]}'] }; },
      close() {},
    }; },
  });
  const result = await call(manager, { interfaceId: 'ls-plc-device', methodId: 'get-device-data', inputs: { dataCount: 2, memoryAddress: '%MB8' } });
  assert.equal(seen[0].config.destination, 'ls.plc');
  assert.deepEqual(seen[0].method, { objectPath: '/ls/plc/device', interface: 'ls.plc.device', methodName: 'GetDeviceData' });
  assert.deepEqual(seen[0].args, ['uint16:2', 'string:%MB8']);
  assert.equal(result.valueCount, 1);
  assert.deepEqual(result.values, ['{"rtn":1,"data-count":2,"data":[1,"READY"]}']);
  assert.deepEqual(result.body, result.values);
}

async function testCallRejectsProfileBasedPayload() {
  const manager = new TestCallManager({ interfaceStore: interfaceStore(lsInterface()), settings: { limits: { maxGeneratedTagsPerCall: 1000 } } });
  await assert.rejects(call(manager, { profileId: 'old-profile', methodId: 'get-device-data', inputs: {} }), (failure) => failure.code === 'REQUEST_INVALID');
}

async function testCustomMethodUsesItsInterfaceAddress() {
  const seen = [];
  const manager = new TestCallManager({
    interfaceStore: interfaceStore(customInterface()), settings: { limits: { maxGeneratedTagsPerCall: 1000 } },
    dbusFactory() { return { connect() {}, call(config, method) { seen.push({ config, method }); return { body: [7] }; }, close() {} }; },
  });
  const result = await call(manager, { interfaceId: 'custom-device', methodId: 'read-value', inputs: {} });
  assert.equal(seen[0].config.busType, 'session');
  assert.equal(seen[0].method.methodName, 'ReadValue');
  assert.deepEqual(result.values, [7]);
}

async function testCallFailureDoesNotLeakBody() {
  const manager = new TestCallManager({
    interfaceStore: interfaceStore(lsInterface()), settings: { limits: { maxGeneratedTagsPerCall: 1000 } },
    dbusFactory() { return { connect() {}, call() { throw new Error('raw body: {password:secret}'); }, close() {} }; },
  });
  await assert.rejects(call(manager, { interfaceId: 'ls-plc-device', methodId: 'get-device-data', inputs: { dataCount: 1, memoryAddress: '%MB3' } }), (failure) => (
    failure.code === 'DBUS_CALL_FAILED' && !JSON.stringify(failure).includes('secret')
  ));
}

async function testCallRejectsNeoUnsupportedStandardType() {
  const complex = {
    ...customInterface(),
    methods: [{
      id: 'set-properties', source: 'manual', member: 'SetProperties',
      inputs: [{ name: 'properties', type: { type: 'array', element: { type: 'dict-entry', key: 'string', value: 'variant' } } }], outputs: [],
    }],
  };
  const manager = new TestCallManager({
    interfaceStore: interfaceStore(complex), settings: { limits: { maxGeneratedTagsPerCall: 1000 } },
    dbusFactory() { throw new Error('DBus call must not start'); },
  });
  await assert.rejects(call(manager, {
    interfaceId: 'custom-device', methodId: 'set-properties',
    inputs: { properties: [{ key: 'mode', value: { type: 'string', value: 'auto' } }] },
  }), (failure) => failure.code === 'DBUS_ARGUMENT_UNSUPPORTED' && failure.details.type === 'array');
}

function testCgiUsesOnlyInterfacePayload() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-call-api-'));
  try {
    const root = path.join(temporary, 'cgi-bin');
    fs.cpSync(path.resolve(__dirname, '..'), root, { recursive: true });
    fs.rmSync(path.join(root, 'interfaces.d'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'conf.d', 'interfaces'), { recursive: true });
    fs.writeFileSync(path.join(root, 'conf.d', 'interfaces', 'ls-plc-device.json'), JSON.stringify(lsInterface()));
    const moduleRoot = path.join(temporary, 'node_modules', 'dbus');
    fs.mkdirSync(moduleRoot, { recursive: true });
    fs.writeFileSync(path.join(moduleRoot, 'index.js'), 'module.exports={Connection:class{call(){return {body:[\'{"rtn":1,"data-count":1,"data":[7]}\']}} close(){}}};');
    const program = "const e=process.env; process.env={...e,get:(n)=>e[n]}; process.stdin.read=()=>process.argv[2]; require(process.argv[1]);";
    const result = childProcess.spawnSync(process.execPath, ['-e', program, path.join(root, 'api', 'dbus', 'call.js'), JSON.stringify({ interfaceId: 'ls-plc-device', methodId: 'get-device-data', inputs: { dataCount: 1, memoryAddress: '%MB3' } })], {
      encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(temporary, 'node_modules'), REQUEST_METHOD: 'POST' },
    });
    assert.equal(result.status, 0, result.stderr);
    const split = result.stdout.indexOf('\r\n\r\n');
    const payload = JSON.parse(result.stdout.slice(split + 4));
    assert.equal(payload.ok, true);
    assert.equal(payload.data.values[0], '{"rtn":1,"data-count":1,"data":[7]}');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

Promise.resolve()
  .then(testCallResolvesInterfaceAndMethod)
  .then(testCallRejectsProfileBasedPayload)
  .then(testCustomMethodUsesItsInterfaceAddress)
  .then(testCallFailureDoesNotLeakBody)
  .then(testCallRejectsNeoUnsupportedStandardType)
  .then(() => { testCgiUsesOnlyInterfacePayload(); console.log('DBus Test Call: ok'); })
  .catch((failure) => { console.error(failure); process.exitCode = 1; });
