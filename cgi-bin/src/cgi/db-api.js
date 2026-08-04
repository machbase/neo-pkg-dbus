'use strict';

const process = require('process');
const httpDefault = require('./http.js');
const { createDataViewer } = require('../db/data-viewer.js');
const { MAX_SERVER_JSON_BYTES, createServerStore } = require('../db/server-store.js');

function requestMethod() {
  return String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || 'GET').toUpperCase();
}

function createDbApi(options) {
  const settings = options || {};
  const http = settings.http || httpDefault;
  const store = settings.store || createServerStore({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir });
  const viewer = settings.viewer || createDataViewer({ cgiRoot: settings.cgiRoot, serverStore: store });
  const method = settings.method || requestMethod;

  function run(kind) {
    let responded = false;
    const reply = (status, data) => {
      if (responded) return;
      responded = true;
      http.reply(status, { ok: true, data });
    };
    const fail = (failure, status) => {
      if (responded) return;
      responded = true;
      http.fail(failure, status);
    };
    const callback = (status) => (failure, data) => {
      if (failure) fail(failure);
      else reply(status, data);
    };
    const notAllowed = (allowed) => fail(Object.assign(new Error(`${allowed.join(', ')} 요청만 사용할 수 있습니다.`), {
      code: 'METHOD_NOT_ALLOWED', details: { allowed },
    }), 405);
    const query = (arrayKeys) => {
      const result = http.readQuery(undefined, { arrayKeys: arrayKeys || [] });
      if (!result.ok) { fail(result.error); return null; }
      return result.value;
    };
    const body = () => {
      const result = http.readBody(undefined, { maxBytes: MAX_SERVER_JSON_BYTES });
      if (!result.ok) { fail(result.error); return null; }
      try { return http.requireObject(result.value, 'DB request'); } catch (failure) { fail(failure); return null; }
    };

    try {
      const verb = method();
      if (kind === 'server') {
        if (verb === 'GET') {
          const params = query();
          if (params) store.getPublic(params.name, callback(200));
        } else if (verb === 'POST') {
          const payload = body();
          if (payload) store.create(payload, callback(201));
        } else if (verb === 'PUT') {
          const params = query();
          if (!params) return;
          const payload = body();
          if (payload) store.update(params.name, payload, callback(200));
        } else if (verb === 'DELETE') {
          const params = query();
          if (params) store.remove(params.name, callback(200));
        } else notAllowed(['GET', 'POST', 'PUT', 'DELETE']);
        return;
      }
      if (kind === 'server-list') {
        if (verb !== 'GET') notAllowed(['GET']);
        else store.list(callback(200));
        return;
      }
      const definitions = {
        connect: { verb: 'GET', method: 'connect' },
        'table-create': { verb: 'POST', method: 'createTable', body: true, status: 201 },
        'table-list': { verb: 'GET', method: 'listTables' },
        'table-columns': { verb: 'GET', method: 'columns' },
        'table-tags': { verb: 'GET', method: 'tags' },
        'table-data': { verb: 'GET', method: 'data', arrays: ['names'] },
        'table-chart': { verb: 'GET', method: 'chart', arrays: ['names'] },
      };
      const definition = definitions[kind];
      if (!definition) { fail(http.requestError('알 수 없는 DB API입니다.', { kind })); return; }
      if (verb !== definition.verb) { notAllowed([definition.verb]); return; }
      const params = definition.body ? body() : query(definition.arrays);
      if (params) viewer[definition.method](params, callback(definition.status || 200));
    } catch (failure) {
      fail(failure);
    }
  }

  return { run };
}

module.exports = { createDbApi, requestMethod };
