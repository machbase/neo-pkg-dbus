'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JobManager } = require('../src/jobs/manager.js');
const { createControllerAdapter } = require('../src/service/controller-adapter.js');
const { call, jobConfig, rejectsCode, setupRoot, writeJson } = require('./job-fixture.cjs');
const { createLifecycle } = require('../../scripts/lifecycle.js');

function notInstalled() {
  const failure = new Error('service not found');
  failure.rpcCode = -32004;
  return failure;
}

function fakeServiceModule() {
  const states = new Map();
  const details = new Map();
  const failures = new Map();
  const calls = [];
  let installState = { status: 'STOPPED' };
  let holdNextUninstall = false;
  let pendingUninstall = null;
  let uninstallStarted = null;
  let resolveUninstallStarted = null;
  let holdNextStop = false;
  let pendingStop = null;
  let stopStarted = null;
  let resolveStopStarted = null;
  let stopNameToHold = null;

  function resetUninstallStarted() {
    uninstallStarted = new Promise((resolve) => { resolveUninstallStarted = resolve; });
  }

  function resetStopStarted() {
    stopStarted = new Promise((resolve) => { resolveStopStarted = resolve; });
  }

  resetUninstallStarted();
  resetStopStarted();
  class Client {
    constructor() {
      this.details = {
        get(name, key, callback) {
          calls.push(['details.get', name, key]);
          if (failures.has('details.get')) return callback(failures.get('details.get'));
          const value = details.get(name) || {};
          return callback(null, { details: { [key]: value[key] === undefined ? null : value[key] } });
        },
      };
    }

    status(name, callback) {
      calls.push(['status', name]);
      if (failures.has(`status:${name}`)) return callback(failures.get(`status:${name}`));
      if (!states.has(name)) return callback(notInstalled());
      return callback(null, states.get(name));
    }

    install(descriptor, callback) {
      calls.push(['install', descriptor]);
      if (failures.has('install')) return callback(failures.get('install'));
      states.set(descriptor.name, installState);
      return callback(null, installState);
    }

    start(name, callback) {
      calls.push(['start', name]);
      if (failures.has('start')) return callback(failures.get('start'));
      states.set(name, { status: 'RUNNING' });
      return callback(null, { status: 'RUNNING' });
    }

    stop(name, callback) {
      calls.push(['stop', name]);
      if (failures.has('stop')) return callback(failures.get('stop'));
      states.set(name, { status: 'STOPPED' });
      if (holdNextStop || stopNameToHold === name) {
        holdNextStop = false;
        stopNameToHold = null;
        pendingStop = { callback };
        resolveStopStarted();
        return undefined;
      }
      return callback(null, { status: 'STOPPED' });
    }

    uninstall(name, callback) {
      calls.push(['uninstall', name]);
      if (failures.has('uninstall')) return callback(failures.get('uninstall'));
      if (holdNextUninstall) {
        holdNextUninstall = false;
        pendingUninstall = { name, callback };
        resolveUninstallStarted();
        return undefined;
      }
      states.delete(name);
      details.delete(name);
      return callback(null);
    }
  }
  return {
    Client, calls, details, failures, states,
    setInstallState(value) { installState = value; },
    holdNextStop() {
      holdNextStop = true;
      pendingStop = null;
      resetStopStarted();
    },
    holdStopFor(name) {
      holdNextStop = false;
      stopNameToHold = name;
      pendingStop = null;
      resetStopStarted();
    },
    waitUntilStopStarted() { return stopStarted; },
    finishStop() {
      assert.ok(pendingStop, '보류 중인 stop이 있어야 합니다.');
      const { callback } = pendingStop;
      pendingStop = null;
      callback(null, { status: 'STOPPED' });
    },
    holdNextUninstall() {
      holdNextUninstall = true;
      pendingUninstall = null;
      resetUninstallStarted();
    },
    waitUntilUninstallStarted() { return uninstallStarted; },
    finishUninstall() {
      assert.ok(pendingUninstall, '보류 중인 uninstall이 있어야 합니다.');
      const { name, callback } = pendingUninstall;
      pendingUninstall = null;
      states.delete(name);
      details.delete(name);
      callback(null);
    },
  };
}

function fakeDatabase() {
  const calls = [];
  const ensureCalls = [];
  let failure = null;
  let holdNextValidation = false;
  let pendingValidation = null;
  let validationStarted = null;
  let resolveValidationStarted = null;

  function resetValidationStarted() {
    validationStarted = new Promise((resolve) => { resolveValidationStarted = resolve; });
  }

  resetValidationStarted();
  return {
    calls,
    ensureCalls,
    fail(error) { failure = error; },
    recover() { failure = null; },
    holdNextValidation() {
      holdNextValidation = true;
      pendingValidation = null;
      resetValidationStarted();
    },
    waitUntilValidationStarted() { return validationStarted; },
    finishValidation() {
      assert.ok(pendingValidation, '보류 중인 DB validation이 있어야 합니다.');
      const { database, callback } = pendingValidation;
      pendingValidation = null;
      if (failure) callback(failure);
      else callback(null, { server: database.server, table: database.table });
    },
    validate(database, callback) {
      calls.push({ ...database });
      if (holdNextValidation) {
        holdNextValidation = false;
        pendingValidation = { database, callback };
        resolveValidationStarted();
        return;
      }
      if (failure) callback(failure);
      else callback(null, { server: database.server, table: database.table });
    },
    ensure(database, options, callback) {
      calls.push({ ...database });
      ensureCalls.push({ database: { ...database }, options: { ...options } });
      if (holdNextValidation) {
        holdNextValidation = false;
        pendingValidation = { database, callback };
        resolveValidationStarted();
        return;
      }
      if (failure) callback(failure);
      else callback(null, { server: database.server, table: database.table });
    },
  };
}

function managerFor(root, service, database) {
  return new JobManager({
    cgiRoot: root,
    serviceModule: service,
    databaseAdapter: database,
    runtimeNeoVersion: '8.5.6',
  });
}

function managerWithReleaseLocks(root, releaseJob, releaseFence) {
  return new JobManager({
    cgiRoot: root,
    serviceModule: fakeServiceModule(),
    databaseAdapter: fakeDatabase(),
    runtimeNeoVersion: '8.5.6',
    packageLifecycleLock: {
      acquire() { return { assertOwned() {}, release: releaseFence }; },
    },
    operationLock: {
      acquire() { return { assertOwned() {}, release: releaseJob }; },
    },
  });
}

function invokeLifecycle(action) {
  return new Promise((resolve, reject) => action((failure, names) => (
    failure ? reject(failure) : resolve(names)
  )));
}

async function testHappyLifecycleAndProjection() {
  const root = setupRoot('neo-job-manager-happy-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const manager = managerFor(root, service, database);
    const created = await call(manager, 'create', { name: 'line_a-01', config: jobConfig() });
    assert.deepEqual({
      configState: created.configState,
      executionState: created.executionState,
      controllerState: created.controllerState,
      statusKnown: created.statusKnown,
      installed: created.installed,
      running: created.running,
    }, {
      configState: 'installed', executionState: 'stopped', controllerState: 'STOPPED',
      statusKnown: true, installed: true, running: false,
    });
    assert.equal(service.calls[0][0], 'status', 'create는 쓰기 전에 orphan service를 확인해야 합니다.');
    assert.equal(service.calls.some(([method]) => method === 'install'), true);
    assert.equal(database.calls.length, 1);

    const descriptor = service.calls.find(([method]) => method === 'install')[1];
    assert.deepEqual(descriptor, {
      name: '_dbu_line_a-01',
      enable: false,
      working_dir: root,
      executable: path.join(root, 'neo-collector.js'),
      args: ['line_a-01.json'],
    });

    database.calls.length = 0;
    assert.equal((await call(manager, 'start', 'line_a-01')).controllerState, 'RUNNING');
    assert.equal(database.calls.length, 1, 'start는 DB mapping을 다시 확인해야 합니다.');
    await rejectsCode(call(manager, 'update', 'line_a-01', { revision: created.revision, schedule: { intervalMs: 2500 } }), 'JOB_RUNNING');
    await rejectsCode(call(manager, 'delete', 'line_a-01'), 'JOB_RUNNING');
    await call(manager, 'stop', 'line_a-01');

    const patched = await call(manager, 'update', 'line_a-01', { revision: created.revision, retry: { multiplier: 3 } });
    assert.equal(patched.config.retry.initialDelayMs, 5000);
    assert.equal(patched.config.retry.multiplier, 3);
    assert.equal(database.calls.length, 2, 'update는 병합한 DB mapping을 확인해야 합니다.');

    service.details.set('_dbu_line_a-01', {
      lastRun: {
        startedAt: '2026-08-03T00:00:00.000Z',
        completedAt: '2026-08-03T00:00:01.000Z',
        status: 'success',
        profileId: 'ls-electric-plc',
        profileVersion: 1,
        methodCalls: [{
          id: 'read-plc-data-1', name: 'Read PLC', interfaceId: 'device-status', methodId: 'get-device-data', requestedAt: 'a', completedAt: 'b',
          status: 'success', storedCount: 2, error: null,
          body: 'raw', password: 'secret', config: {}, payload: {}, values: [1, 2],
        }],
        lastRunAt: '2026-08-03T00:00:01.000Z',
        lastSuccessfulRunAt: '2026-08-03T00:00:01.000Z',
        lastStoredAt: '2026-08-03T00:00:01.000Z',
        lastError: null,
        overrunCount: 2,
        lastOverrunAt: '2026-08-03T00:00:00.500Z',
        password: 'secret', config: {}, payload: {}, values: [1, 2], body: 'raw', extra: 'drop',
      },
    });
    const lastRun = await call(manager, 'lastRun', 'line_a-01');
    assert.deepEqual(lastRun, {
      lastRun: {
        startedAt: '2026-08-03T00:00:00.000Z', completedAt: '2026-08-03T00:00:01.000Z',
        status: 'success',
        methodCalls: [{
          id: 'read-plc-data-1', name: 'Read PLC', interfaceId: 'device-status', methodId: 'get-device-data', requestedAt: 'a', completedAt: 'b',
          status: 'success', storedCount: 2, error: null,
        }],
        lastRunAt: '2026-08-03T00:00:01.000Z',
        lastSuccessfulRunAt: '2026-08-03T00:00:01.000Z',
        lastStoredAt: '2026-08-03T00:00:01.000Z', lastError: null,
        overrunCount: 2, lastOverrunAt: '2026-08-03T00:00:00.500Z',
      },
    });

    const summary = (await call(manager, 'list'))[0];
    assert.equal(Object.prototype.hasOwnProperty.call(summary, 'config'), false);
    assert.deepEqual({
      name: summary.name,
      interfaceIds: summary.interfaceIds,
      methodCallCount: summary.methodCallCount,
      lastStoredAt: summary.lastStoredAt,
    }, {
      name: 'line_a-01', interfaceIds: ['device-status'],
      methodCallCount: 1, lastStoredAt: '2026-08-03T00:00:01.000Z',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testUpdateUsesServerRevisionAndAcceptsStaleClientRevision() {
  const root = setupRoot('neo-job-manager-revision-');
  try {
    const manager = managerFor(root, fakeServiceModule(), fakeDatabase());
    const created = await call(manager, 'create', { name: 'alpha', config: jobConfig() });
    assert.equal(created.revision, 1, '새 Job은 revision 1로 시작해야 합니다.');

    const updated = await call(manager, 'update', 'alpha', {
      revision: created.revision,
      schedule: { intervalMs: 2000 },
    });
    assert.equal(updated.revision, 2, '성공한 수정은 revision을 하나 올려야 합니다.');

    const staleUpdated = await call(manager, 'update', 'alpha', {
      revision: created.revision,
      schedule: { intervalMs: 3000 },
    });
    assert.equal(staleUpdated.revision, 3, '서버의 최신 revision 다음 번호를 발급해야 합니다.');

    const current = await call(manager, 'get', 'alpha');
    assert.equal(current.revision, 3);
    assert.equal(current.config.schedule.intervalMs, 3000, '낮은 client revision의 유효한 수정도 저장해야 합니다.');

    const duplicate = await call(manager, 'update', 'alpha', {
      revision: created.revision,
      schedule: { intervalMs: 3000 },
    });
    assert.equal(duplicate.revision, 3, '동일한 재요청은 revision을 증가시키지 않아야 합니다.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReleaseFailureStillCompletesMutationCallback() {
  const root = setupRoot('neo-job-manager-release-failure-');
  try {
    const releaseFailure = Object.assign(new Error('lock release failed'), { code: 'LOCK_RELEASE_FAILED' });
    let releaseCalls = 0;
    let callbackCalls = 0;
    let callbackError = null;
    const manager = new JobManager({
      cgiRoot: root,
      serviceModule: fakeServiceModule(),
      databaseAdapter: fakeDatabase(),
      runtimeNeoVersion: '8.5.6',
      operationLock: {
        acquire() {
          return {
            assertOwned() {},
            release() { releaseCalls += 1; throw releaseFailure; },
          };
        },
      },
    });

    manager.create({ name: 'alpha', config: jobConfig() }, (failure) => {
      callbackCalls += 1;
      callbackError = failure;
    });

    assert.equal(releaseCalls, 1, 'release 실패 경로에서도 잠금 해제는 한 번만 시도해야 합니다.');
    assert.equal(callbackCalls, 1, 'release 실패가 나도 mutation callback은 한 번 호출해야 합니다.');
    assert.strictEqual(callbackError, releaseFailure);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testUpdateSerializesStartAcrossManagers() {
  const root = setupRoot('neo-job-manager-update-start-lock-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const managerA = managerFor(root, service, database);
    const managerB = managerFor(root, service, database);
    const created = await call(managerA, 'create', { name: 'alpha', config: jobConfig() });

    database.holdNextValidation();
    const update = call(managerA, 'update', 'alpha', {
      revision: created.revision,
      schedule: { intervalMs: 2000 },
    });
    await database.waitUntilValidationStarted();

    const startCalls = service.calls.filter(([method]) => method === 'start').length;
    await rejectsCode(call(managerB, 'start', 'alpha'), 'JOB_CONFLICT');
    assert.equal(
      service.calls.filter(([method]) => method === 'start').length,
      startCalls,
      'Update lock 충돌 중에는 Controller start를 호출하면 안 됩니다.',
    );

    database.finishValidation();
    await update;

    const stored = JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'jobs', 'alpha.json'), 'utf8'));
    assert.equal(stored.schedule.intervalMs, 2000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testUpdateSerializesDeleteAndCreateAcrossManagers() {
  const root = setupRoot('neo-job-manager-update-file-lock-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const managerA = managerFor(root, service, database);
    const managerB = managerFor(root, service, database);
    const created = await call(managerA, 'create', { name: 'alpha', config: jobConfig() });

    database.holdNextValidation();
    const update = call(managerA, 'update', 'alpha', {
      revision: created.revision,
      schedule: { intervalMs: 2000 },
    });
    await database.waitUntilValidationStarted();

    await Promise.all([
      rejectsCode(call(managerB, 'delete', 'alpha'), 'JOB_CONFLICT'),
      rejectsCode(call(managerB, 'create', { name: 'alpha', config: jobConfig() }), 'JOB_CONFLICT'),
    ]);
    assert.equal(
      service.calls.filter(([method]) => method === 'uninstall').length,
      0,
      'Update lock 충돌 중에는 Controller uninstall을 호출하면 안 됩니다.',
    );

    database.finishValidation();
    await update;

    const files = fs.readdirSync(path.join(root, 'conf.d', 'jobs')).filter((entry) => entry === 'alpha.json');
    assert.deepEqual(files, ['alpha.json']);
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'jobs', 'alpha.json'), 'utf8'));
    assert.equal(stored.revision, 2);
    assert.equal(stored.schedule.intervalMs, 2000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testDeleteSerializesUpdateAndCreateAcrossManagers() {
  const root = setupRoot('neo-job-manager-delete-lock-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const managerA = managerFor(root, service, database);
    const managerB = managerFor(root, service, database);
    const created = await call(managerA, 'create', { name: 'alpha', config: jobConfig() });

    service.holdNextUninstall();
    const deletion = call(managerA, 'delete', 'alpha');
    await service.waitUntilUninstallStarted();

    await Promise.all([
      rejectsCode(call(managerB, 'update', 'alpha', {
        revision: created.revision,
        schedule: { intervalMs: 3000 },
      }), 'JOB_CONFLICT'),
      rejectsCode(call(managerB, 'create', { name: 'alpha', config: jobConfig() }), 'JOB_CONFLICT'),
    ]);
    assert.equal(database.calls.length, 1, 'Delete lock 충돌 중에는 Update/Create DB validation을 호출하면 안 됩니다.');

    service.finishUninstall();
    await deletion;
    assert.equal(fs.existsSync(path.join(root, 'conf.d', 'jobs', 'alpha.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testCreateSafetyAndUnknownState() {
  for (const scenario of [
    { label: 'stopped orphan', state: { status: 'STOPPED' }, code: 'SERVICE_ALREADY_INSTALLED' },
    { label: 'running orphan', state: { status: 'RUNNING' }, code: 'SERVICE_ALREADY_INSTALLED' },
    { label: 'unknown orphan', state: { status: 'PAUSED' }, code: 'CONTROLLER_UNKNOWN' },
    { label: 'rpc orphan', failure: new Error('RPC failed'), code: 'CONTROLLER_UNAVAILABLE' },
  ]) {
    const root = setupRoot(`neo-create-${scenario.label.replace(/ /g, '-')}-`);
    try {
      const service = fakeServiceModule();
      if (scenario.state) service.states.set('_dbu_alpha', scenario.state);
      if (scenario.failure) service.failures.set('status:_dbu_alpha', scenario.failure);
      const manager = managerFor(root, service, fakeDatabase());
      await rejectsCode(call(manager, 'create', { name: 'alpha', config: jobConfig() }), scenario.code);
      assert.equal(fs.existsSync(path.join(root, 'conf.d', 'jobs', 'alpha.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const root = setupRoot('neo-unknown-state-');
  try {
    const service = fakeServiceModule();
    const manager = managerFor(root, service, fakeDatabase());
    const created = await call(manager, 'create', { name: 'alpha', config: jobConfig() });
    service.states.set('_dbu_alpha', { status: 'PAUSED', error: 'unsupported' });
    const detail = await call(manager, 'get', 'alpha');
    assert.deepEqual({
      configState: detail.configState,
      executionState: detail.executionState,
      statusKnown: detail.statusKnown,
      installed: detail.installed,
      running: detail.running,
    }, { configState: null, executionState: null, statusKnown: false, installed: null, running: null });
    await rejectsCode(call(manager, 'delete', 'alpha'), 'CONTROLLER_UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testDatabaseGuardsAndWarnings() {
  const root = setupRoot('neo-db-guards-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const manager = managerFor(root, service, database);
    const dbFailure = Object.assign(new Error('DB metadata failed'), { code: 'DB_UNAVAILABLE' });
    database.fail(dbFailure);
    await rejectsCode(call(manager, 'create', { name: 'alpha', config: jobConfig() }), 'DB_UNAVAILABLE');
    assert.equal(fs.existsSync(path.join(root, 'conf.d', 'jobs', 'alpha.json')), false);
    await rejectsCode(call(manager, 'validate', { name: 'alpha', config: jobConfig() }), 'DB_UNAVAILABLE');

    database.recover();
    const created = await call(manager, 'create', { name: 'alpha', config: jobConfig() });
    database.fail(dbFailure);
    const before = fs.readFileSync(path.join(root, 'conf.d', 'jobs', 'alpha.json'), 'utf8');
    await rejectsCode(call(manager, 'update', 'alpha', { revision: created.revision, schedule: { intervalMs: 2000 } }), 'DB_UNAVAILABLE');
    assert.equal(fs.readFileSync(path.join(root, 'conf.d', 'jobs', 'alpha.json'), 'utf8'), before);
    await rejectsCode(call(manager, 'start', 'alpha'), 'DB_UNAVAILABLE');
    assert.equal(service.calls.some(([method]) => method === 'start'), false);

    database.recover();
    const warning = await call(manager, 'validate', { name: 'beta', config: jobConfig() });
    assert.deepEqual(warning.warnings, [{
      code: 'TAG_NAME_USED_BY_ANOTHER_JOB',
      reason: '같은 DB table의 Tag name을 다른 Job도 사용합니다.',
      path: '/methodCalls',
      details: { jobs: ['alpha'], tags: ['%MB3', '%MB4'] },
    }]);

    const selectedOutputConfig = jobConfig();
    const selectedCall = selectedOutputConfig.methodCalls[0];
    const selectedTags = selectedCall.tags;
    delete selectedCall.tags;
    selectedCall.outputSelections = [{
      id: 'output-1', sourceIndex: 0, interpretation: 'json', selector: '/data',
      valueType: 'array', elementType: 'numeric', tags: selectedTags,
    }];
    const selectedWarning = await call(manager, 'validate', { name: 'gamma', config: selectedOutputConfig });
    assert.deepEqual(selectedWarning.warnings, [{
      code: 'TAG_NAME_USED_BY_ANOTHER_JOB',
      reason: '같은 DB table의 Tag name을 다른 Job도 사용합니다.',
      path: '/methodCalls',
      details: { jobs: ['alpha'], tags: ['%MB3', '%MB4'] },
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testCreateAndUpdateProvisionDatabaseTable() {
  const root = setupRoot('neo-db-provision-');
  try {
    const database = fakeDatabase();
    const manager = managerFor(root, fakeServiceModule(), database);
    const numericConfig = jobConfig();
    const tags = numericConfig.methodCalls[0].tags;
    delete numericConfig.methodCalls[0].tags;
    numericConfig.methodCalls[0].outputSelections = [{
      id: 'numeric-output', sourceIndex: 0, interpretation: 'json', selector: '/data',
      valueType: 'array', elementType: 'numeric', tags,
    }];
    const created = await call(manager, 'create', { name: 'alpha', config: numericConfig });
    assert.deepEqual(database.ensureCalls, [{
      database: numericConfig.database,
      options: { needsStringValueColumn: false, fractionalValuePossible: false },
    }], '생성은 Job 저장 전에 필요한 Table 구조를 전달해야 합니다.');
    await call(manager, 'update', 'alpha', {
      revision: created.revision,
      methodCalls: [jobConfig().methodCalls[0]],
    });
    assert.equal(database.ensureCalls.length, 2, '정지된 Job 수정도 Table을 보장해야 합니다.');
    assert.deepEqual(database.ensureCalls[1].options, {
      needsStringValueColumn: true,
      fractionalValuePossible: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testInvalidIdentityAndRollback() {
  const root = setupRoot('neo-job-rollback-');
  try {
    const service = fakeServiceModule();
    const manager = managerFor(root, service, fakeDatabase());
    await call(manager, 'create', { name: 'rollback', config: jobConfig() });
    assert.equal(fs.existsSync(path.join(root, 'conf.d', 'jobs', 'rollback.json')), true);

    service.failures.set('uninstall', new Error('uninstall failed'));
    await rejectsCode(call(manager, 'delete', 'rollback'), 'CONTROLLER_UNAVAILABLE');
    assert.equal(fs.existsSync(path.join(root, 'conf.d', 'jobs', 'rollback.json')), true);
    service.failures.delete('uninstall');

    writeJson(path.join(root, 'conf.d', 'jobs', 'damaged.json'), { ...jobConfig(), name: 'other' });
    const beforeCalls = service.calls.length;
    for (const action of ['start', 'stop', 'update', 'delete']) {
      const operation = action === 'update'
        ? call(manager, action, 'damaged', { schedule: { intervalMs: 2000 } })
        : call(manager, action, 'damaged');
      await rejectsCode(operation, 'JOB_INVALID_CONFIG');
    }
    assert.equal(service.calls.length, beforeCalls);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPackageSafeStop() {
  const root = setupRoot('neo-package-safe-stop-');
  try {
    const service = fakeServiceModule();
    const manager = managerFor(root, service, fakeDatabase());
    await call(manager, 'create', { name: 'alpha', config: jobConfig() });
    for (const state of ['RUNNING', 'STARTING', 'STOPPING']) {
      service.states.set('_dbu_alpha', { status: state });
      const stopped = await call(manager, 'stopForPackage', 'alpha');
      assert.equal(stopped.controllerState, 'STOPPED');
    }
    service.states.set('_dbu_alpha', { status: 'PAUSED' });
    await rejectsCode(call(manager, 'stopForPackage', 'alpha'), 'CONTROLLER_UNKNOWN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testApiStartSerializesPackageStopAcrossManagers() {
  const root = setupRoot('neo-api-start-package-stop-lock-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const managerA = managerFor(root, service, database);
    const managerB = managerFor(root, service, database);
    await call(managerA, 'create', { name: 'alpha', config: jobConfig() });

    database.holdNextValidation();
    const start = call(managerA, 'start', 'alpha');
    await database.waitUntilValidationStarted();

    const stopCalls = service.calls.filter(([method]) => method === 'stop').length;
    const packageStop = call(managerB, 'stopForPackage', 'alpha');

    database.finishValidation();
    await start;
    await rejectsCode(packageStop, 'JOB_CONFLICT');
    assert.equal(
      service.calls.filter(([method]) => method === 'stop').length,
      stopCalls,
      'API Start lock 충돌 중에는 package stop이 Controller stop을 호출하면 안 됩니다.',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPackageStopSerializesApiStartAcrossManagers() {
  const root = setupRoot('neo-package-stop-api-start-lock-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const managerA = managerFor(root, service, database);
    const managerB = managerFor(root, service, database);
    await call(managerA, 'create', { name: 'alpha', config: jobConfig() });
    await call(managerA, 'start', 'alpha');

    service.holdNextStop();
    const packageStop = call(managerA, 'stopForPackage', 'alpha');
    await service.waitUntilStopStarted();

    const startCalls = service.calls.filter(([method]) => method === 'start').length;
    const apiStart = call(managerB, 'start', 'alpha');

    service.finishStop();
    const [startResult, stopResult] = await Promise.allSettled([apiStart, packageStop]);
    assert.equal(startResult.status, 'rejected');
    assert.equal(startResult.reason && startResult.reason.code, 'JOB_CONFLICT');
    assert.equal(stopResult.status, 'fulfilled');
    assert.equal(
      service.calls.filter(([method]) => method === 'start').length,
      startCalls,
      'package stop lock 충돌 중에는 API Start가 Controller start를 호출하면 안 됩니다.',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPackageStopHoldsEarlierJobLockUntilWholeLifecycleCompletes() {
  const root = setupRoot('neo-package-stop-whole-lifecycle-lock-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const packageManager = managerFor(root, service, database);
    const apiManager = managerFor(root, service, database);
    for (const name of ['alpha', 'beta']) {
      await call(packageManager, 'create', { name, config: jobConfig() });
      await call(packageManager, 'start', name);
    }

    service.holdStopFor('_dbu_beta');
    const lifecycle = createLifecycle(
      packageManager, path.join(root, 'data', 'package-stop-state.json'), { print() {} },
    );
    const packageStop = invokeLifecycle(lifecycle.stop);
    await service.waitUntilStopStarted();

    const apiStart = call(apiManager, 'start', 'alpha');
    service.finishStop();
    const [startResult, stopResult] = await Promise.allSettled([apiStart, packageStop]);

    assert.equal(startResult.status, 'rejected');
    assert.equal(startResult.reason && startResult.reason.code, 'JOB_CONFLICT');
    assert.equal(stopResult.status, 'fulfilled');
    assert.equal((await call(apiManager, 'get', 'alpha')).controllerState, 'STOPPED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPackageUninstallFencesDeletedAndNewJobNamesUntilCompletion() {
  const root = setupRoot('neo-package-uninstall-whole-lifecycle-lock-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    const packageManager = managerFor(root, service, database);
    const apiManager = managerFor(root, service, database);
    await call(packageManager, 'create', { name: 'alpha', config: jobConfig() });
    await call(packageManager, 'create', { name: 'beta', config: jobConfig() });

    service.holdNextUninstall();
    const lifecycle = createLifecycle(
      packageManager, path.join(root, 'data', 'package-stop-state.json'), { print() {} },
    );
    const packageUninstall = invokeLifecycle(lifecycle.uninstall);
    await service.waitUntilUninstallStarted();

    const recreateDeleted = call(apiManager, 'create', { name: 'alpha', config: jobConfig() });
    const createNew = call(apiManager, 'create', { name: 'gamma', config: jobConfig() });
    service.finishUninstall();
    const [recreateResult, createResult, uninstallResult] = await Promise.allSettled([
      recreateDeleted, createNew, packageUninstall,
    ]);

    assert.equal(recreateResult.status, 'rejected');
    assert.equal(recreateResult.reason && recreateResult.reason.code, 'JOB_CONFLICT');
    assert.equal(createResult.status, 'rejected');
    assert.equal(createResult.reason && createResult.reason.code, 'JOB_CONFLICT');
    assert.equal(uninstallResult.status, 'fulfilled');
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.equal(fs.existsSync(path.join(root, 'conf.d', 'jobs', `${name}.json`)), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testMutationRechecksFenceAfterCanonicalAbsentProbeRace() {
  const root = setupRoot('neo-package-fence-toctou-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    let fenceChecks = 0;
    let jobReleases = 0;
    let callbackCalls = 0;
    let callbackError = null;
    const manager = new JobManager({
      cgiRoot: root,
      serviceModule: service,
      databaseAdapter: database,
      runtimeNeoVersion: '8.5.6',
      packageLifecycleLock: {
        assertAvailable() {
          fenceChecks += 1;
          if (fenceChecks === 2) {
            throw Object.assign(new Error('replacement fence appeared after canonical gap'), {
              code: 'JOB_CONFLICT', details: { name: 'alpha' },
            });
          }
        },
      },
      operationLock: {
        acquire() {
          return { assertOwned() {}, release() { jobReleases += 1; } };
        },
      },
    });

    manager.create({ name: 'alpha', config: jobConfig() }, (failure) => {
      callbackCalls += 1;
      callbackError = failure;
    });

    assert.equal(callbackCalls, 1);
    assert.equal(callbackError && callbackError.code, 'JOB_CONFLICT');
    assert.equal(fenceChecks, 2);
    assert.equal(jobReleases, 1);
    assert.equal(service.calls.length, 0);
    assert.equal(database.calls.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'conf.d', 'jobs', 'alpha.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPackageLifecycleSessionReleasesPartialAcquisitionForRetry() {
  const root = setupRoot('neo-package-session-acquire-recovery-');
  try {
    const acquired = [];
    const released = [];
    let fenceReleases = 0;
    let failBeta = true;
    const manager = new JobManager({
      cgiRoot: root,
      serviceModule: fakeServiceModule(),
      databaseAdapter: fakeDatabase(),
      runtimeNeoVersion: '8.5.6',
      packageLifecycleLock: {
        acquire() {
          return { assertOwned() {}, release() { fenceReleases += 1; } };
        },
      },
      operationLock: {
        acquire(name) {
          acquired.push(name);
          if (name === 'beta' && failBeta) {
            throw Object.assign(new Error('beta mutation pending'), {
              code: 'JOB_CONFLICT', details: { name },
            });
          }
          return { assertOwned() {}, release() { released.push(name); } };
        },
      },
    });

    assert.throws(() => manager.acquirePackageLifecycle(['beta', 'alpha', 'alpha']), (failure) => {
      assert.equal(failure.code, 'JOB_CONFLICT');
      assert.deepEqual(failure.details, { name: 'beta' });
      return true;
    });
    assert.deepEqual(acquired, ['alpha', 'beta']);
    assert.deepEqual(released, ['alpha']);
    assert.equal(fenceReleases, 1);

    failBeta = false;
    const session = manager.acquirePackageLifecycle(['beta', 'alpha']);
    session.release();
    session.release();
    assert.deepEqual(released, ['alpha', 'beta', 'alpha']);
    assert.equal(fenceReleases, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testDifferentJobMutationsShareLifecycleAvailabilityProbe() {
  const root = setupRoot('neo-package-probe-parallel-jobs-');
  try {
    const service = fakeServiceModule();
    const database = fakeDatabase();
    let managerB;
    let nestedStarted = false;
    let nestedCreate = null;
    let exclusiveHeld = false;
    const lifecycleLock = {
      assertAvailable() {
        if (nestedStarted) return;
        nestedStarted = true;
        nestedCreate = call(managerB, 'create', { name: 'beta', config: jobConfig() })
          .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
      },
      acquire() {
        if (exclusiveHeld) {
          throw Object.assign(new Error('exclusive lifecycle check collision'), {
            code: 'JOB_CONFLICT', details: { name: 'package-lifecycle' },
          });
        }
        exclusiveHeld = true;
        return {
          assertOwned() {},
          release() {
            if (!nestedStarted) {
              nestedStarted = true;
              nestedCreate = call(managerB, 'create', { name: 'beta', config: jobConfig() })
                .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
            }
            exclusiveHeld = false;
          },
        };
      },
    };
    const options = {
      cgiRoot: root,
      serviceModule: service,
      databaseAdapter: database,
      runtimeNeoVersion: '8.5.6',
      packageLifecycleLock: lifecycleLock,
    };
    const managerA = new JobManager(options);
    managerB = new JobManager(options);

    const alpha = await call(managerA, 'create', { name: 'alpha', config: jobConfig() });
    const beta = await nestedCreate;

    assert.equal(alpha.name, 'alpha');
    assert.equal(beta.status, 'fulfilled', '서로 다른 Job API의 lifecycle 부재 검사는 서로 막으면 안 됩니다.');
    assert.equal(beta.value.name, 'beta');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPackageLifecycleSessionRetriesJobHandleRelease() {
  const root = setupRoot('neo-package-session-job-release-retry-');
  try {
    let jobReleaseAttempts = 0;
    let fenceReleaseAttempts = 0;
    let failFirstJobRelease = true;
    const manager = managerWithReleaseLocks(root, () => {
      jobReleaseAttempts += 1;
      if (failFirstJobRelease) {
        failFirstJobRelease = false;
        throw Object.assign(new Error('job release failed'), { code: 'LOCK_RELEASE_FAILED' });
      }
    }, () => { fenceReleaseAttempts += 1; });

    const first = manager.acquirePackageLifecycle(['alpha']);
    assert.throws(() => first.release(), (failure) => failure.code === 'LOCK_RELEASE_FAILED');
    assert.equal(jobReleaseAttempts, 1);
    assert.equal(fenceReleaseAttempts, 0, 'Job handle이 남았으면 fence를 먼저 풀면 안 됩니다.');
    assert.doesNotThrow(() => first.release());
    assert.equal(jobReleaseAttempts, 2);
    assert.equal(fenceReleaseAttempts, 1);

    const next = manager.acquirePackageLifecycle(['alpha']);
    assert.doesNotThrow(() => next.release());
    assert.equal(jobReleaseAttempts, 3);
    assert.equal(fenceReleaseAttempts, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testPackageLifecycleSessionRetriesFenceRelease() {
  const root = setupRoot('neo-package-session-fence-release-retry-');
  try {
    let jobReleaseAttempts = 0;
    let fenceReleaseAttempts = 0;
    let failFirstFenceRelease = true;
    const manager = managerWithReleaseLocks(
      root,
      () => { jobReleaseAttempts += 1; },
      () => {
        fenceReleaseAttempts += 1;
        if (failFirstFenceRelease) {
          failFirstFenceRelease = false;
          throw Object.assign(new Error('fence release failed'), { code: 'LOCK_RELEASE_FAILED' });
        }
      },
    );

    const first = manager.acquirePackageLifecycle(['alpha']);
    assert.throws(() => first.release(), (failure) => failure.code === 'LOCK_RELEASE_FAILED');
    assert.equal(jobReleaseAttempts, 1);
    assert.equal(fenceReleaseAttempts, 1);
    assert.doesNotThrow(() => first.release());
    assert.equal(jobReleaseAttempts, 1, '성공한 Job handle은 두 번 해제하면 안 됩니다.');
    assert.equal(fenceReleaseAttempts, 2);

    const next = manager.acquirePackageLifecycle(['alpha']);
    assert.doesNotThrow(() => next.release());
    assert.equal(jobReleaseAttempts, 2);
    assert.equal(fenceReleaseAttempts, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testLsLogLevelHotApplyDoesNotStopLogicalJob() {
  const root = setupRoot('neo-ls-log-hot-apply-');
  try {
    const calls = [];
    const lsRuntime = {
      inspect(_name, callback) {
        callback(null, { controllerState: 'RUNNING', controllerDetail: null, statusError: null });
      },
      syncConfig() { calls.push('syncConfig'); },
      refreshLog(name, callback) { calls.push(['refreshLog', name]); callback(null); },
    };
    const manager = new JobManager({
      cgiRoot: root,
      productPolicy: {
        target: 'ls',
        minimumIntervalMs: 1,
        validationLimits: {},
        validateProductConfig(config) { return config; },
      },
      lsRuntime,
      databaseAdapter: fakeDatabase(),
    });
    const created = manager.repository.create('alpha', jobConfig());
    manager.indexRepository.write(created);

    const result = await call(manager, 'updateLog', 'alpha', { revision: 1, level: 'warn' });
    assert.equal(result.running, true);
    assert.equal(result.revision, 2);
    assert.equal(result.config.log.level, 'warn');
    assert.deepEqual(calls, [['refreshLog', 'alpha']]);
    assert.equal(manager.repository.read('alpha').log.level, 'warn');
    assert.equal(manager.repository.read('alpha').revision, 2);

    const duplicate = await call(manager, 'updateLog', 'alpha', { revision: 1, level: 'warn' });
    assert.equal(duplicate.revision, 2, '동일한 Log Level 재요청은 revision을 증가시키지 않아야 합니다.');
    assert.deepEqual(calls, [['refreshLog', 'alpha'], ['refreshLog', 'alpha']],
      '동일한 Log Level 재요청도 이전 control 실패로 생긴 설정/daemon 불일치를 복구해야 합니다.');

    const stale = await call(manager, 'updateLog', 'alpha', { revision: 1, level: 'error' });
    assert.equal(stale.revision, 3, '낮은 client revision이어도 서버 revision을 기준으로 저장해야 합니다.');
    assert.equal(stale.config.log.level, 'error');
    assert.equal(manager.repository.read('alpha').revision, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testLsUpdateKeepsRegistrationAndRepairsStaleIndex() {
  const root = setupRoot('neo-ls-update-index-recovery-');
  try {
    const lsInterface = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'products', 'ls', 'interfaces', 'ls-plc-device.json'),
      'utf8',
    ));
    writeJson(path.join(root, 'conf.d', 'interfaces', 'ls-plc-device.json'), lsInterface);
    const config = jobConfig({
      methodCalls: [{
        id: 'read-a', name: 'Read A', interfaceId: 'ls-plc-device', methodId: 'get-device-data',
        inputs: { DataCount: 1, DeviceString: '%MB0' },
        outputSelections: [{
          id: 'return-data', sourceIndex: 0, interpretation: 'json', selector: '/data',
          valueType: 'array', elementType: 'numeric',
          tags: [{ name: 'MB0', bias: 0, multiplier: 1, transformOrder: ['bias', 'multiplier'], signed: false }],
        }],
      }],
    });
    const lsRuntime = {
      inspect(_name, callback) {
        callback(null, { controllerState: 'STOPPED', controllerDetail: null, statusError: null });
      },
    };
    const manager = new JobManager({
      cgiRoot: root,
      productPolicy: {
        target: 'ls',
        minimumIntervalMs: 1,
        validationLimits: { maxGeneratedTagsPerCall: 65535, maxBufferedRowsPerCycle: 65535 },
        validateProductConfig(config) { return config; },
      },
      lsRuntime,
      databaseAdapter: fakeDatabase(),
      serverStore: {
        get(name, callback) {
          callback(null, {
            name, defaultTable: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE',
          });
        },
      },
    });
    manager.settings = () => ({ defaults: { database: { server: 'local-db' } }, limits: {} });
    const created = manager.repository.create('alpha', config);
    manager.indexRepository.write(created);

    const originalWrite = manager.indexRepository.write.bind(manager.indexRepository);
    let failNextWrite = true;
    manager.indexRepository.write = (document) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('simulated interrupted index write');
      }
      return originalWrite(document);
    };

    await assert.rejects(
      call(manager, 'update', 'alpha', { revision: 1, schedule: { intervalMs: 2000 } }),
      /simulated interrupted index write/,
    );
    assert.equal(manager.repository.read('alpha').revision, 2,
      'canonical Job 저장은 완료된 상태를 재현해야 합니다.');
    assert.equal(manager.indexRepository.read('alpha').revision, 1,
      '실패한 index 갱신이 기존 등록 marker를 지우면 안 됩니다.');

    const visible = await call(manager, 'get', 'alpha');
    assert.equal(visible.revision, 2, 'stale index가 남아도 Job 상세는 유실되지 않아야 합니다.');
    assert.equal(visible.config.schedule.intervalMs, 2000);

    const retried = await call(manager, 'update', 'alpha', { revision: 1, schedule: { intervalMs: 2000 } });
    assert.equal(retried.revision, 2, '동일 저장 재시도는 canonical revision을 다시 올리지 않아야 합니다.');
    assert.equal(manager.indexRepository.read('alpha').revision, 2,
      '동일 저장 재시도는 stale index를 canonical Job과 동기화해야 합니다.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testLsClearOverrunUsesLogicalCollectorControl() {
  const root = setupRoot('neo-ls-clear-overrun-');
  try {
    const calls = [];
    const lsRuntime = {
      clearOverrun(name, callback) { calls.push(['clearOverrun', name]); callback(null); },
      lastRun(name, callback) { calls.push(['lastRun', name]); callback(null, { status: 'success', overrunCount: 0, lastOverrunAt: '', methodCalls: [] }); },
    };
    const manager = new JobManager({
      cgiRoot: root,
      productPolicy: { target: 'ls', minimumIntervalMs: 1, validationLimits: {}, validateProductConfig(config) { return config; } },
      lsRuntime,
      databaseAdapter: fakeDatabase(),
    });
    const created = manager.repository.create('alpha', jobConfig());
    manager.indexRepository.write(created);

    const result = await call(manager, 'clearOverrun', 'alpha');
    assert.deepEqual(calls, [['clearOverrun', 'alpha'], ['lastRun', 'alpha']]);
    assert.equal(result.lastRun.overrunCount, 0);
    assert.equal(result.lastRun.lastOverrunAt, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  await testHappyLifecycleAndProjection();
  await testUpdateUsesServerRevisionAndAcceptsStaleClientRevision();
  testReleaseFailureStillCompletesMutationCallback();
  await testUpdateSerializesDeleteAndCreateAcrossManagers();
  await testUpdateSerializesStartAcrossManagers();
  await testDeleteSerializesUpdateAndCreateAcrossManagers();
  await testCreateSafetyAndUnknownState();
  await testDatabaseGuardsAndWarnings();
  await testCreateAndUpdateProvisionDatabaseTable();
  await testInvalidIdentityAndRollback();
  await testPackageSafeStop();
  await testPackageStopSerializesApiStartAcrossManagers();
  await testApiStartSerializesPackageStopAcrossManagers();
  testMutationRechecksFenceAfterCanonicalAbsentProbeRace();
  testPackageLifecycleSessionReleasesPartialAcquisitionForRetry();
  testPackageLifecycleSessionRetriesFenceRelease();
  testPackageLifecycleSessionRetriesJobHandleRelease();
  await testDifferentJobMutationsShareLifecycleAvailabilityProbe();
  await testPackageUninstallFencesDeletedAndNewJobNamesUntilCompletion();
  await testPackageStopHoldsEarlierJobLockUntilWholeLifecycleCompletes();
  await testLsLogLevelHotApplyDoesNotStopLogicalJob();
  await testLsUpdateKeepsRegistrationAndRepairsStaleIndex();
  await testLsClearOverrunUsesLogicalCollectorControl();

  const adapter = createControllerAdapter(fakeServiceModule());
  assert.equal(typeof adapter.status, 'function');
}

run().then(() => console.log('Job manager lifecycle: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
