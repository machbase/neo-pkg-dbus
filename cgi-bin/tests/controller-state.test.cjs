'use strict';

const assert = require('node:assert/strict');
const {
  classifyControllerState,
} = require('../src/service/controller-state.js');

function assertState(info, options, expected) {
  assert.deepEqual(classifyControllerState(info, options), expected);
}

function run() {
  assertState(null, { notInstalled: true }, {
    state: 'NOT_INSTALLED',
    known: true,
    running: false,
    startComplete: false,
    activeForStop: false,
    knownInactive: true,
    detail: '',
  });

  assertState({ status: 'RUNNING' }, null, {
    state: 'RUNNING',
    known: true,
    running: true,
    startComplete: true,
    activeForStop: true,
    knownInactive: false,
    detail: '',
  });

  assertState({ status: 'RUNNING', error: '이전 오류' }, null, {
    state: 'RUNNING',
    known: true,
    running: true,
    startComplete: true,
    activeForStop: true,
    knownInactive: false,
    detail: '이전 오류',
  });

  assertState({ state: 'STARTING' }, null, {
    state: 'STARTING',
    known: true,
    running: true,
    startComplete: false,
    activeForStop: true,
    knownInactive: false,
    detail: '',
  });

  assertState({ status: 'STOPPING' }, null, {
    state: 'STOPPING',
    known: true,
    running: false,
    startComplete: false,
    activeForStop: true,
    knownInactive: false,
    detail: '',
  });

  assertState({ status: 'STOPPED', error: '이전 오류' }, null, {
    state: 'STOPPED',
    known: true,
    running: false,
    startComplete: false,
    activeForStop: false,
    knownInactive: true,
    detail: '이전 오류',
  });

  assertState({ status: 'FAILED', config: { start_error: '시작 실패' } }, null, {
    state: 'FAILED',
    known: true,
    running: false,
    startComplete: false,
    activeForStop: false,
    knownInactive: true,
    detail: '시작 실패',
  });

  assertState({ running: true }, null, {
    state: 'RUNNING',
    known: true,
    running: true,
    startComplete: true,
    activeForStop: true,
    knownInactive: false,
    detail: '',
  });

  assertState({ status: 'WAITING', error: '대기 중' }, null, {
    state: 'UNKNOWN',
    known: false,
    running: false,
    startComplete: false,
    activeForStop: false,
    knownInactive: false,
    detail: '대기 중',
  });

  assertState({ running: false }, null, {
    state: 'UNKNOWN',
    known: false,
    running: false,
    startComplete: false,
    activeForStop: false,
    knownInactive: false,
    detail: '',
  });
}

run();
