'use strict';

const path = require('path');
const process = require('process');
const source = String(process.argv[1] || '');
const root = source.slice(0, source.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const api = require(path.join(root, 'runtime.js')).jobApi;
const factory = api.manager();
if (!factory.ok) api.http.fail(factory.error);
else if (api.requestMethod() !== 'GET') api.methodNotAllowed(['GET']);
else {
  const name = api.requiredName();
  if (name) factory.value.lastRun(name, api.result(200));
}
