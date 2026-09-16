'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JobIndexRepository, fromDocument } = require('../src/jobs/index-repository.js');
const { JobManager } = require('../src/jobs/manager.js');

function document(name = 'line-a') {
  return {
    schemaVersion: 1,
    name,
    revision: 7,
    profileId: 'ls-electric-plc',
    schedule: { intervalMs: 10 },
    execution: { savePolicy: 'perMethod', onMethodError: 'stop' },
    methodCalls: [{
      id: 'read-a', interfaceId: 'ls-plc-device', methodId: 'get-device-data',
      outputSelections: [{ tags: [{ name: 'tag-a' }, { name: 'tag-b' }] }],
    }],
    database: { server: 'localhost', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: '' },
    log: { level: 'warn', maxFiles: 3 },
  };
}

test('Job index contains only the bounded management summary', () => {
  const value = fromDocument(document());
  assert.deepEqual(value, {
    schemaVersion: 1,
    name: 'line-a',
    profileId: 'ls-electric-plc',
    revision: 7,
    intervalMs: 10,
    methodCallCount: 1,
    tagCount: 2,
    interfaceIds: ['ls-plc-device'],
    methodReferences: [{ interfaceId: 'ls-plc-device', methodId: 'get-device-data', callId: 'read-a' }],
    database: { server: 'localhost', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: '' },
    execution: { savePolicy: 'perMethod', onMethodError: 'stop' },
    logLevel: 'warn',
  });
  assert.equal(JSON.stringify(value).includes('tag-a'), false);
});

test('Job list recognizes only a complete canonical-file plus index pair', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-index-pairs-'));
  try {
    const jobs = path.join(root, 'conf.d', 'jobs');
    const indexes = new JobIndexRepository({ cgiRoot: root, jobDirectory: jobs });
    fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, 'full-only.json'), '{}');
    indexes.write(document('index-only'));
    fs.writeFileSync(path.join(jobs, 'complete.json'), JSON.stringify(document('complete')));
    indexes.write(document('complete'));
    assert.deepEqual(indexes.list().map((record) => record.name), ['complete']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LS list and status use one overview and never parse the canonical Job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-index-status-'));
  try {
    const jobs = path.join(root, 'conf.d', 'jobs');
    const indexes = new JobIndexRepository({ cgiRoot: root, jobDirectory: jobs });
    fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, 'line-a.json'), '{ deliberately large canonical content is not parsed }');
    indexes.write(document());
    let overviews = 0;
    const controls = [];
    const manager = new JobManager({
      cgiRoot: root,
      repository: {
        directory: jobs,
        file(name) { return path.join(jobs, `${name}.json`); },
        read() { throw new Error('canonical Job must not be read'); },
        list() { throw new Error('canonical Job directory must not be listed'); },
      },
      indexRepository: indexes,
      serverStore: {
        get(name, callback) {
          callback(null, name === 'localhost' ? {
            name, defaultTable: 'CURRENT_TAG', valueColumn: 'CURRENT_VALUE', stringValueColumn: 'CURRENT_STR',
          } : null);
        },
      },
      productPolicy: { target: 'ls', minimumIntervalMs: 1, validationLimits: {}, validateProductConfig(value) { return value; } },
      lsRuntime: {
        ensureRunning(callback) { callback(null, { controllerState: 'RUNNING' }); },
        start(name, callback) { controls.push(['start', name]); callback(null); },
        inspect(_name, callback) { callback(null, { controllerState: 'STARTING', controllerDetail: 'Preparing tags…', statusError: null }); },
        overview(callback) {
          overviews += 1;
          callback(null, {
            service: { controllerState: 'RUNNING', controllerDetail: null, statusError: null },
            runtime: { jobs: { 'line-a': { state: 'running', lastReadAt: '2026-09-11T00:00:00Z', rowsStored: 2 } } },
          });
        },
      },
    });
    const list = await new Promise((resolve, reject) => manager.list((failure, value) => failure ? reject(failure) : resolve(value)));
    assert.equal(list[0].running, true);
    assert.equal(list[0].methodCallCount, 1);
    assert.equal(list[0].tagCount, 2);
    const status = await new Promise((resolve, reject) => manager.status('line-a', (failure, value) => failure ? reject(failure) : resolve(value)));
    assert.equal(status.job.config.schedule.intervalMs, 10);
    assert.deepEqual(status.job.config.database, {
      server: 'localhost', table: 'CURRENT_TAG', valueColumn: 'CURRENT_VALUE', stringValueColumn: 'CURRENT_STR',
    }, 'LS status resolves the current shared Database profile instead of stale Job copies');
    assert.equal(status.lastRun.lastRunAt, '2026-09-11T00:00:00Z');
    assert.equal(overviews, 2, 'each endpoint reads shared service/runtime exactly once');
    const started = await new Promise((resolve, reject) => manager.start('line-a', (failure, value) => failure ? reject(failure) : resolve(value)));
    assert.equal(started.running, true);
    assert.equal(started.controllerState, 'STARTING');
    assert.equal(started.controllerDetail, 'Preparing tags…');
    assert.deepEqual(controls, [['start', 'line-a']], 'LS JSH start sends only logical control after reading the index');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LS detail distinguishes a missing Job from an unsupported full-only Job', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-index-detail-'));
  try {
    const jobs = path.join(root, 'conf.d', 'jobs');
    fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, 'legacy.json'), JSON.stringify(document('legacy')));
    const manager = new JobManager({
      cgiRoot: root,
      productPolicy: { target: 'ls', minimumIntervalMs: 1, validationLimits: {}, validateProductConfig(value) { return value; } },
      lsRuntime: {},
    });
    const getError = (name) => new Promise((resolve) => manager.get(name, (failure) => resolve(failure)));
    assert.equal((await getError('missing')).code, 'JOB_NOT_FOUND');
    const legacyError = await getError('legacy');
    assert.equal(legacyError.code, 'JOB_INVALID_CONFIG');
    assert.equal(legacyError.message, 'This Job configuration cannot be read. Recreate the Job before continuing.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
