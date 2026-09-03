'use strict';

const path = require('path');
const process = require('process');
const marker = `${path.sep}cgi-bin${path.sep}`;
const root = process.argv[1].slice(0, process.argv[1].indexOf(marker) + marker.length - 1);
const { http, SettingsManager } = require(path.join(root, 'runtime.js'));

function method() {
  return String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || '');
}

const managerFactory = http.createFactory(() => new SettingsManager({ cgiRoot: root }));
if (!managerFactory.ok) {
  http.fail(managerFactory.error);
} else if (method() === 'GET') {
  const manager = managerFactory.value;
  manager.get((error, value) => {
    if (error) http.fail(error);
    else http.reply(200, { ok: true, data: value });
  });
} else if (method() === 'PUT') {
  const manager = managerFactory.value;
  const body = http.readBody();
  if (!body.ok) http.fail(body.error, 400);
  else {
    let payload;
    try {
      payload = http.requireObject(body.value, 'settings request');
    } catch (requestError) {
      http.fail(requestError);
    }
    if (payload) manager.update(payload, (error, value) => {
      if (error) http.fail(error);
      else http.reply(200, { ok: true, data: value });
    });
  }
} else {
  http.fail(Object.assign(new Error('GET 또는 PUT 요청만 사용할 수 있습니다.'), { code: 'METHOD_NOT_ALLOWED' }), 405);
}
