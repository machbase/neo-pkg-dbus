'use strict';

const path = require('path');
const process = require('process');
const marker = `${path.sep}cgi-bin${path.sep}`;
const root = process.argv[1].slice(0, process.argv[1].indexOf(marker) + marker.length - 1);
const http = require(path.join(root, 'src', 'cgi', 'http.js'));
const { ProfileManager } = require(path.join(root, 'src', 'profiles', 'manager.js'));

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
      parameters = http.requireStringFields(query.value, ['id']);
    } catch (requestError) {
      http.fail(requestError);
    }
    if (parameters && requestMethod === 'GET') manager.getProfile(parameters.id, result(200));
    else if (parameters) manager.deleteProfile(parameters.id, result(200));
  }
} else if (requestMethod === 'POST' || requestMethod === 'PUT') {
  const manager = managerFactory.value;
  const body = http.readBody();
  if (!body.ok) http.fail(body.error, 400);
  else {
    let payload;
    try {
      payload = http.requireObject(body.value, 'profile request');
    } catch (requestError) {
      http.fail(requestError);
    }
    if (payload && requestMethod === 'POST') manager.createProfile(payload, result(201));
    else if (payload) manager.updateProfile(payload, result(200));
  }
} else {
  http.fail(Object.assign(new Error('지원하지 않는 요청 method입니다.'), { code: 'METHOD_NOT_ALLOWED' }), 405);
}
