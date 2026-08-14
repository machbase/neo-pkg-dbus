'use strict';

const process = require('process');
const httpDefault = require('./http.js');
const { createDataViewer } = require('../db/data-viewer.js');
const { createMetadataReader } = require('../db/metadata-reader.js');
const { MAX_SERVER_JSON_BYTES, createServerStore } = require('../db/server-store.js');
const { loadSettings } = require('../config/settings-loader.js');
const { error } = require('../config/errors.js');
const path = require('path');

function requestMethod() {
  return String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || 'GET').toUpperCase();
}

function createDbApi(options) {
  const settings = options || {};
  const http = settings.http || httpDefault;
  const store = settings.store || createServerStore({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir });
  const viewer = settings.viewer || createDataViewer({ cgiRoot: settings.cgiRoot, serverStore: store });
  const metadataReader = settings.metadataReader || createMetadataReader({ clientFactory: settings.clientFactory });
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
    const previewConnection = (payload) => {
      const port = Number(payload?.port);
      if (!payload || typeof payload.host !== 'string' || !payload.host.trim()
        || !Number.isInteger(port) || port < 1 || port > 65535
        || typeof payload.user !== 'string' || !payload.user
        || typeof payload.password !== 'string' || !payload.password) {
        throw error('DB_SERVER_INVALID', 'Database Server 연결 설정이 잘못되었습니다.');
      }
      return { host: payload.host, port, user: payload.user, password: payload.password };
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
          if (params) {
            const defaults = loadSettings(path.join(settings.cgiRoot, 'conf.d', 'settings.json'));
            if (params.name === defaults.defaults.database.server) {
              fail(error('DB_SERVER_DEFAULT_REQUIRED', '기본 Database Server는 다른 기본 서버를 지정하기 전에는 삭제할 수 없습니다.', { name: params.name }), 409);
            } else store.remove(params.name, callback(200));
          }
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
        'preview-tables': { verb: 'POST', method: 'listTables', body: true, target: 'metadata' },
        'preview-columns': { verb: 'POST', method: 'columns', body: true, target: 'metadata' },
        'table-tags': { verb: 'GET', method: 'tags' },
        'table-data': { verb: 'GET', method: 'data', arrays: ['names'] },
        'table-stat': { verb: 'GET', method: 'stat', arrays: ['names'] },
        'table-chart': { verb: 'GET', method: 'chart', arrays: ['names'] },
      };
      const definition = definitions[kind];
      if (!definition) { fail(http.requestError('알 수 없는 DB API입니다.', { kind })); return; }
      if (verb !== definition.verb) { notAllowed([definition.verb]); return; }
      const params = definition.body ? body() : query(definition.arrays);
      if (!params) return;
      if (definition.target === 'metadata') {
        let connection;
        try { connection = previewConnection(params); } catch (previewValidationError) { fail(previewValidationError); return; }
        if (kind === 'preview-tables') {
          metadataReader.listTables(connection, (previewError, result) => {
            if (previewError) { fail(error('DB_UNAVAILABLE', 'Database에 연결할 수 없습니다.')); return; }
            reply(200, { tables: Array.isArray(result?.tables) ? result.tables : [] });
          });
        } else {
          metadataReader.columns(connection, params.table, (previewError, result) => {
            if (previewError) { fail(error('DB_UNAVAILABLE', 'Database에 연결할 수 없습니다.')); return; }
            reply(200, { table: result?.table, tableType: result?.tableType, columns: Array.isArray(result?.columns) ? result.columns : [] });
          });
        }
        return;
      }
      if (kind === 'table-data' && params.includeTotal === 'true') {
        viewer.dataTotal(params, callback(definition.status || 200));
        return;
      }
      viewer[definition.method](params, callback(definition.status || 200));
    } catch (failure) {
      fail(failure);
    }
  }

  return { run };
}

module.exports = { createDbApi, requestMethod };
