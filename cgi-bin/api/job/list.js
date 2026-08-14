'use strict';

const api = require('../../src/cgi/job-api.js');
const factory = api.manager();
if (!factory.ok) api.http.fail(factory.error);
else if (api.requestMethod() !== 'GET') api.methodNotAllowed(['GET']);
else factory.value.list(api.result(200));
