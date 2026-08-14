'use strict';

const assert = require('node:assert/strict');
const { jobConfig, methodCall } = require('./job-fixture.cjs');
const { createDbusAdapter } = require('../src/dbus/adapter.js');
const { calculateNextDelay, createScheduler } = require('../src/collector/scheduler.js');
const { runCycle, sanitizeLastRun } = require('../src/collector/cycle.js');
const { createServiceDetailsAdapter } = require('../src/service/details-adapter.js');
const { transformValue } = require('../src/tag/transform.js');

function response(values) {
  return { body: [values] };
}

function selectionCall(overrides) {
  const call = methodCall(overrides);
  const tags = call.tags;
  delete call.tags;
  call.outputSelections = [{ id: 'output-1', sourceIndex: 0, path: '', mode: 'each', tags }];
  return call;
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
    job: { name: 'alpha', ...jobConfig({ methodCalls: [selectionCall()] }) },
    interfaceStore: {
      find(id) {
        if (id !== 'device-status') return null;
        return {
          id, busType: 'system', destination: 'ls.plc', objectPath: '/ls/plc/device', interface: 'ls.plc.device',
          methods: [{ id: 'get-device-data', member: 'GetDeviceData', inputs: [{ name: 'dataCount', type: 'uint16' }, { name: 'memoryAddress', type: 'string' }], outputs: [] }],
        };
      },
    },
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
  assert.equal(transformValue(3, { bias: 2, multiplier: 4 }), 20);
  assert.equal(transformValue('READY', { bias: 2, multiplier: 4 }), 'READY');
  const second = selectionCall({
    id: 'read-plc-data-2', name: 'Read PLC Data - Call 2',
    inputs: { dataCount: 1, memoryAddress: '%MB9' },
    tags: [{ outputIndex: 0, sourceAddress: '%MB9', name: '%MB9', bias: 2, multiplier: 3, calcOrder: 'mb' }],
  });
  const setup = cycleContext();
  setup.context.job = { ...setup.context.job, methodCalls: [selectionCall(), second] };
  setup.context.dbus.call = (dbus, method, args) => {
    setup.calls.push({ dbus, method, args });
    if (setup.calls.length === 1) return response([10, 'READY']);
    throw new Error('second method failed');
  };
  const result = runCycle(setup.context);
  assert.equal(result.status, 'partial');
  assert.equal(result.methodCalls.length, 2);
  assert.equal(result.methodCalls[0].storedCount, 2);
  assert.equal(result.methodCalls[1].status, 'failed');
  assert.equal(setup.appends.length, 1);
  assert.equal(Object.hasOwn(setup.appends[0][0], 'sourceAddress'), false);
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

function testLegacyCallTagsKeepsBooleanOutputAndSucceeds() {
  const setup = cycleContext();
  const legacyCall = methodCall({
    id: 'read-boolean', name: 'Read boolean',
    tags: [{ name: 'BOOLEAN', bias: 100, multiplier: 100 }],
  });
  setup.context.job = { ...setup.context.job, methodCalls: [legacyCall] };
  setup.context.dbus.call = () => ({ body: [true] });

  const result = runCycle(setup.context);

  assert.equal(result.status, 'success');
  assert.deepEqual(setup.appends, [[{
    name: 'BOOLEAN', requestTime: new Date('2026-08-03T00:00:00.100Z'), value: true, stringValue: null,
  }]]);
}

function testLegacySelectionKeepsObjectOutputWithoutTransform() {
  const setup = cycleContext();
  setup.context.interfaceStore = { find() { return {
    id: 'device-status', busType: 'system', destination: 'object.device', objectPath: '/object', interface: 'example.object',
    methods: [{ id: 'read-object', member: 'Read', inputs: [], outputs: [{ name: 'value', type: 'string' }] }],
  }; } };
  setup.context.job = {
    ...setup.context.job,
    methodCalls: [selectionCall({
      methodId: 'read-object', inputs: {},
      tags: [{
        outputIndex: 0, sourceAddress: 'object', name: 'OBJECT',
        bias: 100, multiplier: 100, calcOrder: 'bm',
      }],
    })],
  };
  setup.context.job.methodCalls[0].outputSelections[0].mode = 'single';
  setup.context.dbus.call = () => ({ body: [{ ready: true, count: 2 }] });
  assert.equal(runCycle(setup.context).status, 'success');
  assert.deepEqual(setup.appends[0].map((row) => ({
    value: row.value, stringValue: row.stringValue,
  })), [{
    value: { ready: true, count: 2 },
    stringValue: null,
  }]);
}

function testOutputSelectionTransformsOnlyNumericValues() {
  const setup = cycleContext();
  setup.context.interfaceStore = { find() { return {
    id: 'device-status', busType: 'system', destination: 'typed.device', objectPath: '/typed', interface: 'example.typed',
    methods: [{
      id: 'read-typed', member: 'Read', inputs: [], outputs: [
        { name: 'numeric', type: 'double' },
        { name: 'string', type: 'string' },
        { name: 'boolean', type: 'boolean' },
        { name: 'complex', type: { type: 'struct', fields: ['boolean', 'string'] } },
        { name: 'jsonNumber', type: 'string' },
      ],
    }],
  }; } };
  const tag = (name) => ({ name, bias: 3, multiplier: 4 });
  setup.context.job = {
    ...setup.context.job,
    methodCalls: [{
      id: 'read-typed', name: 'Read typed', interfaceId: 'device-status', methodId: 'read-typed', inputs: {},
      outputSelections: [
        { id: 'numeric', sourceIndex: 0, interpretation: 'native', tags: [tag('NUMERIC')] },
        { id: 'string', sourceIndex: 1, interpretation: 'native', tags: [tag('STRING')] },
        { id: 'boolean', sourceIndex: 2, interpretation: 'native', tags: [tag('BOOLEAN')] },
        { id: 'complex', sourceIndex: 3, interpretation: 'native', selector: '', valueType: 'json', tags: [tag('COMPLEX')] },
        { id: 'json-number', sourceIndex: 4, interpretation: 'json', selector: '/reading', valueType: 'json', tags: [tag('JSON_NUMBER')] },
      ],
    }],
  };
  setup.context.dbus.call = () => ({ body: [2, 'READY', true, { ready: true }, '{"reading":2}'] });

  assert.equal(runCycle(setup.context).status, 'success');
  assert.deepEqual(setup.appends[0].map(({ name, value, stringValue }) => ({ name, value, stringValue })), [
    { name: 'NUMERIC', value: 20, stringValue: null },
    { name: 'STRING', value: 0, stringValue: 'READY' },
    { name: 'BOOLEAN', value: 0, stringValue: 'true' },
    { name: 'COMPLEX', value: 0, stringValue: '{"ready":true}' },
    { name: 'JSON_NUMBER', value: 0, stringValue: '2' },
  ]);
}

function testStringRowsWithoutColumnAreSkippedFromStoredCount() {
  const setup = cycleContext();
  setup.context.interfaceStore = { find() { return {
    id: 'device-status', busType: 'system', destination: 'typed.device', objectPath: '/typed', interface: 'example.typed',
    methods: [{
      id: 'read-typed', member: 'Read', inputs: [], outputs: [
        { name: 'numeric', type: 'double' },
        { name: 'string', type: 'string' },
      ],
    }],
  }; } };
  setup.context.job = {
    ...setup.context.job,
    database: { ...setup.context.job.database, stringValueColumn: '' },
    methodCalls: [{
      id: 'read-typed', name: 'Read typed', interfaceId: 'device-status', methodId: 'read-typed', inputs: {},
      outputSelections: [
        { id: 'numeric', sourceIndex: 0, interpretation: 'native', tags: [{ name: 'NUM', bias: 0, multiplier: 1 }] },
        { id: 'string', sourceIndex: 1, interpretation: 'native', tags: [{ name: 'TEXT', bias: 0, multiplier: 1 }] },
      ],
    }],
  };
  setup.context.dbus.call = () => ({ body: [7, 'READY'] });
  const mixed = runCycle(setup.context);
  assert.equal(mixed.status, 'success');
  assert.equal(mixed.methodCalls[0].storedCount, 1);
  assert.deepEqual(setup.appends[0].map((row) => row.name), ['NUM']);

  const stringOnly = cycleContext({
    previous: { lastStoredAt: '2026-08-02T00:00:00.000Z' },
  });
  stringOnly.context.interfaceStore = setup.context.interfaceStore;
  stringOnly.context.job = {
    ...setup.context.job,
    methodCalls: [{
      ...setup.context.job.methodCalls[0],
      outputSelections: [setup.context.job.methodCalls[0].outputSelections[1]],
    }],
  };
  stringOnly.context.dbus.call = () => ({ body: [7, 'READY'] });
  const skipped = runCycle(stringOnly.context);
  assert.equal(skipped.status, 'success');
  assert.equal(skipped.methodCalls[0].storedCount, 0);
  assert.equal(skipped.lastStoredAt, '2026-08-02T00:00:00.000Z');
  assert.deepEqual(stringOnly.appends, [], '저장할 행이 없으면 append를 호출하지 않습니다.');
}

function testAfterAllAtomicBuffer() {
  const second = selectionCall({
    id: 'read-plc-data-2', name: 'Read PLC Data - Call 2',
    inputs: { dataCount: 1, memoryAddress: '%MB9' },
    tags: [{ outputIndex: 0, sourceAddress: '%MB9', name: '%MB9', bias: 2, multiplier: 3, calcOrder: 'mb' }],
  });
  const failed = cycleContext();
  failed.context.job = {
    ...failed.context.job,
    execution: { savePolicy: 'afterAllMethods', onMethodError: 'stop' },
    methodCalls: [selectionCall(), second],
  };
  failed.context.dbus.call = () => {
    if (failed.context._called) throw new Error('second method failed');
    failed.context._called = true;
    return response([10, 20]);
  };
  assert.equal(runCycle(failed.context).status, 'failed');
  assert.equal(failed.appends.length, 0);

  const passed = cycleContext();
  passed.context.job = {
    ...passed.context.job,
    execution: { savePolicy: 'afterAllMethods', onMethodError: 'stop' },
    methodCalls: [selectionCall(), second],
  };
  let count = 0;
  passed.context.dbus.call = () => (count++ === 0 ? response([10, 20]) : response([4]));
  const success = runCycle(passed.context);
  assert.equal(success.status, 'success');
  assert.equal(passed.appends.length, 1);
  assert.deepEqual(passed.appends[0].map((row) => [row.name, row.value]), [
    ['%MB3', 10], ['%MB4', 20], ['%MB9', 18],
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
  adapter.call({ busType: 'system', destination: 'other.b' }, method, ['string:third']);
  assert.equal(connections.length, 2, '다른 destination은 별도 연결이어야 합니다.');
  fail = true;
  assert.throws(() => adapter.call({ busType: 'system', destination: 'a.b' }, method, []), /disconnected/);
  assert.equal(connections[1].closed, true, 'DBus 오류 뒤 연결을 닫아야 합니다.');
  fail = false;
  adapter.call({ busType: 'system', destination: 'a.b' }, method, []);
  assert.equal(connections.length, 4, '다음 호출은 새 연결이어야 합니다.');
  adapter.close();
  assert.equal(connections[3].closed, true);
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

function testCycleDoesNotCallNeoForUnsupportedStandardType() {
  const setup = cycleContext();
  setup.context.interfaceStore = { find() { return {
    id: 'device-status', busType: 'system', destination: 'example.device', objectPath: '/example/device', interface: 'example.device.Status',
    methods: [{ id: 'set-properties', member: 'SetProperties', inputs: [{ name: 'properties', type: { type: 'array', element: { type: 'dict-entry', key: 'string', value: 'variant' } } }], outputs: [] }],
  }; } };
  setup.context.job = {
    ...setup.context.job,
    methodCalls: [selectionCall({ methodId: 'set-properties', inputs: { properties: [{ key: 'mode', value: { type: 'string', value: 'auto' } }] }, tags: [] })],
  };
  const result = runCycle(setup.context);
  assert.equal(result.status, 'failed');
  assert.match(result.methodCalls[0].error, /지원하지 않습니다/);
  assert.equal(setup.calls.length, 0);
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
    startedAt: 'a', completedAt: 'b', status: 'success',
    methodCalls: [{ id: 'c', name: 'Call', requestedAt: 'a', completedAt: 'b', status: 'success', storedCount: 1,
      interfaceId: 'device-status', methodId: 'read', error: null, body: 'secret', values: [99], tags: [{ name: 'secret' }] }],
    lastRunAt: 'b', lastSuccessfulRunAt: 'b', lastStoredAt: 'b', lastError: null,
    body: 'secret', values: [99], tags: [{ name: 'secret' }], rawConfig: { password: 'secret' },
  });
  assert.deepEqual(Object.keys(safe).sort(), [
    'completedAt', 'lastError', 'lastRunAt', 'lastStoredAt', 'lastSuccessfulRunAt',
    'methodCalls', 'startedAt', 'status',
  ]);
  assert.deepEqual(Object.keys(safe.methodCalls[0]).sort(), [
    'completedAt', 'error', 'id', 'interfaceId', 'methodId', 'name', 'requestedAt', 'status', 'storedCount',
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
testLegacyCallTagsKeepsBooleanOutputAndSucceeds();
testLegacySelectionKeepsObjectOutputWithoutTransform();
testOutputSelectionTransformsOnlyNumericValues();
testStringRowsWithoutColumnAreSkippedFromStoredCount();
testAfterAllAtomicBuffer();
testConnectionReuseAndRecovery();
testCycleDoesNotStoreRawDbusError();
testCycleDoesNotCallNeoForUnsupportedStandardType();
testBackoffAndNoCatchupScheduler();
testLastRunWhitelistAndDetailsAdapter();
console.log('Collector runtime: ok');
