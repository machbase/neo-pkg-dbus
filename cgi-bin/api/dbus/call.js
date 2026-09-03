'use strict';

const path = require('path');
const process = require('process');
const source = String(process.argv[1] || '');
const root = source.slice(0, source.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const runtime = require(path.join(root, 'runtime.js'));
const { http, TestCallManager } = runtime;

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
      const factory = http.createFactory(() => new TestCallManager({ cgiRoot: root }));
      if (!factory.ok) http.fail(factory.error);
      else factory.value.call(payload, (callError, result) => {
        if (callError) http.fail(callError);
        else http.reply(200, { ok: true, data: result });
      });
    }
  }
}
