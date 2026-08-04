'use strict';

const { error } = require('../config/errors.js');
const { createServerStore } = require('./server-store.js');

const FLAG_BASETIME = 0x1000000;
const FLAG_PRIMARY = 0x8000000;

function defaultClientFactory(config) {
  const machcli = require('machcli');
  if (!machcli || typeof machcli.Client !== 'function') throw new Error('machcli.Client를 사용할 수 없습니다.');
  return new machcli.Client(config);
}

function serverConfig(server) {
  const source = server && server.connection && typeof server.connection === 'object' ? server.connection : server;
  return { host: source.host, port: source.port, user: source.user, password: source.password };
}

function rowsOf(source) {
  if (Array.isArray(source)) return source;
  const rows = [];
  if (source) for (const row of source) rows.push(row);
  return rows;
}

function columnByName(columns, name) {
  const expected = String(name || '').toUpperCase();
  return columns.find((column) => String(column && column.name || '').toUpperCase() === expected) || null;
}

function createMachbaseAppender(options) {
  const settings = options || {};
  const store = settings.serverStore || createServerStore({ cgiRoot: settings.cgiRoot });
  const clientFactory = settings.clientFactory || defaultClientFactory;
  let client = null;
  let connection = null;
  let appender = null;
  let columns = [];
  let mapping = null;

  function close() {
    try { if (appender && typeof appender.close === 'function') appender.close(); } catch (_) {}
    try { if (connection && typeof connection.close === 'function') connection.close(); } catch (_) {}
    try { if (client && typeof client.close === 'function') client.close(); } catch (_) {}
    appender = null;
    connection = null;
    client = null;
    columns = [];
    mapping = null;
  }

  return {
    open(database) {
      close();
      let server;
      let storeError;
      let called = false;
      store.get(database.server, (readError, value) => { called = true; storeError = readError; server = value; });
      if (!called) throw error('DB_APPEND_FAILED', '등록 DB server 읽기는 동기 완료되어야 합니다.');
      if (storeError) throw error('DB_APPEND_FAILED', '등록 DB server를 읽을 수 없습니다.', { reason: storeError.message });
      if (!server) throw error('DB_APPEND_FAILED', '등록 DB server를 찾을 수 없습니다.', { server: database.server });
      try {
        client = clientFactory(serverConfig(server));
        connection = client.connect();
        columns = rowsOf(connection.query(
          'SELECT c.NAME, c.FLAG FROM M$SYS_COLUMNS c, M$SYS_TABLES t '
            + 'WHERE c.TABLE_ID = t.ID AND c.DATABASE_ID = t.DATABASE_ID '
            + 'AND t.NAME = ? AND t.DATABASE_ID = -1 AND c.ID < 65534 ORDER BY c.ID ASC',
          database.table,
        )).map((row) => ({
          name: row.NAME === undefined ? row.name : row.NAME,
          flag: Number(row.FLAG === undefined ? row.flag : row.FLAG) || 0,
        }));
        const valueColumn = columnByName(columns, database.valueColumn);
        const stringValueColumn = columnByName(columns, database.stringValueColumn);
        mapping = {
          primary: (columns.find((column) => column.flag & FLAG_PRIMARY) || {}).name,
          basetime: (columns.find((column) => column.flag & FLAG_BASETIME) || {}).name,
          value: valueColumn && valueColumn.name,
          stringValue: stringValueColumn && stringValueColumn.name,
        };
        if (!mapping.primary || !mapping.basetime || !mapping.value) {
          throw new Error('TAG table column mapping을 찾을 수 없습니다.');
        }
        appender = connection.append(database.table);
      } catch (openError) {
        close();
        throw error('DB_APPEND_FAILED', 'Machbase append stream을 열 수 없습니다.', { reason: openError.message });
      }
    },
    append(rows) {
      if (!appender || !mapping) throw error('DB_APPEND_FAILED', 'Machbase append stream이 열려 있지 않습니다.');
      const unsupported = rows.find((row) => row.stringValue !== null && row.stringValue !== undefined);
      if (unsupported && !mapping.stringValue) {
        throw error('DB_APPEND_FAILED', 'stringValueColumn이 없어 문자열 또는 객체 값을 저장할 수 없습니다.', {
          name: unsupported.name,
        });
      }
      try {
        rows.forEach((row) => {
          const named = {
            [mapping.primary]: row.name,
            [mapping.basetime]: row.requestTime,
            [mapping.value]: row.stringValue === null || row.stringValue === undefined ? row.value : null,
          };
          if (mapping.stringValue) named[mapping.stringValue] = row.stringValue;
          appender.append(...columns.map((column) => (
            Object.prototype.hasOwnProperty.call(named, column.name) ? named[column.name] : null
          )));
        });
        appender.flush();
      } catch (appendError) {
        throw error('DB_APPEND_FAILED', 'Machbase TAG append에 실패했습니다.', { reason: appendError.message });
      }
    },
    close,
  };
}

module.exports = { createMachbaseAppender };
