'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLsRuntime, runtimePaths, LS_SERVICE_NAME } = require('../src/collector/ls-runtime.js');
const { ReferenceAnalyzer } = require('../src/profiles/references.js');
const { externalPath: controlExternalPath } = require('../neo-dbus-control.js');
const { externalPath: launcherExternalPath } = require('../neo-dbus-launcher.js');

function call(operation) {
  return new Promise((resolve, reject) => operation((error, value) => (error ? reject(error) : resolve(value))));
}

test('LS launcher와 control은 CGI·service 공통 /work mount를 외부 명령 경로로 사용한다', () => {
  for (const externalPath of [controlExternalPath, launcherExternalPath]) {
    assert.equal(externalPath('/work/public/neo-pkg-dbus/cgi-bin'), '/work/public/neo-pkg-dbus/cgi-bin');
    assert.throws(() => externalPath('/data/public/neo-pkg-dbus/cgi-bin'), /unsupported JSH path/);
    assert.throws(() => externalPath('/work/public/../secret'), /unsupported JSH path/);
  }
});

test('LS runtime은 password 없는 snapshot과 0600 secret을 분리하고 logical Job control을 호출한다', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-ls-runtime-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'neo-dbus-collector'), 'fixture');
  fs.writeFileSync(path.join(root, 'neo-dbus-launcher.js'), 'fixture');
  fs.writeFileSync(path.join(root, 'neo-dbus-control.js'), 'fixture');
  fs.mkdirSync(path.join(root, 'conf.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'conf.d', 'settings.json'), JSON.stringify({
    schemaVersion: 1,
    limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
    defaults: { database: { server: 'local' } },
    logging: { maxFileBytes: 1024 * 1024, maxFiles: 3, summaryIntervalMs: 60 * 60 * 1000 },
  }));
  const calls = [];
  let serviceState = 'STOPPED';
  let installed = false;
  const controller = {
    status(name, callback) {
      assert.equal(name, LS_SERVICE_NAME);
      if (!installed) { callback(Object.assign(new Error('service not found'), { rpcCode: -32004 })); return; }
      callback(null, { status: serviceState });
    },
    install(descriptor, callback) { calls.push(['install', descriptor]); installed = true; serviceState = 'STOPPED'; callback(null); },
    start(name, callback) { calls.push(['start', name]); serviceState = 'RUNNING'; callback(null); },
    stop(name, callback) { calls.push(['stop', name]); serviceState = 'STOPPED'; callback(null); },
    uninstall(name, callback) { calls.push(['uninstall', name]); serviceState = 'NOT_INSTALLED'; callback(null); },
  };
  const repository = {
    list() { return [{ document: {
      schemaVersion: 1, name: 'line-a', schedule: { intervalMs: 10 },
      database: { server: 'local', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: '' }, methodCalls: [],
    } }]; },
  };
  const runtime = createLsRuntime({
    cgiRoot: root, controller, repository,
    serverStore: { get(name, callback) { assert.equal(name, 'local'); callback(null, {
      host: '127.0.0.1', port: 5656, user: 'sys', password: 'not-for-snapshot',
    }); } },
    process: { exec(...args) { calls.push(['exec', args]); return 0; } },
  });

  await call((done) => runtime.installPackage(done));
  assert.equal(calls[0][1].executable, path.join(root, 'neo-dbus-launcher.js'));
  assert.equal(calls[0][1].enable, true, 'collector service must auto-start after Neo restart');
  assert.equal(Object.hasOwn(calls[0][1], 'args'), false);
  const files = runtimePaths(root);
  const snapshot = JSON.parse(fs.readFileSync(files.snapshot, 'utf8'));
  const secret = JSON.parse(fs.readFileSync(files.secret, 'utf8'));
  assert.equal(JSON.stringify(snapshot).includes('not-for-snapshot'), false);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(Object.hasOwn(snapshot, 'jobs'), false);
  assert.deepEqual(snapshot.performance, { enabled: true, jobSampleCount: 1000, writerSummaryIntervalMs: 30000 });
  assert.equal(secret.servers.local.password, 'not-for-snapshot');
  assert.equal(fs.statSync(files.secret).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.active, 'utf8')).names, []);

  await call((done) => runtime.ensureRunning(done));
  assert.equal((await call((done) => runtime.daemonStatus(done))).controllerState, 'RUNNING');
  assert.equal(fs.statSync(files.binary).mode & 0o777, 0o755);
  assert.equal(fs.statSync(files.launcher).mode & 0o777, 0o755);
  assert.equal(fs.statSync(files.control).mode & 0o777, 0o755);
  await call((done) => runtime.start('line-a', done));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.active, 'utf8')).names, [], 'JSH control does not own the Go active checkpoint');
  await call((done) => runtime.refreshLog('line-a', done));
  await call((done) => runtime.clearOverrun('line-a', done));
  fs.mkdirSync(path.dirname(files.runtime), { recursive: true });
  fs.writeFileSync(files.runtime, JSON.stringify({ jobs: {
    'line-a': {
      state: 'running', lastReadAt: '2026-09-01T00:00:00.000Z', lastStoredAt: '2026-09-01T00:00:00.001Z',
      overrunCount: 3, lastOverrunAt: '2026-09-01T00:00:00.010Z',
    },
  } }), 'utf8');

  fs.writeFileSync(files.runtime, JSON.stringify({ jobs: {
    'line-a': { state: 'starting', stateDetail: 'Preparing tags…' },
  } }), 'utf8');
  assert.deepEqual(await call((done) => runtime.inspect('line-a', done)), {
    controllerState: 'STARTING', controllerDetail: 'Preparing tags…', statusError: null,
  });
  fs.writeFileSync(files.runtime, JSON.stringify({ jobs: {
    'line-a': {
      state: 'running', lastReadAt: '2026-09-01T00:00:00.000Z', lastStoredAt: '2026-09-01T00:00:00.001Z',
      overrunCount: 3, lastOverrunAt: '2026-09-01T00:00:00.010Z',
    },
  } }), 'utf8');
  assert.deepEqual(await call((done) => runtime.lastRun('line-a', done)), {
    status: 'success',
    lastRunAt: '2026-09-01T00:00:00.000Z',
    lastSuccessfulRunAt: '2026-09-01T00:00:00.000Z',
    lastStoredAt: '2026-09-01T00:00:00.001Z',
    lastError: null,
    overrunCount: 3,
    queueSkipped: 0,
    lastOverrunAt: '2026-09-01T00:00:00.010Z',
    methodCalls: [],
  });
  await call((done) => runtime.stop('line-a', done));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.active, 'utf8')).names, []);
  await call((done) => runtime.stopDaemon(done));
  assert.equal((await call((done) => runtime.daemonStatus(done))).controllerState, 'STOPPED');
  await call((done) => runtime.startDaemon(done));
  await call((done) => runtime.uninstall(done));
  assert.deepEqual(calls.map((entry) => entry[0]), ['install', 'start', 'exec', 'exec', 'exec', 'exec', 'stop', 'start', 'stop', 'uninstall']);
  assert.equal(calls[2][1][0], files.control, 'logical Job control은 OS command(@)이 아닌 JSH script로 실행해야 한다.');
  assert.deepEqual(calls[2][1].slice(-2), ['start', 'line-a']);
  assert.deepEqual(calls[3][1].slice(-2), ['refresh-log', 'line-a']);
  assert.deepEqual(calls[4][1].slice(-2), ['clear-overrun', 'line-a']);
  assert.deepEqual(calls[5][1].slice(-2), ['stop', 'line-a']);
});

test('LS install은 upgrade 중 already exists 응답을 기존 shared service로 처리한다', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-ls-install-race-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'neo-dbus-collector'), 'fixture');
  fs.writeFileSync(path.join(root, 'neo-dbus-launcher.js'), 'fixture');
  fs.writeFileSync(path.join(root, 'neo-dbus-control.js'), 'fixture');
  let statusChecks = 0;
  const runtime = createLsRuntime({
    cgiRoot: root,
    controller: {
      status(_name, callback) {
        statusChecks += 1;
        if (statusChecks === 1) callback(Object.assign(new Error('service not found'), { rpcCode: -32004 }));
        else callback(null, { status: 'STOPPED' });
      },
      install(_descriptor, callback) { callback(new Error('service _dbu_collector already exists')); },
    },
    repository: { list() { return []; } },
    serverStore: {},
  });
  const result = await call((done) => runtime.install(done));
  assert.equal(result.controllerState, 'STOPPED');
  assert.equal(statusChecks, 1);
});

test('LS Profile 참조 보호는 Job별 service가 아니라 logical collector 상태를 사용한다', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-ls-reference-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobs = path.join(root, 'conf.d', 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, 'line-a.json'), JSON.stringify({
    schemaVersion: 1, name: 'line-a', profileId: 'ls-electric-plc',
    methodCalls: [{ id: 'read', methodId: 'get-device-data' }],
  }));
  const analyzer = new ReferenceAnalyzer({
    cgiRoot: root,
    controller: { status() { throw new Error('LS must not query _dbu_<job>'); } },
    stateInspector(_name, callback) { callback(null, { controllerState: 'RUNNING', controllerDetail: null }); },
  });
  const references = analyzer.find('ls-electric-plc', 'get-device-data');
  const states = await call((done) => analyzer.withStates(references, done));
  assert.equal(states[0].controllerState, 'RUNNING');
  assert.equal(states[0].executionState, 'running');
});
