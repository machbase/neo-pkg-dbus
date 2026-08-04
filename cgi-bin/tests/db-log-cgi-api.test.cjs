'use strict';

const assert = require('node:assert/strict');
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
