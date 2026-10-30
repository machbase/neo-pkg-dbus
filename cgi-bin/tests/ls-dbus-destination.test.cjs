'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jobConfig, setupRoot } = require('./job-fixture.cjs');
const { InterfaceStore } = require('../src/interfaces/store.js');
const { validateJobConfig } = require('../src/jobs/validator.js');
const { resolveIntervalPolicy } = require('../src/ls/interval-policy.js');
const { resolveJobDestination, resolveJobInterfacePrefix } = require('../src/ls/dbus-destination.js');
const { TestCallManager } = require('../src/dbus/test-call.js');

test('LS Jobs select a DBus destination and an independently entered Interface prefix', (t) => {
  const root = setupRoot('ls-job-destination-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    interfaceStore: new InterfaceStore({ cgiRoot: root }),
    limits: { maxGeneratedTagsPerCall: 4096, maxBufferedRowsPerCycle: 10000 },
    minimumIntervalMs: 1,
    allowLsDBusDestination: true,
  };
  assert.equal(validateJobConfig(jobConfig(), options).dbusDestination, 'ls.plc');
  assert.equal(validateJobConfig(jobConfig(), options).dbusInterfacePrefix, 'ls.plc');
  assert.equal(validateJobConfig({ ...jobConfig(), dbusDestination: 'high.ls.plc' }, options).dbusDestination, 'high.ls.plc');
  assert.equal(validateJobConfig({ ...jobConfig(), dbusDestination: 'vendor-test.plc3' }, options).dbusDestination, 'vendor-test.plc3');
  assert.equal(validateJobConfig({ ...jobConfig(), dbusDestination: ':1.2' }, options).dbusDestination, ':1.2');
  assert.equal(validateJobConfig({ ...jobConfig(), dbusInterfacePrefix: 'high.ls.plc' }, options).dbusInterfacePrefix, 'high.ls.plc');
  assert.equal(validateJobConfig({ ...jobConfig(), dbusInterfacePrefix: 'vendor_plc3' }, options).dbusInterfacePrefix, 'vendor_plc3');
  for (const destination of ['', 'single', '.a.b', 'a..b', '1a.b', 'a/b.c', 'a'.repeat(256)]) {
    assert.throws(() => validateJobConfig({ ...jobConfig(), dbusDestination: destination }, options), { code: 'JOB_INVALID' });
  }
  for (const prefix of ['', 'a..b', 'a.', '1plc', 'a-b', 'a/b', 'a'.repeat(248)]) {
    assert.throws(() => validateJobConfig({ ...jobConfig(), dbusInterfacePrefix: prefix }, options), { code: 'JOB_INVALID' });
  }
  assert.throws(() => validateJobConfig({ ...jobConfig(), dbusDestination: 'high.ls.plc' }, { ...options, allowLsDBusDestination: false }), { code: 'JOB_INVALID' });
  assert.equal(resolveJobDestination(undefined), 'ls.plc');
  assert.equal(resolveJobDestination('other.plc'), 'other.plc');
  assert.equal(resolveJobInterfacePrefix(undefined), 'ls.plc');
});

test('Task Period and Test Call use the selected Job destination', (t) => {
  const root = setupRoot('ls-call-destination-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'interfaces.d'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'products', 'ls', 'interfaces', 'ls-plc-device.json'),
    path.join(root, 'interfaces.d', 'ls-plc-device.json'));
  const seen = [];
  const dbusFactory = () => ({
    connect() {},
    call(config, method) {
      seen.push({ destination: config.destination, interface: method.interface, method: method.methodName });
      return { body: [method.methodName === 'GetTaskCycleInfo'
        ? '{"rtn":1,"period-ms":4}' : '{"rtn":1,"data-count":1,"data":[1]}'] };
    },
    close() {},
  });
  assert.deepEqual(resolveIntervalPolicy({
    settings: {}, productPolicy: { target: 'ls' }, dbusFactory, destination: 'high.ls.plc', interfacePrefix: 'high.ls.plc',
  }), { cycleMs: 4, source: 'plc' });
  assert.deepEqual(resolveIntervalPolicy({
    settings: {}, productPolicy: { target: 'ls' }, dbusFactory, destination: 'high.ls.plc',
  }), { cycleMs: 4, source: 'plc' });
  assert.deepEqual(resolveIntervalPolicy({
    settings: {}, productPolicy: { target: 'ls' }, dbusFactory, destination: 'ls.plc', interfacePrefix: 'vendor_plc3',
  }), { cycleMs: 4, source: 'plc' });
  assert.deepEqual(resolveIntervalPolicy({
    settings: {}, productPolicy: { target: 'ls' }, dbusFactory, destination: 'vendor-test.plc3', interfacePrefix: 'ls.plc',
  }), { cycleMs: 4, source: 'plc' });
  const manager = new TestCallManager({ cgiRoot: root, dbusFactory });
  let failure;
  manager.call({ interfaceId: 'ls-plc-device', methodId: 'get-device-data',
    inputs: { DataCount: 1, DeviceString: '%MB0' }, dbusDestination: 'high.ls.plc', dbusInterfacePrefix: 'high.ls.plc',
  }, (error) => { failure = error; });
  assert.equal(failure, null);
  manager.call({ interfaceId: 'ls-plc-device', methodId: 'get-device-data',
    inputs: { DataCount: 1, DeviceString: '%MB0' }, dbusDestination: 'high.ls.plc',
  }, (error) => { failure = error; });
  assert.equal(failure, null);
  manager.call({ interfaceId: 'ls-plc-device', methodId: 'get-device-data',
    inputs: { DataCount: 1, DeviceString: '%MB0' }, dbusDestination: 'ls.plc', dbusInterfacePrefix: 'vendor_plc3',
  }, (error) => { failure = error; });
  assert.equal(failure, null);
  manager.call({ interfaceId: 'ls-plc-device', methodId: 'get-device-data',
    inputs: { DataCount: 1, DeviceString: '%MB0' }, dbusDestination: 'vendor-test.plc3', dbusInterfacePrefix: 'ls.plc',
  }, (error) => { failure = error; });
  assert.equal(failure, null);
  assert.deepEqual(seen.map((call) => call.destination), [
    'high.ls.plc', 'high.ls.plc', 'ls.plc', 'vendor-test.plc3',
    'high.ls.plc', 'high.ls.plc', 'ls.plc', 'vendor-test.plc3',
  ]);
  assert.deepEqual(seen.map((call) => call.interface), [
    'high.ls.plc.program', 'ls.plc.program', 'vendor_plc3.program', 'ls.plc.program',
    'high.ls.plc.device', 'ls.plc.device', 'vendor_plc3.device', 'ls.plc.device',
  ]);
  assert.deepEqual(seen.map((call) => call.method), [
    'GetTaskCycleInfo', 'GetTaskCycleInfo', 'GetTaskCycleInfo', 'GetTaskCycleInfo',
    'GetDeviceData', 'GetDeviceData', 'GetDeviceData', 'GetDeviceData',
  ]);
});
