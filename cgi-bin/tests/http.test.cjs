'use strict';

const assert = require('node:assert/strict');
const http = require('../src/cgi/http.js');

const malformed = http.readQuery('%E0%A4%A');
assert.equal(malformed.ok, false);
assert.match(malformed.error.message, /query/i);
assert.deepEqual(http.readQuery('name=alpha+job'), {
  ok: true,
  value: { name: 'alpha job' },
});
assert.deepEqual(http.readBody('{"name":"alpha"}'), {
  ok: true,
  value: { name: 'alpha' },
});
const malformedBody = http.readBody('{"name":');
assert.equal(malformedBody.ok, false);
assert.match(malformedBody.error.message, /JSON/i);
assert.equal(http.statusForError({ kind: 'not_found' }), 404);
assert.equal(http.statusForError({ kind: 'conflict' }), 409);
assert.equal(http.statusForError({ kind: 'controller' }), 503);
assert.equal(http.statusForError(new Error('unexpected')), 500);

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
  error.kind = 'controller';
  http.fail(error, 503, error.kind);
} finally {
  process.stdout.write = originalWrite;
}
const failureBody = JSON.parse(failureOutput.split('\r\n\r\n')[1]);
assert.deepEqual(failureBody, {
  ok: false,
  error: 'controller transition failed',
  kind: 'controller',
});

console.log('CGI query parsing and safe error output: ok');
