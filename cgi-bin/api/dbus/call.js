'use strict';

const path = require('path');
const process = require('process');
const http = require('../../src/cgi/http.js');
const { TestCallManager } = require('../../src/dbus/test-call.js');

function cgiRoot() {
  const script = String(process.argv[1] || '');
  const marker = `${path.sep}cgi-bin${path.sep}`;
  const index = script.indexOf(marker);
  return index < 0 ? path.resolve(process.cwd(), 'cgi-bin') : script.slice(0, index + marker.length - 1);
}

function requestMethod() {
  return String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || '');
}

if (requestMethod() !== 'POST') {
  const failure = new Error('POST 요청만 사용할 수 있습니다.');
  failure.code = 'METHOD_NOT_ALLOWED';
  http.fail(failure, 405);
} else {
  const body = http.readBody();
  if (!body.ok) http.fail(body.error, 400);
  else {
    let payload;
    try {
      payload = http.requireObject(body.value, 'Test Call body');
    } catch (bodyError) {
      http.fail(bodyError, 400);
    }
    if (payload) {
      const factory = http.createFactory(() => new TestCallManager({ cgiRoot: cgiRoot() }));
      if (!factory.ok) http.fail(factory.error);
      else factory.value.call(payload, (callError, result) => {
        if (callError) http.fail(callError);
        else http.reply(200, { ok: true, data: result });
      });
    }
  }
}
