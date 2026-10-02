'use strict';

const process = require('process');
const httpDefault = require('./http.js');
const { createDataViewer } = require('../db/data-viewer.js');
const { createMetadataReader } = require('../db/metadata-reader.js');
const {
  DATABASE_PROFILE_LOCK_NAME,
  createDatabaseProfileOperationLock,
  databaseProfileConflict,
} = require('../db/profile-operation-lock.js');
const { validatedExistingMapping } = require('../db/validation-adapter.js');
const { MAX_SERVER_JSON_BYTES, createServerStore } = require('../db/server-store.js');
const { loadSettings } = require('../config/settings-loader.js');
const { loadProductPolicy } = require('../config/product-policy.js');
const { createLsRuntime } = require('../collector/ls-runtime.js');
const { createControllerAdapter } = require('../service/controller-adapter.js');
const { JobRepository } = require('../jobs/repository.js');
const { JobIndexRepository } = require('../jobs/index-repository.js');
const { createTestModeNormalizer } = require('../jobs/test-mode-normalizer.js');
const { error } = require('../config/errors.js');
const path = require('path');

function requestMethod() {
  return String((process.env.get && process.env.get('REQUEST_METHOD')) || process.env.REQUEST_METHOD || 'GET').toUpperCase();
}

function createDbApi(options) {
  const settings = options || {};
  const http = settings.http || httpDefault;
  const store = settings.store || createServerStore({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir });
  const productPolicy = settings.productPolicy || (settings.cgiRoot ? loadProductPolicy(settings.cgiRoot) : null);
  const viewer = settings.viewer || createDataViewer({ cgiRoot: settings.cgiRoot, serverStore: store, productPolicy });
  const metadataReader = settings.metadataReader || createMetadataReader({ clientFactory: settings.clientFactory });
  const method = settings.method || requestMethod;
  const repository = settings.repository || (settings.cgiRoot
    ? new JobRepository({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir }) : null);
  const indexRepository = settings.indexRepository || (settings.cgiRoot
    ? new JobIndexRepository({
      cgiRoot: settings.cgiRoot,
      jobDirectory: repository.directory,
      directory: settings.jobIndexDir,
    }) : null);
  const testModeNormalizer = settings.testModeNormalizer || (
    settings.cgiRoot && productPolicy?.target === 'ls'
      ? createTestModeNormalizer({ cgiRoot: settings.cgiRoot, repository, productPolicy })
      : null
  );
  const databaseProfileLock = settings.databaseProfileLock || (settings.cgiRoot && productPolicy?.target === 'ls'
    ? createDatabaseProfileOperationLock({ cgiRoot: settings.cgiRoot })
    : null);

  function lsRuntime() {
    if (settings.lsRuntime) return settings.lsRuntime;
    if (!settings.cgiRoot) return null;
    const policy = productPolicy || loadProductPolicy(settings.cgiRoot);
    if (policy.target !== 'ls') return null;
    return createLsRuntime({
      cgiRoot: settings.cgiRoot,
      controller: createControllerAdapter(),
      serverStore: store,
      repository,
    });
  }

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
    const normalizeLsProfile = (payload) => {
      const defaultTable = typeof payload.defaultTable === 'string'
        ? payload.defaultTable.trim().toUpperCase() : '';
      return {
        ...payload,
        defaultTable,
        valueColumn: defaultTable
          ? String(payload.valueColumn || 'VALUE').trim().toUpperCase() || 'VALUE'
          : '',
        // LS stores numeric PLC values only. STR_VALUE remains a generic-only
        // option and must not leak back in from an older profile document.
        stringValueColumn: '',
      };
    };
    const hasRegisteredLsJobs = () => {
      if (!indexRepository || typeof indexRepository.list !== 'function') return false;
      return indexRepository.list().length > 0;
    };
    const ensureLsDefaultTable = (profileName, payload, done) => {
      let normalized;
      let connection;
      try {
        normalized = normalizeLsProfile(payload);
        if (!normalized.defaultTable || !hasRegisteredLsJobs()) {
          done(null, normalized);
          return;
        }
        connection = previewConnection(normalized);
      } catch (validationError) { done(validationError); return; }

      const database = {
        server: profileName,
        table: normalized.defaultTable,
        valueColumn: normalized.valueColumn,
        stringValueColumn: '',
      };
      const validateExisting = (metadata) => {
        try {
          validatedExistingMapping(database, metadata, { fractionalValuePossible: false });
          done(null, normalized);
        } catch (mappingError) { done(mappingError); }
      };
      metadataReader.columns(connection, normalized.defaultTable, (metadataError, metadata) => {
        if (metadataError) { done(error('DB_UNAVAILABLE', 'Database Table을 확인할 수 없습니다.', { reason: metadataError.message })); return; }
        if (String(metadata && metadata.tableType || '').toUpperCase() !== 'NOT_FOUND') {
          validateExisting(metadata);
          return;
        }
        metadataReader.createTagTable(connection, normalized.defaultTable, {
          includeStringValueColumn: false,
        }, (createError) => {
          if (!createError) { done(null, normalized); return; }
          if (createError.code !== 'TABLE_ALREADY_EXISTS') { done(createError); return; }
          // Another request may have created the table between metadata lookup
          // and CREATE. Re-read it and accept only the same valid TAG schema.
          metadataReader.columns(connection, normalized.defaultTable, (raceError, raceMetadata) => {
            if (raceError) { done(error('DB_UNAVAILABLE', 'Database Table을 확인할 수 없습니다.', { reason: raceError.message })); return; }
            validateExisting(raceMetadata);
          });
        });
      });
    };

    try {
      const verb = method();
      if (kind === 'server') {
        if (verb === 'GET') {
          const params = query();
          if (params) store.getPublic(params.name, callback(200));
        } else if (verb === 'POST') {
          if (lsRuntime()) { fail(error('LS_DATABASE_PROFILE_FIXED', 'LS에서는 Database 설정을 추가할 수 없습니다. 기존 설정을 수정하십시오.'), 409); return; }
          const payload = body();
          if (payload) store.create(payload, callback(201));
        } else if (verb === 'PUT') {
          const params = query();
          if (!params) return;
          const payload = body();
          if (!payload) return;
          const runtime = lsRuntime();
          if (!runtime) { store.update(params.name, payload, callback(200)); return; }
          let profileHandle = null;
          try {
            if (databaseProfileLock) profileHandle = databaseProfileLock.acquire(DATABASE_PROFILE_LOCK_NAME);
          } catch (lockError) {
            if (lockError && lockError.code === 'JOB_CONFLICT') fail(databaseProfileConflict('update'), 409);
            else fail(lockError);
            return;
          }
          let profileFinished = false;
          const finishProfileUpdate = (failure, value, status) => {
            if (profileFinished) return;
            profileFinished = true;
            let releaseError = null;
            if (profileHandle) {
              try { profileHandle.release(); } catch (cleanupError) { releaseError = cleanupError; }
            }
            if (failure && releaseError && (typeof failure === 'object' || typeof failure === 'function')) {
              failure.cleanupError = releaseError;
            }
            if (failure || releaseError) fail(failure || releaseError, status);
            else reply(200, value);
          };
          let blocked;
          try { blocked = runtime.databaseChangeBlockers(); } catch (stateError) { finishProfileUpdate(stateError); return; }
          if (blocked.length) {
            finishProfileUpdate(error('LS_DATABASE_JOBS_NOT_STOPPED', 'Database 설정을 수정하려면 모든 Job을 먼저 중지해야 합니다.', { jobs: blocked }), null, 409);
            return;
          }
          ensureLsDefaultTable(params.name, payload, (provisionError, normalizedPayload) => {
            if (provisionError) { finishProfileUpdate(provisionError); return; }
            // Table creation/metadata validation can take seconds on a PLC.
            // Recheck after that I/O so a Job started by another request in the
            // meantime cannot race the shared appender profile switch.
            let lateBlocked;
            try { lateBlocked = runtime.databaseChangeBlockers(); } catch (stateError) { finishProfileUpdate(stateError); return; }
            if (lateBlocked.length) {
              finishProfileUpdate(error('LS_DATABASE_JOBS_NOT_STOPPED', 'Database 설정을 수정하려면 모든 Job을 먼저 중지해야 합니다.', { jobs: lateBlocked }), null, 409);
              return;
            }
            store.update(params.name, normalizedPayload, (updateError, value) => {
              if (updateError) { finishProfileUpdate(updateError); return; }
              try {
                // Keep canonical TEST flags consistent with the shared profile
                // before publishing the new daemon snapshot. All Jobs are stopped,
                // so this update does not reload or restart a reader.
                testModeNormalizer?.disableForDatabase(params.name, value.defaultTable);
              } catch (normalizationError) { finishProfileUpdate(normalizationError); return; }
              try { runtime.syncConfig(); } catch (snapshotError) { finishProfileUpdate(snapshotError); return; }
              finishProfileUpdate(null, value);
            });
          });
        } else if (verb === 'DELETE') {
          const params = query();
          if (params) {
            const defaults = loadSettings(path.join(settings.cgiRoot, 'conf.d', 'settings.json'));
            if (params.name === defaults.defaults.database.server) {
              fail(error('DB_SERVER_DEFAULT_REQUIRED', '기본 Database Server는 다른 기본 서버를 지정하기 전에는 삭제할 수 없습니다.', { name: params.name }), 409);
            } else if (lsRuntime()) fail(error('LS_DATABASE_PROFILE_FIXED', 'LS에서는 Database 설정을 삭제할 수 없습니다.'), 409);
            else store.remove(params.name, callback(200));
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
