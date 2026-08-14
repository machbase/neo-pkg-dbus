'use strict';

const api = require('../../src/cgi/job-api.js');
const factory = api.manager();
if (!factory.ok) api.http.fail(factory.error);
else if (api.requestMethod() !== 'GET') api.methodNotAllowed(['GET']);
else {
  const name = api.requiredName();
  if (name) factory.value.lastRun(name, api.result(200));
}
