'use strict';

const { error } = require('../config/errors.js');

const NUMERIC_TYPES = new Set([
  'byte', 'short', 'ushort', 'integer', 'int', 'uint', 'long', 'ulong',
  'float', 'double', 'number', 'numeric', 'decimal',
]);
const STRING_TYPES = new Set(['char', 'varchar', 'text', 'clob', 'string']);

function defaultDependencies(options) {
  const settings = options || {};
  const serverModule = require('./server-store.js');
  const metadataModule = require('./metadata-reader.js');
  const dataViewerModule = require('./data-viewer.js');
  const serverStore = serverModule.createServerStore({ cgiRoot: settings.cgiRoot });
  return {
    serverStore,
    metadataReader: metadataModule.createMetadataReader({ cgiRoot: settings.cgiRoot }),
    tableCreator: dataViewerModule.createDataViewer({ cgiRoot: settings.cgiRoot, serverStore }),
  };
}

function unavailable(reason) {
  return error('DB_UNAVAILABLE', 'DB 설정을 확인할 수 없습니다.', {
    reason: reason && reason.message ? reason.message : String(reason || 'DB dependency unavailable'),
  });
}

function invalid(reason, details) {
  return error('JOB_INVALID', reason, details);
}

function callDependency(target, method, args, callback) {
  let completed = false;
  const done = (dependencyError, value) => {
    if (completed) return;
    completed = true;
    callback(dependencyError, value);
  };
  try {
    if (!target || typeof target[method] !== 'function') {
      done(new Error(`DB adapter dependency ${method}()을 사용할 수 없습니다.`));
      return;
    }
    target[method](...args, done);
  } catch (dependencyError) {
    done(dependencyError);
  }
}

function columnByName(columns, name) {
  const expected = String(name || '').toUpperCase();
  return columns.find((column) => String(column && column.name || '').toUpperCase() === expected) || null;
}

function typeOf(column) {
  return String(column && column.type || '').toLowerCase().replace(/\(.*/, '');
}

function createDatabaseValidationAdapter(options) {
  const settings = options || {};
  let dependencies = null;
  let dependencyError = null;
  try {
    dependencies = settings.serverStore && settings.metadataReader
      ? settings
      : (settings.loadDependencies || defaultDependencies)(settings);
    if (!dependencies || !dependencies.serverStore || !dependencies.metadataReader) {
      throw new Error('DB validation dependencies가 없습니다.');
    }
  } catch (loadError) {
    dependencyError = loadError;
  }

  return {
    validate(database, callback) {
      if (dependencyError) { callback(unavailable(dependencyError)); return; }
      callDependency(dependencies.serverStore, 'get', [database.server], (serverError, server) => {
        if (serverError) { callback(unavailable(serverError)); return; }
        if (!server) {
          callback(invalid('등록된 DB server를 찾을 수 없습니다.', { server: database.server }));
          return;
        }
        callDependency(dependencies.metadataReader, 'columns', [server, database.table], (metadataError, metadata) => {
          if (metadataError) { callback(unavailable(metadataError)); return; }
          const columns = metadata && metadata.columns;
          if (!metadata || String(metadata.tableType || '').toUpperCase() !== 'TAG' || !Array.isArray(columns)) {
            callback(invalid('선택한 table은 TAG table이어야 합니다.', { table: database.table }));
            return;
          }
          const primary = columns.find((column) => column && (column.primaryKey === true || column.primary === true));
          const basetime = columns.find((column) => column && column.basetime === true);
          const valueColumn = columnByName(columns, database.valueColumn);
          const configuredStringColumn = String(database.stringValueColumn || '').trim();
          const stringColumn = configuredStringColumn ? columnByName(columns, configuredStringColumn) : null;
          if (!primary || !STRING_TYPES.has(typeOf(primary))) {
            callback(invalid('TAG name primary column을 찾을 수 없습니다.', { table: database.table }));
            return;
          }
          if (!basetime) {
            callback(invalid('TAG basetime column을 찾을 수 없습니다.', { table: database.table }));
            return;
          }
          if (!valueColumn || !NUMERIC_TYPES.has(typeOf(valueColumn))) {
            callback(invalid('database.valueColumn은 숫자 column이어야 합니다.', { valueColumn: database.valueColumn }));
            return;
          }
          if (configuredStringColumn && (!stringColumn || !STRING_TYPES.has(typeOf(stringColumn)))) {
            callback(invalid('database.stringValueColumn은 문자열 column이어야 합니다.', {
              stringValueColumn: database.stringValueColumn,
            }));
            return;
          }
          callback(null, {
            server: database.server,
            table: database.table,
            tagNameColumn: primary.name,
            basetimeColumn: basetime.name,
            valueColumn: valueColumn.name,
            stringValueColumn: stringColumn ? stringColumn.name : null,
          });
        });
      });
    },
    ensure(database, options, callback) {
      if (dependencyError) { callback(unavailable(dependencyError)); return; }
      callDependency(dependencies.serverStore, 'get', [database.server], (serverError, server) => {
        if (serverError) { callback(unavailable(serverError)); return; }
        if (!server) {
          callback(invalid('등록된 DB server를 찾을 수 없습니다.', { server: database.server }));
          return;
        }
        callDependency(dependencies.metadataReader, 'columns', [server, database.table], (metadataError, metadata) => {
          if (metadataError) { callback(unavailable(metadataError)); return; }
          if (!metadata || !metadata.tableType) {
            callback(unavailable(new Error('DB Table 조회 결과가 비어 있습니다.')));
            return;
          }
          if (String(metadata.tableType).toUpperCase() !== 'NOT_FOUND') {
            database.table = String(database.table).trim().toUpperCase();
            database.valueColumn = String(database.valueColumn).trim().toUpperCase();
            database.stringValueColumn = String(database.stringValueColumn || '').trim().toUpperCase();
            callback(null, {
              server: database.server,
              table: database.table,
              valueColumn: database.valueColumn,
              stringValueColumn: database.stringValueColumn,
            });
            return;
          }
          if (!dependencies.tableCreator) { callback(unavailable(new Error('DB table creator를 사용할 수 없습니다.'))); return; }
          // A table created from a Job always has the package's fixed TAG
          // columns needed by the final output mappings. Client-provided column
          // names only apply to existing tables.
          const needsStringValueColumn = options && options.needsStringValueColumn === true;
          database.valueColumn = 'VALUE';
          database.stringValueColumn = needsStringValueColumn ? 'STR_VALUE' : '';
          database.table = String(database.table).trim().toUpperCase();
          const request = {
            server: database.server,
            table: database.table,
            valueColumn: 'VALUE',
            stringValueColumn: needsStringValueColumn ? 'STR_VALUE' : null,
          };
          callDependency(dependencies.tableCreator, 'createTable', [request], (createError, created) => {
            if (createError && createError.code !== 'TABLE_ALREADY_EXISTS') { callback(createError); return; }
            database.table = String(created && created.table || request.table).trim().toUpperCase();
            const complete = () => callback(null, {
              server: database.server,
              table: database.table,
              valueColumn: database.valueColumn,
              stringValueColumn: database.stringValueColumn,
            });
            if (createError || typeof dependencies.serverStore.setDefaultTableColumns !== 'function'
              || String(server.defaultTable || '').trim().toUpperCase() !== database.table) {
              complete();
              return;
            }
            callDependency(dependencies.serverStore, 'setDefaultTableColumns', [
              database.server, database.table, database.valueColumn, database.stringValueColumn,
            ], (defaultError) => {
              if (defaultError) { callback(defaultError); return; }
              complete();
            });
          });
        });
      });
    },
  };
}

module.exports = { createDatabaseValidationAdapter };
