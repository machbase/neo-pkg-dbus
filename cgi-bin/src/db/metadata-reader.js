'use strict';

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const FLAG_BASETIME = 0x1000000;
const FLAG_PRIMARY = 0x8000000;
const NUMERIC_TYPES = new Set([4, 104, 8, 108, 12, 112, 16, 20]);
const STRING_TYPES = new Set([5, 49, 53]);

function defaultClientFactory(config) {
  const machcli = require('machcli');
  if (!machcli || typeof machcli.Client !== 'function') {
    throw new Error('machcli.Client를 사용할 수 없습니다.');
  }
  return new machcli.Client(config);
}

function rowsOf(iterable) {
  if (!iterable) return [];
  if (Array.isArray(iterable)) return iterable;
  const rows = [];
  for (const row of iterable) rows.push(row);
  return rows;
}

function typeName(code, length) {
  const names = {
    4: 'short', 104: 'ushort', 8: 'integer', 108: 'uinteger',
    12: 'long', 112: 'ulong', 6: 'datetime', 16: 'float', 20: 'double',
    49: 'text', 53: 'clob', 57: 'blob', 97: 'binary',
    32: 'ipv4', 36: 'ipv6', 61: 'json',
  };
  if (Number(code) === 5) return `varchar(${Number(length) || 0})`;
  return names[Number(code)] || 'unknown';
}

function connectionConfig(server) {
  const source = server && server.connection && typeof server.connection === 'object'
    ? server.connection : server;
  return {
    host: source.host,
    port: source.port,
    user: source.user,
    password: source.password,
  };
}

function createMetadataReader(options) {
  const settings = options || {};
  const clientFactory = settings.clientFactory || defaultClientFactory;
  function withConnection(server, callback, operation) {
    let client = null;
    let connection = null;
    let result = null;
    let failure = null;
    try {
      client = clientFactory(connectionConfig(server));
      if (!client || typeof client.connect !== 'function') {
        throw new Error('machcli client connect()를 사용할 수 없습니다.');
      }
      connection = client.connect();
      if (!connection || typeof connection.query !== 'function') {
        throw new Error('machcli connection query()를 사용할 수 없습니다.');
      }
      result = operation(connection);
    } catch (operationError) {
      failure = operationError;
    } finally {
      try { if (connection && typeof connection.close === 'function') connection.close(); } catch (_) {}
      try { if (client && typeof client.close === 'function') client.close(); } catch (_) {}
    }
    callback(failure, result);
  }
  return {
    listTables(server, callback) {
      withConnection(server, callback, (connection) => ({
        tables: rowsOf(connection.query(
          'SELECT NAME FROM M$SYS_TABLES WHERE TYPE = 6 AND DATABASE_ID = -1 ORDER BY NAME ASC',
        )).map((row) => String(row.NAME === undefined ? row.name : row.NAME)),
      }));
    },
    createTagTable(server, table, callback) {
      if (typeof table !== 'string' || !TABLE_NAME.test(table)) {
        callback(new Error('DB table name 형식이 잘못되었습니다.'));
        return;
      }
      withConnection(server, callback, (connection) => {
        if (typeof connection.exec !== 'function') throw new Error('machcli connection exec()를 사용할 수 없습니다.');
        const existing = rowsOf(connection.query(
          'SELECT ID FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1', table,
        ));
        if (existing.length) {
          const failure = new Error('같은 이름의 table이 이미 있습니다.');
          failure.code = 'TABLE_ALREADY_EXISTS';
          throw failure;
        }
        connection.exec(`CREATE TAG TABLE ${table} (NAME VARCHAR(100) PRIMARY KEY, TIME DATETIME BASETIME, VALUE DOUBLE SUMMARIZED, STR_VALUE VARCHAR(1024))`);
        return { table, valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' };
      });
    },
    columns(server, table, callback) {
      if (typeof table !== 'string' || !TABLE_NAME.test(table)) {
        callback(new Error('DB table name 형식이 잘못되었습니다.'));
        return;
      }
      withConnection(server, callback, (connection) => {
        const tableRows = rowsOf(connection.query(
          'SELECT ID, TYPE, NAME FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1',
          table,
        ));
        const tableRow = tableRows[0] || null;
        if (!tableRow) {
          return { table, tableType: 'NOT_FOUND', columns: [] };
        } else {
          const tableId = tableRow.ID === undefined ? tableRow.id : tableRow.ID;
          const tableTypeCode = tableRow.TYPE === undefined ? tableRow.type : tableRow.TYPE;
          const columnRows = rowsOf(connection.query(
            'SELECT c.NAME, c.TYPE, c.ID, c.LENGTH, c.FLAG FROM M$SYS_COLUMNS c, M$SYS_TABLES t '
              + 'WHERE c.TABLE_ID = t.ID AND c.DATABASE_ID = t.DATABASE_ID '
              + 'AND t.ID = ? AND t.DATABASE_ID = -1 AND c.ID < 65534 ORDER BY c.ID ASC',
            tableId,
          ));
          return {
            table,
            tableType: Number(tableTypeCode) === 6 ? 'TAG' : Number(tableTypeCode) === 0 ? 'LOG' : 'UNSUPPORTED',
            columns: columnRows.map((row) => {
              const flag = Number(row.FLAG === undefined ? row.flag : row.FLAG) || 0;
              const name = row.NAME === undefined ? row.name : row.NAME;
              const type = row.TYPE === undefined ? row.type : row.TYPE;
              const length = row.LENGTH === undefined ? row.length : row.LENGTH;
              const typeCode = Number(type);
              return {
                name,
                type: typeName(typeCode, length),
                primaryKey: Boolean(flag & FLAG_PRIMARY),
                basetime: Boolean(flag & FLAG_BASETIME),
                numeric: NUMERIC_TYPES.has(typeCode),
                string: STRING_TYPES.has(typeCode),
              };
            }),
          };
        }
      });
    },
  };
}

module.exports = { createMetadataReader };
