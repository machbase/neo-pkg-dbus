'use strict';

const path = require('path');
const process = require('process');
const source = String(process.argv[1] || '');
const root = source.slice(0, source.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const api = require(path.join(root, 'runtime.js')).jobApi;
const factory = api.manager();

if (!factory.ok) api.http.fail(factory.error);
else if (api.requestMethod() !== 'PUT') api.methodNotAllowed(['PUT']);
else {
  const name = api.requiredName();
  const body = name && api.requiredBody('Log Level patch', factory.value.requestJsonMaxBytes());
  if (name && body) factory.value.updateLog(name, body, api.result(200));
}
