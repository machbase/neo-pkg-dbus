'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDbApi } = require('../src/cgi/db-api.js');
const { createLogApi } = require('../src/cgi/log-api.js');
const httpDefault = require('../src/cgi/http.js');

function harness(options) {
  const settings = options || {};
  const replies = [];
  const failures = [];
  const http = {
    readQuery() { return settings.queryError ? { ok: false, error: settings.queryError } : { ok: true, value: settings.query || {} }; },
    readBody() { return settings.bodyError ? { ok: false, error: settings.bodyError } : { ok: true, value: settings.body || {} }; },
    requireObject(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('object required'), { code: 'REQUEST_INVALID' });
      return value;
    },
    requestError(reason, details) { return Object.assign(new Error(reason), { code: 'REQUEST_INVALID', details: details || {} }); },
    reply(status, payload) { replies.push({ status, payload }); },
    fail(failure, status) { failures.push({ failure, status }); },
  };
  return { http, replies, failures };
}

function callbackMethod(result, calls, name) {
  return (...args) => {
    calls.push({ name, args: args.slice(0, -1) });
    args[args.length - 1](null, result);
    args[args.length - 1](new Error('late duplicate callback'));
  };
}

function run() {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'api', 'db', 'preview', 'tables.js'), 'utf8'), /runDb\('preview-tables'\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'api', 'db', 'preview', 'columns.js'), 'utf8'), /runDb\('preview-columns'\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'api', 'db', 'table', 'stat.js'), 'utf8'), /runDb\('table-stat'\)/);
  const calls = [];
  const post = harness({ body: { name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret' } });
  createDbApi({
    http: post.http,
    method: () => 'POST',
    store: { create: callbackMethod({ name: 'local-db', hasPassword: true }, calls, 'create') },
    viewer: {},
  }).run('server');
  assert.equal(post.replies.length, 1);
  assert.equal(post.failures.length, 0);
  assert.equal(post.replies[0].status, 201);
  assert.equal(JSON.stringify(post.replies[0]).includes('secret'), false);

  const createDefault = harness({ body: { name: 'default-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret', defaultTable: 'NEW_TAG', valueColumn: '', stringValueColumn: '' } });
  let savedServer = null;
  createDbApi({
    http: createDefault.http,
    method: () => 'POST',
    store: { create(payload, callback) { savedServer = payload; callback(null, { name: payload.name }); } },
    viewer: {},
    metadataReader: {
      columns() { throw new Error('Database Server 저장은 Table metadata를 읽으면 안 됩니다.'); },
      createTagTable() { throw new Error('Database Server 저장은 Table을 만들면 안 됩니다.'); },
    },
  }).run('server');
  assert.equal(createDefault.failures.length, 0);
  assert.equal(savedServer.defaultTable, 'NEW_TAG');
  assert.equal(savedServer.valueColumn, '');
  assert.equal(savedServer.stringValueColumn, '');

  const previewTables = harness({ body: { host: '127.0.0.1', port: 5656, user: 'sys', password: 'preview-secret' } });
  let previewConnection = null;
  createDbApi({
    http: previewTables.http,
    method: () => 'POST',
    store: {},
    viewer: {},
    metadataReader: { listTables(connection, callback) { previewConnection = connection; callback(null, { tables: ['TAG'] }); } },
  }).run('preview-tables');
  assert.equal(previewTables.failures.length, 0);
  assert.deepEqual(previewTables.replies[0].payload.data, { tables: ['TAG'] });
  assert.equal(previewConnection.name, undefined);
  assert.equal(JSON.stringify(previewTables.replies[0]).includes('preview-secret'), false);

  const get = harness({ query: { name: 'local-db' } });
  createDbApi({
    http: get.http,
    method: () => 'GET',
    store: { getPublic: callbackMethod({ name: 'local-db', hasPassword: true }, calls, 'getPublic') },
    viewer: {},
  }).run('server');
  assert.equal(get.replies.length, 1);
  assert.equal(calls.some((call) => call.name === 'getPublic' && call.args[0] === 'local-db'), true);

  const data = harness({ query: { job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'] } });
  createDbApi({
    http: data.http,
    method: () => 'GET',
    store: {},
    viewer: { data: callbackMethod({ rows: [] }, calls, 'data') },
  }).run('table-data');
  assert.equal(data.replies.length, 1);
  assert.deepEqual(calls.find((call) => call.name === 'data').args[0].names, ['%MB3']);

  const total = harness({ query: { job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], includeTotal: 'true', pageSize: '20' } });
  createDbApi({
    http: total.http,
    method: () => 'GET',
    store: {},
    viewer: { dataTotal: callbackMethod({ total: 0, lastPage: 1 }, calls, 'dataTotal') },
  }).run('table-data');
  assert.equal(total.replies.length, 1);
  assert.equal(calls.find((call) => call.name === 'dataTotal').args[0].includeTotal, 'true');

  const stat = harness({ query: { job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'] } });
  createDbApi({
    http: stat.http,
    method: () => 'GET',
    store: {},
    viewer: { stat: callbackMethod({ minTime: null, maxTime: null }, calls, 'stat') },
  }).run('table-stat');
  assert.equal(stat.replies.length, 1);
  assert.deepEqual(calls.find((call) => call.name === 'stat').args[0].names, ['%MB3']);

  const maximumNames = Array.from({ length: 100 }, (_, index) => (
    `태그${String(index).padStart(3, '0')}-${'가'.repeat(94)}`
  ));
  const maximumCursor = encodeURIComponent(JSON.stringify({ side: 'next', page: 1 }));
  const maximumQuery = new URLSearchParams([
    ['job', 'line-a'],
    ...maximumNames.map((name) => ['names', name]),
    ['cursor', maximumCursor],
  ]).toString();
  const maximumGet = harness();
  maximumGet.http.readQuery = (_queryString, options) => httpDefault.readQuery(maximumQuery, options);
  createDbApi({
    http: maximumGet.http,
    method: () => 'GET',
    store: {},
    viewer: { data: callbackMethod({ rows: [] }, calls, 'maximumData') },
  }).run('table-data');
  assert.equal(maximumGet.failures.length, 0);
  assert.equal(maximumGet.replies.length, 1);
  assert.equal(calls.find((call) => call.name === 'maximumData').args[0].names.length, 100);

  const profileChangeRequired = harness({ query: { name: 'local-db' }, body: { name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret', restartRunningJobs: true } });
  let blockedUpdateCalled = false;
  const activeRuntime = { databaseChangeBlockers() { return ['line-a', 'line-b']; } };
  createDbApi({
    http: profileChangeRequired.http,
    method: () => 'PUT',
    store: { update() { blockedUpdateCalled = true; } }, viewer: {}, lsRuntime: activeRuntime,
  }).run('server');
  assert.equal(profileChangeRequired.failures.length, 1);
  assert.equal(profileChangeRequired.failures[0].failure.code, 'LS_DATABASE_JOBS_NOT_STOPPED');
  assert.deepEqual(profileChangeRequired.failures[0].failure.details.jobs, ['line-a', 'line-b']);
  assert.equal(profileChangeRequired.failures[0].status, 409);
  assert.equal(blockedUpdateCalled, false, 'restartRunningJobs must not bypass the stopped-Job guard');

  const profileChange = harness({ query: { name: 'local-db' }, body: { name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret' } });
  const profileChangeOrder = [];
  createDbApi({
    http: profileChange.http,
    method: () => 'PUT',
    databaseProfileLock: {
      acquire(name) {
        profileChangeOrder.push(`lock:${name}`);
        return { release() { profileChangeOrder.push('unlock'); } };
      },
    },
    store: {
      update(_name, payload, callback) {
        profileChangeOrder.push('store');
        callback(null, { name: payload.name, defaultTable: 'TAG' });
      },
    },
    viewer: {},
    testModeNormalizer: {
      disableForDatabase(name, table) {
        profileChangeOrder.push(`normalize:${name}:${table}`);
        return ['line-a'];
      },
    },
    lsRuntime: {
      databaseChangeBlockers() { return []; },
      syncConfig() { profileChangeOrder.push('sync'); },
    },
  }).run('server');
  assert.equal(profileChange.failures.length, 0);
  assert.equal(profileChange.replies[0].status, 200);
  assert.deepEqual(profileChangeOrder, [
    'lock:ls-shared-database-profile',
    'store', 'normalize:local-db:TAG', 'sync', 'unlock',
  ]);

  const profileSaveConflict = harness({
    query: { name: 'local-db' },
    body: { name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret' },
  });
  let profileConflictTouchedRuntime = false;
  createDbApi({
    http: profileSaveConflict.http,
    method: () => 'PUT',
    store: { update() { throw new Error('conflicting save must not reach the store'); } },
    viewer: {},
    databaseProfileLock: {
      acquire() { throw Object.assign(new Error('busy'), { code: 'JOB_CONFLICT' }); },
    },
    lsRuntime: {
      databaseChangeBlockers() { profileConflictTouchedRuntime = true; return []; },
      syncConfig() {},
    },
  }).run('server');
  assert.equal(profileSaveConflict.replies.length, 0);
  assert.equal(profileSaveConflict.failures.length, 1);
  assert.equal(profileSaveConflict.failures[0].failure.code, 'JOB_CONFLICT');
  assert.match(profileSaveConflict.failures[0].failure.message, /모든 Job을 중지한 후 다시 저장/);
  assert.equal(profileConflictTouchedRuntime, false);

  const profileCreateTable = harness({
    query: { name: 'local-db' },
    body: {
      name: 'local-db', host: '10.0.0.5', port: 5656, user: 'sys', password: 'secret',
      defaultTable: 'new_tag', valueColumn: '', stringValueColumn: 'LEGACY_STR',
    },
  });
  const profileCreateOrder = [];
  let createdTableArgs = null;
  let storedProfilePayload = null;
  createDbApi({
    http: profileCreateTable.http,
    method: () => 'PUT',
    store: {
      update(_name, payload, callback) {
        profileCreateOrder.push('store');
        storedProfilePayload = payload;
        callback(null, {
          name: 'local-db', defaultTable: payload.defaultTable,
          valueColumn: payload.valueColumn, stringValueColumn: payload.stringValueColumn,
        });
      },
    },
    viewer: {},
    indexRepository: { list() { return [{ name: 'line-a', index: {} }]; } },
    metadataReader: {
      columns(connection, table, callback) {
        profileCreateOrder.push('columns');
        assert.deepEqual(connection, { host: '10.0.0.5', port: 5656, user: 'sys', password: 'secret' });
        callback(null, { table, tableType: 'NOT_FOUND', columns: [] });
      },
      createTagTable(connection, table, options, callback) {
        profileCreateOrder.push('create');
        createdTableArgs = { connection, table, options };
        callback(null, { table, valueColumn: 'VALUE', stringValueColumn: '' });
      },
    },
    testModeNormalizer: { disableForDatabase() { profileCreateOrder.push('normalize'); } },
    lsRuntime: {
      databaseChangeBlockers() { return []; },
      syncConfig() { profileCreateOrder.push('sync'); },
    },
  }).run('server');
  assert.equal(profileCreateTable.failures.length, 0);
  assert.deepEqual(profileCreateOrder, ['columns', 'create', 'store', 'normalize', 'sync']);
  assert.equal(createdTableArgs.table, 'NEW_TAG');
  assert.deepEqual(createdTableArgs.options, { includeStringValueColumn: false });
  assert.equal(storedProfilePayload.defaultTable, 'NEW_TAG');
  assert.equal(storedProfilePayload.valueColumn, 'VALUE');
  assert.equal(storedProfilePayload.stringValueColumn, '');

  const profileNoJobs = harness({
    query: { name: 'local-db' },
    body: {
      name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret',
      defaultTable: 'later_tag', valueColumn: '', stringValueColumn: '',
    },
  });
  let noJobsStored = null;
  createDbApi({
    http: profileNoJobs.http,
    method: () => 'PUT',
    store: { update(_name, payload, callback) { noJobsStored = payload; callback(null, payload); } },
    viewer: {},
    indexRepository: { list() { return []; } },
    metadataReader: {
      columns() { throw new Error('No Job means table creation must be deferred.'); },
      createTagTable() { throw new Error('No Job means table creation must be deferred.'); },
    },
    lsRuntime: { databaseChangeBlockers() { return []; }, syncConfig() {} },
  }).run('server');
  assert.equal(profileNoJobs.failures.length, 0);
  assert.equal(noJobsStored.defaultTable, 'LATER_TAG');
  assert.equal(noJobsStored.valueColumn, 'VALUE');
  assert.equal(noJobsStored.stringValueColumn, '');

  const profileInvalidTable = harness({
    query: { name: 'local-db' },
    body: {
      name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret',
      defaultTable: 'wrong_tag', valueColumn: 'VALUE', stringValueColumn: '',
    },
  });
  let invalidTableStored = false;
  createDbApi({
    http: profileInvalidTable.http,
    method: () => 'PUT',
    store: { update() { invalidTableStored = true; } },
    viewer: {},
    indexRepository: { list() { return [{ name: 'line-a', index: {} }]; } },
    metadataReader: {
      columns(_connection, table, callback) {
        callback(null, {
          table, tableType: 'TAG',
          columns: [
            { name: 'NAME', type: 'varchar(100)', primaryKey: true },
            { name: 'TIME', type: 'datetime', basetime: true },
            { name: 'TEXT_VALUE', type: 'varchar(100)' },
          ],
        });
      },
    },
    lsRuntime: { databaseChangeBlockers() { return []; }, syncConfig() {} },
  }).run('server');
  assert.equal(profileInvalidTable.replies.length, 0);
  assert.equal(profileInvalidTable.failures.length, 1);
  assert.match(profileInvalidTable.failures[0].failure.message, /숫자 column/);
  assert.equal(invalidTableStored, false, 'invalid table must not replace the working profile');

  const profileLateStart = harness({
    query: { name: 'local-db' },
    body: {
      name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'secret',
      defaultTable: 'new_tag', valueColumn: 'VALUE', stringValueColumn: '',
    },
  });
  let lateStartChecks = 0;
  let lateStartStored = false;
  createDbApi({
    http: profileLateStart.http,
    method: () => 'PUT',
    store: { update() { lateStartStored = true; } },
    viewer: {},
    indexRepository: { list() { return [{ name: 'line-a', index: {} }]; } },
    metadataReader: {
      columns(_connection, table, callback) {
        callback(null, {
          table, tableType: 'TAG',
          columns: [
            { name: 'NAME', type: 'varchar(100)', primaryKey: true },
            { name: 'TIME', type: 'datetime', basetime: true },
            { name: 'VALUE', type: 'double' },
          ],
        });
      },
    },
    lsRuntime: {
      databaseChangeBlockers() {
        lateStartChecks += 1;
        return lateStartChecks === 1 ? [] : ['line-a'];
      },
      syncConfig() {},
    },
  }).run('server');
  assert.equal(profileLateStart.failures.length, 1);
  assert.equal(profileLateStart.failures[0].failure.code, 'LS_DATABASE_JOBS_NOT_STOPPED');
  assert.deepEqual(profileLateStart.failures[0].failure.details.jobs, ['line-a']);
  assert.equal(lateStartStored, false, 'a Job started during provisioning must keep the previous profile');

  const wrongMethod = harness();
  createDbApi({ http: wrongMethod.http, method: () => 'POST', store: {}, viewer: {} }).run('table-data');
  assert.equal(wrongMethod.failures.length, 1);
  assert.equal(wrongMethod.failures[0].status, 405);

  const logs = harness({ query: { name: 'line-a', file: 'line-a.log', lines: '20' } });
  createLogApi({
    http: logs.http,
    method: () => 'GET',
    reader: { tail: callbackMethod({ lines: ['safe'] }, calls, 'tail') },
  }).run('tail');
  assert.equal(logs.replies.length, 1);
  assert.equal(calls.some((call) => call.name === 'tail' && call.args[0].name === 'line-a'), true);

  const logPost = harness();
  createLogApi({ http: logPost.http, method: () => 'POST', reader: {} }).run('all');
  assert.equal(logPost.failures.length, 1);
  assert.equal(logPost.failures[0].status, 405);
}

run();
console.log('DB and Log CGI dispatch contract: ok');
