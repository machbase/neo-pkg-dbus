'use strict';

const assert = require('node:assert/strict');
const profile = require('../profiles.d/ls-electric-plc.json');
const { jobConfig, methodCall } = require('./job-fixture.cjs');
const { createDbusAdapter } = require('../src/dbus/adapter.js');
const { calculateNextDelay, createScheduler } = require('../src/collector/scheduler.js');
const { runCycle, sanitizeLastRun } = require('../src/collector/cycle.js');
const { createServiceDetailsAdapter } = require('../src/service/details-adapter.js');

function response(values, overrides) {
  return { body: [JSON.stringify({ rtn: 1, 'data-count': values.length, data: values, ...(overrides || {}) })] };
}

function cycleContext(overrides) {
  const appends = [];
  const calls = [];
  const instants = [
    new Date('2026-08-03T00:00:00.000Z'), new Date('2026-08-03T00:00:00.100Z'),
    new Date('2026-08-03T00:00:00.200Z'), new Date('2026-08-03T00:00:00.300Z'),
  ];
  let instant = 0;
  const context = {
    job: { name: 'alpha', ...jobConfig() },
    profile,
    limits: { maxBufferedRowsPerCycle: 10000 },
    dbus: {
      call(dbus, method, args) {
        calls.push({ dbus, method, args });
        return response([10, 20]);
      },
    },
    database: { append(rows) { appends.push(rows.slice()); } },
    now() { return instants[Math.min(instant++, instants.length - 1)]; },
    previous: null,
    ...overrides,
  };
  return { context, calls, appends };
}

function testPerMethodPartialAndOrdering() {
  const second = methodCall({
    id: 'read-plc-data-2', name: 'Read PLC Data - Call 2',
    inputs: { dataCount: 1, memoryAddress: '%MB9' },
    tags: [{ outputIndex: 0, sourceAddress: '%MB9', name: '%MB9', bias: 2, multiplier: 3, calcOrder: 'mb' }],
  });
  const setup = cycleContext();
  setup.context.job = { ...setup.context.job, methodCalls: [methodCall(), second] };
  setup.context.dbus.call = (dbus, method, args) => {
    setup.calls.push({ dbus, method, args });
    if (setup.calls.length === 1) return response([10, 'READY']);
    return response([1], { rtn: 0 });
  };
  const result = runCycle(setup.context);
  assert.equal(result.status, 'partial');
  assert.equal(result.methodCalls.length, 2);
  assert.equal(result.methodCalls[0].storedCount, 2);
  assert.equal(result.methodCalls[1].status, 'failed');
  assert.equal(setup.appends.length, 1);
  assert.deepEqual(setup.appends[0].map((row) => [row.name, row.value]), [['%MB3', 10], ['%MB4', 'READY']]);
  assert.equal(setup.appends[0][1].stringValue, 'READY');
  assert.equal(setup.appends[0][0].requestTime, setup.appends[0][1].requestTime, '한 Method의 모든 행은 같은 requestTime이어야 합니다.');
  assert.deepEqual(setup.calls.map((call) => `${call.method.interface}.${call.method.methodName}`), [
    'ls.plc.device.GetDeviceData', 'ls.plc.device.GetDeviceData',
  ]);
  assert.deepEqual(setup.calls[0].args, ['uint16:2', 'string:%MB3']);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'values'), false);
}

function testObjectOutputIsStoredAsJsonWithoutTransform() {
  const setup = cycleContext();
  setup.context.profile = {
    ...profile,
    methods: [{
      id: 'read-object', displayName: 'Read Object', objectPath: '/object',
      interface: 'example.object', methodName: 'Read', inputs: [],
      output: { decoder: 'raw', shape: 'object' },
    }],
  };
  setup.context.job = {
    ...setup.context.job,
    methodCalls: [methodCall({
      methodId: 'read-object', inputs: {},
      tags: [{
        outputIndex: 0, sourceAddress: 'object', name: 'OBJECT',
        bias: 100, multiplier: 100, calcOrder: 'bm',
      }],
    })],
  };
  setup.context.dbus.call = () => ({ body: [{ ready: true, count: 2 }] });
  assert.equal(runCycle(setup.context).status, 'success');
  assert.deepEqual(setup.appends[0].map((row) => ({
    value: row.value, stringValue: row.stringValue,
  })), [{
    value: '{"ready":true,"count":2}',
    stringValue: '{"ready":true,"count":2}',
  }]);
}

function testAfterAllAtomicBuffer() {
  const second = methodCall({
    id: 'read-plc-data-2', name: 'Read PLC Data - Call 2',
    inputs: { dataCount: 1, memoryAddress: '%MB9' },
    tags: [{ outputIndex: 0, sourceAddress: '%MB9', name: '%MB9', bias: 2, multiplier: 3, calcOrder: 'mb' }],
  });
  const failed = cycleContext();
  failed.context.job = {
    ...failed.context.job,
    execution: { savePolicy: 'afterAllMethods', onMethodError: 'stop' },
    methodCalls: [methodCall(), second],
  };
  failed.context.dbus.call = () => failed.appends.length === 0 && failed.context._called
    ? response([1], { rtn: 0 })
    : (failed.context._called = true, response([10, 20]));
  assert.equal(runCycle(failed.context).status, 'failed');
  assert.equal(failed.appends.length, 0);

  const passed = cycleContext();
  passed.context.job = {
    ...passed.context.job,
    execution: { savePolicy: 'afterAllMethods', onMethodError: 'stop' },
    methodCalls: [methodCall(), second],
  };
  let count = 0;
  passed.context.dbus.call = () => (count++ === 0 ? response([10, 20]) : response([4]));
  const success = runCycle(passed.context);
  assert.equal(success.status, 'success');
  assert.equal(passed.appends.length, 1);
  assert.deepEqual(passed.appends[0].map((row) => [row.name, row.value]), [
    ['%MB3', 10], ['%MB4', 20], ['%MB9', 14],
  ]);
  assert.deepEqual(success.methodCalls.map((method) => method.storedCount), [2, 1]);

  const overflow = cycleContext({ limits: { maxBufferedRowsPerCycle: 1 } });
  overflow.context.job = {
    ...overflow.context.job, execution: { savePolicy: 'afterAllMethods', onMethodError: 'stop' },
  };
  const overflowResult = runCycle(overflow.context);
  assert.equal(overflowResult.status, 'failed');
  assert.equal(overflow.appends.length, 0);
  assert.match(overflowResult.lastError, /buffer/i);
}

function testConnectionReuseAndRecovery() {
  const connections = [];
  let fail = false;
  const dbusModule = {
    Connection: class Connection {
      constructor(options) { this.options = options; this.closed = false; connections.push(this); }
      call(request) { if (fail) throw new Error('dbus disconnected'); return { body: [request.args[0]] }; }
      close() { this.closed = true; }
    },
  };
  const adapter = createDbusAdapter(dbusModule);
  const method = { objectPath: '/x', interface: 'a.b', methodName: 'Read' };
  assert.deepEqual(adapter.call({ busType: 'system', destination: 'a.b' }, method, ['string:first']).body, ['string:first']);
  adapter.call({ busType: 'system', destination: 'a.b' }, method, ['string:second']);
  assert.equal(connections.length, 1, '같은 bus 연결을 다시 써야 합니다.');
  fail = true;
  assert.throws(() => adapter.call({ busType: 'system', destination: 'a.b' }, method, []), /disconnected/);
  assert.equal(connections[0].closed, true, 'DBus 오류 뒤 연결을 닫아야 합니다.');
  fail = false;
  adapter.call({ busType: 'system', destination: 'a.b' }, method, []);
  assert.equal(connections.length, 2, '다음 호출은 새 연결이어야 합니다.');
  adapter.close();
  assert.equal(connections[1].closed, true);
}

function testCycleDoesNotStoreRawDbusError() {
  const setup = cycleContext({
    dbus: { call() { throw new Error('raw body={password:secret}, tag=%MB3'); } },
  });
  const result = runCycle(setup.context);
  assert.equal(result.status, 'failed');
  assert.equal(result.lastError, 'DBus Method 호출에 실패했습니다.');
  assert.equal(result.methodCalls[0].error, 'DBus Method 호출에 실패했습니다.');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('%MB3'), false);
}

function testBackoffAndNoCatchupScheduler() {
  const retry = { initialDelayMs: 5000, maximumDelayMs: 30000, multiplier: 2 };
  assert.deepEqual([1, 2, 3, 4, 5].map((failures) => calculateNextDelay(false, failures, 1000, retry)), [
    5000, 10000, 20000, 30000, 30000,
  ]);
  assert.equal(calculateNextDelay(true, 0, 2500, retry), 2500);
  assert.equal(calculateNextDelay(false, 3, 1000, {
    initialDelayMs: 7, maximumDelayMs: 20, multiplier: 3,
  }), 20);

  const scheduled = [];
  const completed = [];
  let runs = 0;
  const scheduler = createScheduler({
    intervalMs: 1000,
    retry,
    run() { runs += 1; completed.push(runs); return { status: runs === 1 ? 'failed' : 'success' }; },
    setTimer(callback, delay) { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimer() {},
  });
  scheduler.start();
  assert.equal(runs, 1);
  assert.equal(scheduled[0].delay, 5000, '실행이 끝난 뒤 다음 한 번만 예약해야 합니다.');
  scheduled.shift().callback();
  assert.equal(runs, 2);
  assert.equal(scheduled[0].delay, 1000);
  assert.deepEqual(completed, [1, 2]);
  scheduler.stop();
}

function testLastRunWhitelistAndDetailsAdapter() {
  const safe = sanitizeLastRun({
    startedAt: 'a', completedAt: 'b', status: 'success', profileId: 'p', profileVersion: 1,
    methodCalls: [{ id: 'c', name: 'Call', requestedAt: 'a', completedAt: 'b', status: 'success', storedCount: 1,
      error: null, body: 'secret', values: [99], tags: [{ name: 'secret' }] }],
    lastRunAt: 'b', lastSuccessfulRunAt: 'b', lastStoredAt: 'b', lastError: null,
    body: 'secret', values: [99], tags: [{ name: 'secret' }], rawConfig: { password: 'secret' },
  });
  assert.deepEqual(Object.keys(safe).sort(), [
    'completedAt', 'lastError', 'lastRunAt', 'lastStoredAt', 'lastSuccessfulRunAt',
    'methodCalls', 'profileId', 'profileVersion', 'startedAt', 'status',
  ]);
  assert.deepEqual(Object.keys(safe.methodCalls[0]).sort(), [
    'completedAt', 'error', 'id', 'name', 'requestedAt', 'status', 'storedCount',
  ]);

  const writes = [];
  const serviceModule = {
    Client: class Client {
      constructor() { this.details = { set(name, key, value, callback) { writes.push({ name, key, value }); callback(null); } }; }
    },
  };
  const details = createServiceDetailsAdapter(serviceModule, '_dbu_alpha');
  let callbackError = 'not-called';
  details.setLastRun({ ...safe, body: 'must disappear' }, (error) => { callbackError = error; });
  assert.equal(callbackError, null);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, '_dbu_alpha');
  assert.equal(writes[0].key, 'lastRun');
  assert.equal(Object.prototype.hasOwnProperty.call(writes[0].value, 'body'), false);
}

testPerMethodPartialAndOrdering();
testObjectOutputIsStoredAsJsonWithoutTransform();
testAfterAllAtomicBuffer();
testConnectionReuseAndRecovery();
testCycleDoesNotStoreRawDbusError();
testBackoffAndNoCatchupScheduler();
testLastRunWhitelistAndDetailsAdapter();
console.log('Collector runtime: ok');
