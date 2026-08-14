'use strict';

const process = require('process');
const httpDefault = require('./http.js');
const { createLogReader } = require('../log/reader.js');

function requestMethod() {
  return String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || 'GET').toUpperCase();
}

function createLogApi(options) {
  const settings = options || {};
  const http = settings.http || httpDefault;
  const reader = settings.reader || createLogReader({ cgiRoot: settings.cgiRoot, logDir: settings.logDir });
  const method = settings.method || requestMethod;

  function run(kind) {
    let responded = false;
    const fail = (failure, status) => {
      if (responded) return;
      responded = true;
      http.fail(failure, status);
    };
    const callback = (failure, data) => {
      if (responded) return;
      responded = true;
      if (failure) http.fail(failure);
      else http.reply(200, { ok: true, data });
    };
    if (method() !== 'GET') {
      fail(Object.assign(new Error('GET 요청만 사용할 수 있습니다.'), {
        code: 'METHOD_NOT_ALLOWED', details: { allowed: ['GET'] },
      }), 405);
      return;
    }
    const methods = {
      all: 'all', list: 'list', content: 'content', 'content-all': 'contentAll', tail: 'tail',
    };
    const target = methods[kind];
    if (!target) { fail(http.requestError('알 수 없는 Log API입니다.', { kind })); return; }
    try {
      if (kind === 'all') reader.all(callback);
      else {
        const parsed = http.readQuery();
        if (!parsed.ok) fail(parsed.error);
        else reader[target](parsed.value, callback);
      }
    } catch (failure) { fail(failure); }
  }

  return { run };
}

module.exports = { createLogApi, requestMethod };
