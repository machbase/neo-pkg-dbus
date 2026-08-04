'use strict';

const api = require('../src/cgi/job-api.js');
const method = api.requestMethod();
const factory = api.manager();

if (!factory.ok) api.http.fail(factory.error);
else if (method === 'GET' || method === 'DELETE') {
  const name = api.requiredName();
  if (name) factory.value[method === 'GET' ? 'get' : 'delete'](name, api.result(200));
} else if (method === 'POST') {
  const body = api.requiredBody('Job create body');
  if (body) {
    const fields = Object.keys(body).filter((key) => !['name', 'config'].includes(key));
    if (fields.length) api.http.fail(api.http.requestError('Job create body에 알 수 없는 필드가 있습니다.', { fields }), 400);
    else factory.value.create(body, api.result(201));
  }
} else if (method === 'PUT') {
  const name = api.requiredName();
  if (name) {
    const body = api.requiredBody('Job patch');
    if (body) factory.value.update(name, body, api.result(200));
  }
} else api.methodNotAllowed(['GET', 'POST', 'PUT', 'DELETE']);
