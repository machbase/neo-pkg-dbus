'use strict';

const api = require('../../src/cgi/job-api.js');
const factory = api.manager();
if (!factory.ok) api.http.fail(factory.error);
else if (api.requestMethod() !== 'POST') api.methodNotAllowed(['POST']);
else {
  const body = api.requiredBody('Job draft');
  if (body) factory.value.validate(body, api.result(200));
}
