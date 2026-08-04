'use strict';

const path = require('path');
const process = require('process');
const http = require('./http.js');
const { JobManager } = require('../jobs/manager.js');

function cgiRoot() {
  const script = String(process.argv[1] || '');
  const marker = `${path.sep}cgi-bin${path.sep}`;
  const index = script.indexOf(marker);
  return index < 0 ? path.resolve(process.cwd(), 'cgi-bin') : script.slice(0, index + marker.length - 1);
}

function requestMethod() {
  return String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || '');
}

function manager() {
  return http.createFactory(() => new JobManager({ cgiRoot: cgiRoot() }));
}

function result(status) {
  return (operationError, value) => {
    if (operationError) http.fail(operationError);
    else http.reply(status, { ok: true, data: value });
  };
}

function requiredName() {
  const query = http.readQuery();
  if (!query.ok) { http.fail(query.error, 400); return null; }
  try { return http.requireStringFields(query.value, ['name']).name; } catch (queryError) {
    http.fail(queryError, 400);
    return null;
  }
}

function requiredBody(label) {
  const body = http.readBody();
  if (!body.ok) { http.fail(body.error, 400); return null; }
  try { return http.requireObject(body.value, label); } catch (bodyError) {
    http.fail(bodyError, 400);
    return null;
  }
}

function methodNotAllowed(allowed) {
  const failure = new Error(`${allowed.join('/')} 요청만 사용할 수 있습니다.`);
  failure.code = 'METHOD_NOT_ALLOWED';
  http.fail(failure, 405);
}

module.exports = {
  http,
  manager,
  methodNotAllowed,
  requestMethod,
  requiredBody,
  requiredName,
  result,
};
