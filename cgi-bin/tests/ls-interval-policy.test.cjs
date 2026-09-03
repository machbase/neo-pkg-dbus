'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TASK_NUMBER, defaultIntervalMs, resolveIntervalPolicy } = require('../src/ls/interval-policy.js');

const lsPolicy = { target: 'ls' };

function dbusWith(payload) {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() { return closed; },
    factory() {
      return {
        call(config, method, args) {
          calls.push({ config, method, args });
          return { body: [JSON.stringify(payload)] };
        },
        close() { closed = true; },
      };
    },
  };
}

test('LS interval policy reads Main task (TaskNumber=0) period-ms once', () => {
  const fixture = dbusWith({ rtn: 1, 'period-ms': 4.0, 'task-name': 'Main' });
  assert.deepEqual(resolveIntervalPolicy({
    settings: { ls: { interval: { useTaskCycle: true } } }, productPolicy: lsPolicy, dbusFactory: fixture.factory,
  }), { cycleMs: 4, source: 'plc' });
  assert.equal(TASK_NUMBER, 0);
  assert.deepEqual(fixture.calls[0].args, ['uint16:0']);
  assert.equal(fixture.calls[0].method.methodName, 'GetTaskCycleInfo');
  assert.equal(fixture.closed, true);
  assert.equal(defaultIntervalMs(4), 12);
  assert.equal(defaultIntervalMs(3), 12);
  assert.equal(defaultIntervalMs(1), 10);
});

test('disabled, failed, or malformed LS task cycle uses common 1ms policy', () => {
  let called = false;
  assert.deepEqual(resolveIntervalPolicy({
    settings: { ls: { interval: { useTaskCycle: false } } }, productPolicy: lsPolicy,
    dbusFactory: () => { called = true; throw new Error('must not open DBus'); },
  }), { cycleMs: 1, source: 'disabled' });
  assert.equal(called, false);
  const malformed = dbusWith({ rtn: 1, 'period-ms': 0 });
  assert.deepEqual(resolveIntervalPolicy({
    settings: { ls: { interval: { useTaskCycle: true } } }, productPolicy: lsPolicy, dbusFactory: malformed.factory,
  }), { cycleMs: 1, source: 'invalid-response' });
  assert.deepEqual(resolveIntervalPolicy({ settings: {}, productPolicy: lsPolicy, dbusFactory: () => { throw new Error('offline'); } }), {
    cycleMs: 1, source: 'unavailable',
  });
});

test('generic does not query the LS PLC', () => {
  assert.deepEqual(resolveIntervalPolicy({ productPolicy: { target: 'generic' }, dbusFactory: () => { throw new Error('must not open DBus'); } }), {
    cycleMs: 1, source: 'not-ls',
  });
});
