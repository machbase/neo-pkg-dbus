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
  const query = api.http.readQuery();
  if (!query.ok) api.http.fail(query.error, 400);
  else {
    const fields = Object.keys(query.value).filter((field) => !['destination', 'interfacePrefix'].includes(field));
    if (fields.length) api.http.fail(api.http.requestError('알 수 없는 query parameter가 있습니다.', { fields }), 400);
    else factory.value.intervalPolicy(query.value.destination, query.value.interfacePrefix, api.result(200));
  }
}
