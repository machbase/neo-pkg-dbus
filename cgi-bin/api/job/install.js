'use strict';

const api = require('../../src/cgi/job-api.js');
const factory = api.manager();
if (!factory.ok) api.http.fail(factory.error);
else if (api.requestMethod() !== 'POST') api.methodNotAllowed(['POST']);
else {
  const name = api.requiredName();
  if (name) factory.value.install(name, api.result(200));
}
