'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { jobConfig, setupRoot, writeJson } = require('./job-fixture.cjs');
const { createLifecycle } = require('../../scripts/lifecycle.js');
const { loadCollectorEntry, runCollectorEntry } = require('../neo-collector.js');

function lifecycleManager(initial) {
  const states = new Map(Object.entries(initial));
  const calls = [];
  const snapshot = (name) => ({ name, statusKnown: states.get(name).statusKnown !== false, ...states.get(name) });
  return {
    calls,
    list(callback) { callback(null, [...states.keys()].sort().map(snapshot)); },
    install(name, callback) {
      calls.push(['install', name]);
      states.set(name, { configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED' });
      callback(null, snapshot(name));
    },
    start(name, callback) {
      calls.push(['start', name]);
      states.set(name, { configState: 'installed', executionState: 'running', controllerState: 'RUNNING' });
      callback(null, snapshot(name));
    },
    stop(name, callback) {
      calls.push(['stop', name]);
      states.set(name, { configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED' });
      callback(null, snapshot(name));
    },
    stopForPackage(name, callback) {
      calls.push(['stopForPackage', name]);
      const current = states.get(name);
      if (['RUNNING', 'STARTING', 'STOPPING'].includes(current.controllerState)) {
        states.set(name, {
          ...current, configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED', statusKnown: true,
        });
      }
      callback(null, snapshot(name));
    },
    delete(name, callback) {
      calls.push(['delete', name]);
      states.delete(name);
      callback(null, { name });
    },
  };
}

function invoke(action) {
  return new Promise((resolve, reject) => action((error, value) => (error ? reject(error) : resolve(value))));
}

async function testPackageStopPreservesJobConflict(root) {
  const manager = lifecycleManager({
    running: { configState: 'installed', executionState: 'running', controllerState: 'RUNNING' },
    stopped: { configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED' },
  });
  const normalStop = manager.stopForPackage.bind(manager);
  manager.stopForPackage = (name, callback) => {
    if (name !== 'stopped') { normalStop(name, callback); return; }
    manager.calls.push(['stopForPackage', name]);
    callback(Object.assign(new Error('same Job mutation is pending'), {
      code: 'JOB_CONFLICT', details: { name },
    }));
  };
  const statePath = path.join(root, 'data', 'conflict-state.json');
  const lifecycle = createLifecycle(manager, statePath, { print() {} });
  await assert.rejects(invoke(lifecycle.stop), (failure) => {
    assert.equal(failure.code, 'PACKAGE_LIFECYCLE_FAILED');
    assert.deepEqual(failure.details.errors, [{
      name: 'stopped', code: 'JOB_CONFLICT', reason: 'same Job mutation is pending', details: { name: 'stopped' },
    }]);
    return true;
  });
  assert.deepEqual(manager.calls, [
    ['stopForPackage', 'running'], ['stopForPackage', 'stopped'],
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).names, ['running']);
}

async function testUninstallPreservesJobConflicts(root) {
  const stopConflictManager = lifecycleManager({
    running: { configState: 'installed', executionState: 'running', controllerState: 'RUNNING' },
  });
  stopConflictManager.stopForPackage = (name, callback) => {
    stopConflictManager.calls.push(['stopForPackage', name]);
    callback(Object.assign(new Error('start owns lock'), { code: 'JOB_CONFLICT', details: { name } }));
  };
  const stopConflict = createLifecycle(
    stopConflictManager, path.join(root, 'data', 'uninstall-stop-conflict.json'), { print() {} },
  );
  await assert.rejects(invoke(stopConflict.uninstall), (failure) => {
    assert.equal(failure.code, 'PACKAGE_LIFECYCLE_FAILED');
    assert.equal(failure.details.errors[0].code, 'JOB_CONFLICT');
    return true;
  });
  assert.equal(stopConflictManager.calls.some(([method]) => method === 'delete'), false);

  const deleteConflictManager = lifecycleManager({
    stopped: { configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED' },
  });
  deleteConflictManager.delete = (name, callback) => {
    deleteConflictManager.calls.push(['delete', name]);
    callback(Object.assign(new Error('create owns lock'), { code: 'JOB_CONFLICT', details: { name } }));
  };
  const deleteConflict = createLifecycle(
    deleteConflictManager, path.join(root, 'data', 'uninstall-delete-conflict.json'), { print() {} },
  );
  await assert.rejects(invoke(deleteConflict.uninstall), (failure) => {
    assert.equal(failure.code, 'PACKAGE_LIFECYCLE_FAILED');
    assert.equal(failure.details.errors[0].code, 'JOB_CONFLICT');
    return true;
  });
}

async function testLifecycleAcquireConflictAggregatesAndRecovers(root) {
  const manager = lifecycleManager({
    alpha: { configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED' },
    beta: { configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED' },
  });
  const stopForPackage = manager.stopForPackage.bind(manager);
  const deleteJob = manager.delete.bind(manager);
  const listJobs = manager.list.bind(manager);
  let attempts = 0;
  let releases = 0;
  let fenceHeld = false;
  manager.list = (callback) => {
    assert.equal(fenceHeld, true, 'package lifecycle fence는 목록 조회 전에 잡아야 합니다.');
    listJobs(callback);
  };
  manager.acquirePackageLifecycle = () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('beta mutation is pending'), {
        code: 'JOB_CONFLICT', details: { name: 'beta' },
      });
    }
    fenceHeld = true;
    return {
      acquire() {},
      stopForPackage,
      delete: deleteJob,
      release() { releases += 1; fenceHeld = false; },
    };
  };
  const statePath = path.join(root, 'data', 'lifecycle-acquire-conflict.json');
  const lifecycle = createLifecycle(manager, statePath, { print() {} });
  let callbackCalls = 0;
  await new Promise((resolve) => lifecycle.stop((failure) => {
    callbackCalls += 1;
    assert.equal(failure.code, 'PACKAGE_LIFECYCLE_FAILED');
    assert.deepEqual(failure.details.errors, [{
      name: 'beta', code: 'JOB_CONFLICT', reason: 'beta mutation is pending', details: { name: 'beta' },
    }]);
    resolve();
  }));
  assert.equal(callbackCalls, 1);
  assert.equal(manager.calls.length, 0);
  assert.equal(fs.existsSync(statePath), false);

  assert.deepEqual(await invoke(lifecycle.stop), ['alpha', 'beta']);
  assert.deepEqual(manager.calls, [['stopForPackage', 'alpha'], ['stopForPackage', 'beta']]);
  assert.equal(releases, 1);
  assert.equal(fenceHeld, false);
}

async function testLifecycleReleaseFailurePreservesOperationError(root) {
  const manager = lifecycleManager({
    alpha: { configState: 'installed', executionState: 'running', controllerState: 'RUNNING' },
  });
  const operationFailure = Object.assign(new Error('alpha mutation is pending'), {
    code: 'JOB_CONFLICT', details: { name: 'alpha' },
  });
  const cleanupFailure = Object.assign(new Error('session release failed'), {
    code: 'LOCK_RELEASE_FAILED',
  });
  let callbackCalls = 0;
  let releaseCalls = 0;
  manager.acquirePackageLifecycle = () => ({
    acquire() {},
    stopForPackage(_name, callback) { callback(operationFailure); },
    delete: manager.delete.bind(manager),
    release() { releaseCalls += 1; throw cleanupFailure; },
  });
  const lifecycle = createLifecycle(
    manager, path.join(root, 'data', 'lifecycle-release-failure.json'), { print() {} },
  );

  await new Promise((resolve) => lifecycle.stop((failure) => {
    callbackCalls += 1;
    assert.equal(failure.code, 'PACKAGE_LIFECYCLE_FAILED');
    assert.strictEqual(failure.cleanupError, cleanupFailure);
    resolve();
  }));
  assert.equal(callbackCalls, 1);
  assert.equal(releaseCalls, 1);
}

async function run() {
  const root = setupRoot('neo-job-scripts-');
  try {
    await testUninstallPreservesJobConflicts(root);
    await testPackageStopPreservesJobConflict(root);
    await testLifecycleAcquireConflictAggregatesAndRecovers(root);
    await testLifecycleReleaseFailurePreservesOperationError(root);
    const statePath = path.join(root, 'data', 'package-stop-state.json');
    const manager = lifecycleManager({
      config: { configState: 'config-only', executionState: 'stopped', controllerState: 'NOT_INSTALLED' },
      stopped: { configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED' },
      running: { configState: 'installed', executionState: 'running', controllerState: 'RUNNING' },
      starting: { configState: 'installed', executionState: 'running', controllerState: 'STARTING' },
      stopping: { configState: 'installed', executionState: 'running', controllerState: 'STOPPING' },
    });
    const lifecycle = createLifecycle(manager, statePath, { print() {} });
    assert.deepEqual(await invoke(lifecycle.install), ['config']);
    assert.deepEqual(manager.calls, [['install', 'config']]);

    assert.deepEqual(await invoke(lifecycle.stop), ['config', 'running', 'starting', 'stopped', 'stopping']);
    assert.deepEqual(manager.calls.slice(1), [
      ['stopForPackage', 'config'],
      ['stopForPackage', 'running'],
      ['stopForPackage', 'starting'],
      ['stopForPackage', 'stopped'],
      ['stopForPackage', 'stopping'],
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).names, ['running', 'starting', 'stopping']);
    assert.deepEqual(await invoke(lifecycle.start), ['running', 'starting', 'stopping']);
    assert.equal(fs.existsSync(statePath), false);

    assert.deepEqual(await invoke(lifecycle.uninstall), ['config', 'running', 'starting', 'stopped', 'stopping']);
    assert.deepEqual(await new Promise((resolve, reject) => manager.list((failure, jobs) => (
      failure ? reject(failure) : resolve(jobs)
    ))), [], '성공한 package uninstall 뒤에는 설정이 다시 생기면 안 됩니다.');

    const unsafeManager = lifecycleManager({
      active: { configState: 'installed', executionState: 'running', controllerState: 'RUNNING', statusKnown: true },
      unknown: { configState: null, executionState: null, controllerState: 'UNKNOWN', statusKnown: false,
        controllerError: { code: 'CONTROLLER_UNKNOWN', reason: 'unknown state', details: {} } },
      rpc: { configState: null, executionState: null, controllerState: 'UNKNOWN', statusKnown: false,
        controllerError: { code: 'CONTROLLER_UNAVAILABLE', reason: 'RPC failed', details: {} } },
    });
    const unsafeLifecycle = createLifecycle(unsafeManager, path.join(root, 'data', 'unsafe-state.json'), { print() {} });
    await assert.rejects(invoke(unsafeLifecycle.stop), (failure) => {
      assert.equal(failure.code, 'PACKAGE_LIFECYCLE_FAILED');
      assert.equal(failure.details.errors.length, 2);
      return true;
    });
    assert.equal(unsafeManager.calls.some(([method, name]) => method === 'stopForPackage' && name === 'active'), true);

    writeJson(path.join(root, 'conf.d', 'jobs', 'collector-job.json'), {
      ...jobConfig(), name: 'collector-job',
    });
    let received = null;
    const result = runCollectorEntry(['collector-job.json'], {
      cgiRoot: root,
      loadEntry() {
        return {
          startCollector(document, context) {
            received = { document, context };
            return 'started';
          },
        };
      },
    });
    assert.equal(result, 'started');
    assert.equal(received.document.name, 'collector-job');
    assert.equal(received.context.configPath, path.join(root, 'conf.d', 'jobs', 'collector-job.json'));
    assert.throws(() => runCollectorEntry(['UPPER.json'], { cgiRoot: root, loadEntry() {} }), /파일 이름/);
    assert.throws(() => runCollectorEntry(['../escape.json'], { cgiRoot: root, loadEntry() {} }), /파일 이름/);
    assert.equal(typeof loadCollectorEntry().startCollector, 'function');

    const directSource = fs.readFileSync(path.resolve(__dirname, '..', 'neo-collector.js'), 'utf8');
    let directStarted = null;
    vm.runInNewContext(directSource, {
      require(id) {
        if (id === 'path') return path;
        if (id === 'process') return { argv: ['/neo/jsh', path.join(root, 'neo-collector.js'), 'collector-job.json'] };
        if (id === './src/jobs/repository.js') return { JobRepository: class Repository {
          read(name) { return { ...jobConfig(), name }; }
          file(name) { return path.join(root, 'conf.d', 'jobs', `${name}.json`); }
        } };
        if (id === './src/collector/entry.js') return { startCollector(document, context) { directStarted = { document, context }; } };
        throw new Error(`unexpected require: ${id}`);
      },
    }, { filename: 'neo-collector.js' });
    assert.equal(directStarted.document.name, 'collector-job');
    assert.equal(directStarted.context.jobName, 'collector-job');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('Job lifecycle scripts and collector entry: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
