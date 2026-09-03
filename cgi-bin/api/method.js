'use strict';

const path = require('path');
const process = require('process');
const marker = `${path.sep}cgi-bin${path.sep}`;
const root = process.argv[1].slice(0, process.argv[1].indexOf(marker) + marker.length - 1);
const { http, ProfileManager } = require(path.join(root, 'runtime.js'));

const requestMethod = String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || '');
const managerFactory = http.createFactory(() => new ProfileManager({ cgiRoot: root }));

function result(status) {
  return (error, value) => {
    if (error) http.fail(error);
    else http.reply(status, { ok: true, data: value });
  };
}

if (!managerFactory.ok) {
  http.fail(managerFactory.error);
} else if (requestMethod === 'GET' || requestMethod === 'DELETE') {
  const manager = managerFactory.value;
  const query = http.readQuery();
  if (!query.ok) http.fail(query.error, 400);
  else {
    let parameters;
    try {
      parameters = http.requireStringFields(query.value, ['profileId', 'id']);
    } catch (requestError) {
      http.fail(requestError);
    }
    if (parameters && requestMethod === 'GET') manager.getMethod(parameters.profileId, parameters.id, result(200));
    else if (parameters) manager.deleteMethod(parameters.profileId, parameters.id, result(200));
  }
} else if (requestMethod === 'POST' || requestMethod === 'PUT') {
  const manager = managerFactory.value;
  const body = http.readBody();
  if (!body.ok) http.fail(body.error, 400);
  else {
    let payload;
    try {
      payload = http.requireStringFields(body.value, ['profileId']);
      http.requireObject(payload.method, 'method');
    } catch (requestError) {
      http.fail(requestError);
    }
    if (payload && requestMethod === 'POST') manager.createMethod(payload.profileId, payload.method, result(201));
    else if (payload) manager.updateMethod(payload.profileId, payload.method, result(200));
  }
} else {
  http.fail(Object.assign(new Error('지원하지 않는 요청 method입니다.'), { code: 'METHOD_NOT_ALLOWED' }), 405);
}
