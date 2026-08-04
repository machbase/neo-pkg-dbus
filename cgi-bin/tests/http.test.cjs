'use strict';

const assert = require('node:assert/strict');
const http = require('../src/cgi/http.js');

const MAX_QUERY_BYTES = 128 * 1024;

const malformed = http.readQuery('%E0%A4%A');
assert.equal(malformed.ok, false);
assert.match(malformed.error.message, /query/i);
assert.deepEqual(http.readQuery('name=alpha+job'), {
  ok: true,
  value: { name: 'alpha job' },
});
assert.deepEqual(http.readQuery('names=a&names=b', { arrayKeys: ['names'] }), {
  ok: true,
  value: { names: ['a', 'b'] },
});
assert.equal(http.MAX_QUERY_BYTES, MAX_QUERY_BYTES);
const maximumNames = Array.from({ length: 100 }, (_, index) => (
  `tag-${String(index).padStart(3, '0')}-${'x'.repeat(92)}`
));
assert.equal(maximumNames.every((name) => name.length === 100), true);
const maximumCursor = encodeURIComponent(JSON.stringify({ side: 'next', page: 1 }));
const maximumQuery = new URLSearchParams([
  ['job', 'line-a'],
  ...maximumNames.map((name) => ['names', name]),
  ['cursor', maximumCursor],
]).toString();
assert.equal(Buffer.byteLength(maximumQuery, 'utf8') < MAX_QUERY_BYTES, true);
const maximumParsed = http.readQuery(maximumQuery, { arrayKeys: ['names'] });
assert.equal(maximumParsed.ok, true);
assert.equal(maximumParsed.value.names.length, 100);
assert.equal(maximumParsed.value.names.every((name) => name.length === 100), true);
assert.equal(maximumParsed.value.cursor, maximumCursor);
const maximumUnicodeNames = Array.from({ length: 100 }, (_, index) => (
  `태그${String(index).padStart(3, '0')}-${'가'.repeat(94)}`
));
assert.equal(maximumUnicodeNames.every((name) => name.length === 100), true);
const maximumUnicodeQuery = new URLSearchParams([
  ['job', 'line-a'],
  ...maximumUnicodeNames.map((name) => ['names', name]),
  ['cursor', maximumCursor],
]).toString();
assert.equal(Buffer.byteLength(maximumUnicodeQuery, 'utf8') > 64 * 1024, true);
assert.equal(Buffer.byteLength(maximumUnicodeQuery, 'utf8') < MAX_QUERY_BYTES, true);
const maximumUnicodeParsed = http.readQuery(maximumUnicodeQuery, { arrayKeys: ['names'] });
assert.equal(maximumUnicodeParsed.ok, true);
assert.deepEqual(maximumUnicodeParsed.value.names, maximumUnicodeNames);
const oversizedQuery = http.readQuery(`value=${'x'.repeat(MAX_QUERY_BYTES)}`);
assert.equal(oversizedQuery.ok, false);
assert.equal(oversizedQuery.error.code, 'REQUEST_TOO_LARGE');
assert.deepEqual(http.readBody('{"name":"alpha"}'), {
  ok: true,
  value: { name: 'alpha' },
});
const malformedBody = http.readBody('{"name":');
assert.equal(malformedBody.ok, false);
assert.match(malformedBody.error.message, /JSON/i);
const oversizedBody = http.readBody(JSON.stringify({ body: 'x'.repeat(20) }), { maxBytes: 10 });
assert.equal(oversizedBody.ok, false);
assert.equal(oversizedBody.error.code, 'REQUEST_TOO_LARGE');
assert.equal(http.statusForError({ kind: 'not_found' }), 404);
assert.equal(http.statusForError({ kind: 'conflict' }), 409);
assert.equal(http.statusForError({ kind: 'controller' }), 503);
assert.equal(http.statusForError({ code: 'PROFILE_INVALID' }), 400);
assert.equal(http.statusForError({ code: 'PROFILE_NOT_FOUND' }), 404);
assert.equal(http.statusForError({ code: 'PROFILE_ALREADY_EXISTS' }), 409);
assert.equal(http.statusForError({ code: 'PROFILE_NOT_AVAILABLE' }), 409);
assert.equal(http.statusForError({ code: 'PROFILE_DEFAULT' }), 409);
assert.equal(http.statusForError({ code: 'PROFILE_IN_USE_BY_RUNNING_JOB' }), 409);
assert.equal(http.statusForError({ code: 'JOB_INVALID_CONFIG' }), 409);
assert.equal(http.statusForError({ code: 'JOB_REVISION_REQUIRED' }), 400);
assert.equal(http.statusForError({ code: 'TIMEZONE_UNSUPPORTED' }), 400);
assert.equal(http.statusForError({ code: 'JOB_CONFLICT' }), 409);
assert.equal(http.statusForError(new Error('unexpected')), 500);
assert.equal(http.statusForError({ code: 'LOG_TOO_LARGE' }), 413);
assert.equal(http.statusForError({ code: 'DB_SERVER_CREATE_LOCKED' }), 409);

const failed = http.fail;
assert.equal(String(failed).includes('.stack'), false);
assert.equal(String(failed).includes('stack:'), false);

let failureOutput = '';
const originalWrite = process.stdout.write;
process.stdout.write = (chunk) => {
  failureOutput += String(chunk);
  return true;
};
try {
  const error = new Error('controller transition failed');
  error.code = 'CONTROLLER_UNAVAILABLE';
  error.details = { controllerState: 'UNKNOWN' };
  http.fail(error);
} finally {
  process.stdout.write = originalWrite;
}
const failureBody = JSON.parse(failureOutput.split('\r\n\r\n')[1]);
assert.deepEqual(failureBody, {
  ok: false,
  code: 'CONTROLLER_UNAVAILABLE',
  reason: 'controller transition failed',
  details: { controllerState: 'UNKNOWN' },
});

let secretOutput = '';
process.stdout.write = (chunk) => { secretOutput += String(chunk); return true; };
try {
  const error = new Error('connection failed password=secret');
  error.code = 'DB_UNAVAILABLE';
  error.details = { password: 'secret', nested: { token: 'secret-token' } };
  http.fail(error);
} finally {
  process.stdout.write = originalWrite;
}
assert.equal(secretOutput.includes('secret'), false);
assert.deepEqual(JSON.parse(secretOutput.split('\r\n\r\n')[1]).details, {
  password: '[REDACTED]', nested: { token: '[REDACTED]' },
});

console.log('CGI query parsing and safe error output: ok');
