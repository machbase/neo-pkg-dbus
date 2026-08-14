'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { InterfaceManager } = require('../src/interfaces/manager.js');
const { JobManager } = require('../src/jobs/manager.js');
const { call, jobConfig, setupRoot, writeJson } = require('./job-fixture.cjs');

function database() { return { validate(_value, callback) { callback(null, {}); } }; }

function service() {
  const states = new Map([['_dbu_alpha', { status: 'STOPPED' }]]);
  const calls = [];
  let pendingStart = null;
  let resolveStartStarted;
  const startStarted = new Promise((resolve) => { resolveStartStarted = resolve; });
  class Client {
    status(name, callback) { callback(null, states.get(name)); }
    start(name, callback) {
      calls.push(['start', name]);
      pendingStart = { name, callback };
      resolveStartStarted();
    }
  }
  return {
    Client,
    calls,
    direct: { status(name, callback) { new Client().status(name, callback); } },
    waitStart() { return startStarted; },
    finishStart() {
      states.set(pendingStart.name, { status: 'RUNNING' });
      pendingStart.callback(null, { status: 'RUNNING' });
      pendingStart = null;
    },
  };
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (failure) => failure && failure.code === code);
}

async function testInterfacePutHoldsReferencedJobLockAgainstStart() {
  const root = setupRoot('neo-interface-job-put-start-race-');
  try {
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
      ...jobConfig(), name: 'alpha', revision: 1,
    });
    const runtime = service();
    const interfaces = new InterfaceManager({ cgiRoot: root });
    const jobs = new JobManager({
      cgiRoot: root, serviceModule: runtime, databaseAdapter: database(),
    });
    const current = interfaces.store.find('device-status');
    let racedStart;
    const jobLock = interfaces.jobLock;
    interfaces.jobLock = {
      acquire(name) {
        racedStart = call(jobs, 'start', name);
        return jobLock.acquire(name);
      },
    };

    await rejectsCode(call(interfaces, 'updateInterface', {
      ...current, interface: 'ls.plc.device.updated',
    }), 'DBUS_INTERFACE_IN_USE');
    await rejectsCode(racedStart, 'JOB_CONFLICT');
    assert.deepEqual(runtime.calls, [], 'Interface 저장 중 Job Controller start는 실행하면 안 됩니다.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testJobStartReaderBlocksInterfacePut() {
  const root = setupRoot('neo-interface-job-start-put-race-');
  try {
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
      ...jobConfig(), name: 'alpha', revision: 1,
    });
    const runtime = service();
    const interfaces = new InterfaceManager({ cgiRoot: root });
    const jobs = new JobManager({
      cgiRoot: root, serviceModule: runtime, databaseAdapter: database(),
    });
    const current = interfaces.store.find('device-status');
    const starting = call(jobs, 'start', 'alpha');
    await runtime.waitStart();

    await rejectsCode(call(interfaces, 'updateInterface', {
      ...current, interface: 'ls.plc.device.raced',
    }), 'JOB_CONFLICT');
    assert.equal(interfaces.store.find('device-status').interface, current.interface);
    runtime.finishStart();
    await starting;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  await testInterfacePutHoldsReferencedJobLockAgainstStart();
  await testJobStartReaderBlocksInterfacePut();
  console.log('Interface/Job mutation race: ok');
}

run().catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
