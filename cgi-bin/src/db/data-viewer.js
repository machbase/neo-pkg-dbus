'use strict';

const { error } = require('../config/errors.js');
const { JobRepository } = require('../jobs/repository.js');
const { createServerStore } = require('./server-store.js');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const MAX_NAMES = 100;
const MAX_ROWS_PER_TAG = 1000;
const MAX_TOTAL_ROWS = 1000000;
const MAX_TAGS = 1000;
const FLAG_BASETIME = 0x1000000;
const FLAG_SUMMARIZED = 0x2000000;
const FLAG_METADATA = 0x4000000;
const FLAG_PRIMARY = 0x8000000;
const TYPE_NAMES = {
  4: 'short', 104: 'ushort', 8: 'integer', 108: 'uinteger', 12: 'long', 112: 'ulong',
  6: 'datetime', 16: 'float', 20: 'double', 5: 'varchar', 49: 'text', 53: 'clob',
  57: 'blob', 97: 'binary', 32: 'ipv4', 36: 'ipv6', 61: 'json',
};
const NUMERIC_TYPES = new Set([4, 104, 8, 108, 12, 112, 16, 20]);
const STRING_TYPES = new Set([5, 49, 53]);
const HIERARCHY_TAG_NAME = '__machbase_hierarchy__';

  function invalid(reason, details) {
    return error('DB_REQUEST_INVALID', reason, details);
  }

  function tableInvalid(reason, details) {
    return error('TABLE_INVALID', reason, details);
  }

function identifier(value, label) {
  const result = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
  if (!IDENTIFIER.test(result)) throw invalid(`${label} 형식이 잘못되었습니다.`);
  return result;
}

function qualifiedTable(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw invalid('table은 TABLE 또는 USER.TABLE 형식이어야 합니다.');
  }
  const normalized = parts.map((part) => part.toUpperCase());
  return {
    table: normalized.join('.'),
    tableName: normalized[normalized.length - 1],
    tableUser: normalized.length === 2 ? normalized[0] : null,
  };
}

function positiveInteger(value, fallback, maximum, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw invalid(`${label}은 1~${maximum} 정수여야 합니다.`);
  }
  return number;
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const source = String(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(source)) {
    throw invalid(`${label} 시간은 UTC ISO-8601 형식이어야 합니다.`);
  }
  const result = new Date(source);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 19) !== source.slice(0, 19)) {
    throw invalid(`${label} 시간 형식이 잘못되었습니다.`);
  }
  return result;
}

function timezone(params) {
  if (Object.prototype.hasOwnProperty.call(params, 'timezone')) {
    throw error('TIMEZONE_UNSUPPORTED', 'v1 DataViewer는 UTC만 사용하며 timezone 파라미터를 받지 않습니다.', { timezone: String(params.timezone) });
  }
  return 'UTC';
}

function escapeSqlString(value) {
  return String(value === undefined || value === null ? '' : value).replace(/'/g, "''");
}

function formatSqlDateLiteral(value) {
  if (!(value instanceof Date)) return '';
  const iso = value.toISOString().replace('T', ' ').replace('Z', '');
  return `to_date('${escapeSqlString(iso)}')`;
}

function namesOf(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  const names = [];
  source.forEach((item) => {
    const name = String(item || '').trim();
    if (name && !names.includes(name)) names.push(name);
  });
  if (!names.length) throw invalid('Tag name이 하나 이상 필요합니다.');
  if (names.length > MAX_NAMES) throw invalid(`Tag name은 최대 ${MAX_NAMES}개까지 요청할 수 있습니다.`);
  return names;
}

function jobName(value) {
  const name = String(value || '');
  if (!JOB_NAME.test(name) || /[\\/]/.test(name)) throw invalid('job name 형식이 잘못되었습니다.');
  return name;
}

function typeName(row) {
  const code = Number(row.TYPE === undefined ? row.type : row.TYPE);
  const base = TYPE_NAMES[code] || `type-${code}`;
  const length = Number(row.LENGTH === undefined ? row.length : row.LENGTH) || 0;
  return code === 5 ? `${base}(${length})` : base;
}

function mapColumn(row) {
  const code = Number(row.TYPE === undefined ? row.type : row.TYPE);
  const flag = Number(row.FLAG === undefined ? row.flag : row.FLAG) || 0;
  return {
    name: identifier(row.NAME === undefined ? row.name : row.NAME, 'metadata column'),
    type: typeName(row),
    primaryKey: Boolean(flag & FLAG_PRIMARY),
    basetime: Boolean(flag & FLAG_BASETIME),
    summarized: Boolean(flag & FLAG_SUMMARIZED),
    metadata: Boolean(flag & FLAG_METADATA),
    numeric: NUMERIC_TYPES.has(code),
    string: STRING_TYPES.has(code),
  };
}

function serverConnectionConfig(server) {
  return { host: server.host, port: server.port, user: server.user, password: server.password };
}

function defaultConnectionFactory(config) {
  const machcli = require('machcli');
  if (!machcli || typeof machcli.Client !== 'function') throw new Error('machcli.Client를 사용할 수 없습니다.');
  const client = new machcli.Client(config);
  let connection;
  try { connection = client.connect(); } catch (failure) {
    try { if (client && typeof client.close === 'function') client.close(); } catch (_) {}
    throw failure;
  }
  return {
    query(sql, ...values) { return connection.query(sql, ...values); },
    exec(sql, ...values) { return connection.exec(sql, ...values); },
    close() {
      try { if (connection && typeof connection.close === 'function') connection.close(); } catch (_) {}
      try { if (client && typeof client.close === 'function') client.close(); } catch (_) {}
    },
  };
}

function rowsOf(source) {
  try {
    if (Array.isArray(source)) return source;
    const rows = [];
    if (source) for (const row of source) rows.push(row);
    return rows;
  } finally {
    if (source && typeof source.close === 'function') source.close();
  }
}

function rowValue(row, name) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(row, lower)) return row[lower];
  return null;
}

function pickRowValue(row, names) {
  for (const name of names || []) {
    if (Object.prototype.hasOwnProperty.call(row || {}, name)) return row[name];
    const match = Object.keys(row || {}).find((key) => key.toUpperCase() === String(name).toUpperCase());
    if (match) return row[match];
  }
  return undefined;
}

function parseJsonObject(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

function normalizeAssetHierarchy(value) {
  const parsed = parseJsonObject(value);
  if (!parsed || !Array.isArray(parsed.schema) || !Array.isArray(parsed.tree)) return null;
  const column = String(parsed.column || 'asset').trim() || 'asset';
  const schema = parsed.schema.map((item) => String(item || '').trim()).filter(Boolean);
  if (!schema.length || schema.length !== parsed.schema.length || new Set(schema).size !== schema.length) return null;
  return { column, schema, tree: parsed.tree };
}

function findAssetHierarchy(row) {
  for (const value of Object.values(row || {})) {
    const hierarchy = normalizeAssetHierarchy(value);
    if (hierarchy) return hierarchy;
  }
  return null;
}

function mapTagMetaRows(rows, assetHierarchy, primaryColumn) {
  const assetColumn = assetHierarchy ? assetHierarchy.column : '';
  const tags = [];
  for (const row of rows || []) {
    const name = pickRowValue(row, [primaryColumn]);
    if (name === undefined || name === null || name === '' || String(name) === HIERARCHY_TAG_NAME) continue;
    const id = pickRowValue(row, ['_ID', 'ID']);
    const tag = { id: id === undefined || id === null ? null : String(id), name: String(name) };
    const asset = parseJsonObject(pickRowValue(row, [assetColumn]));
    if (asset) tag.asset = asset;
    tags.push(tag);
  }
  return tags;
}

function encodeCursor(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodeCursor(value) {
  if (!value) return { side: 'next', page: 0 };
  try {
    const parsed = JSON.parse(decodeURIComponent(String(value)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !keys.includes('side') || !keys.includes('page')) throw new Error('cursor fields');
    if (parsed.side !== 'next' && parsed.side !== 'previous') throw new Error('invalid cursor side');
    if (!Number.isSafeInteger(parsed.page) || parsed.page < 0) throw new Error('invalid cursor page');
    return parsed;
  } catch (_) {
    throw invalid('cursor 형식이 잘못되었습니다.');
  }
}

function createDataViewer(options) {
  const settings = options || {};
  const store = settings.serverStore || createServerStore({ cgiRoot: settings.cgiRoot });
  const jobScopedTags = settings.productPolicy?.target === 'ls';
  let jobs = settings.jobRepository || null;
  const connectionFactory = settings.connectionFactory || defaultConnectionFactory;

  function withServer(name, operation, callback) {
    let called = false;
    store.get(name, (storeError, server) => {
      called = true;
      if (storeError) { callback(storeError); return; }
      if (!server) { callback(error('DB_SERVER_NOT_FOUND', '등록 DB server를 찾을 수 없습니다.', { name })); return; }
      let connection;
      try {
        connection = connectionFactory(serverConnectionConfig(server));
        callback(null, operation(connection, server));
      } catch (failure) {
        callback(failure && failure.code
          ? failure
          : error('DB_UNAVAILABLE', 'DB 요청을 처리할 수 없습니다.', { server: name }));
      } finally {
        try { if (connection && typeof connection.close === 'function') connection.close(); } catch (_) {}
      }
    });
    if (!called) callback(error('DB_UNAVAILABLE', '등록 DB server 읽기는 동기 완료되어야 합니다.', { server: name }));
  }

  function metadata(connection, tableValue, serverUser) {
    const target = qualifiedTable(tableValue);
    let userId = null;
    const lookupUser = target.tableUser || String(serverUser || '').toUpperCase();
    if (lookupUser) {
      const users = rowsOf(connection.query('SELECT USER_ID, NAME FROM M$SYS_USERS'));
      const found = users.find((row) => String(row.NAME || row.name).toUpperCase() === lookupUser);
      if (!found) throw invalid('DB user를 찾을 수 없습니다.', { user: lookupUser });
      userId = found.USER_ID === undefined ? found.user_id : found.USER_ID;
    }
    const tableRows = userId === null
      ? rowsOf(connection.query('SELECT ID, TYPE, NAME FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1', target.tableName))
      : rowsOf(connection.query('SELECT ID, TYPE, NAME FROM M$SYS_TABLES WHERE NAME = ? AND USER_ID = ? AND DATABASE_ID = -1', target.tableName, userId));
    const tableRow = tableRows[0];
    if (!tableRow) throw error('DB_TABLE_NOT_FOUND', 'TAG table을 찾을 수 없습니다.', { table: target.table });
    const tableType = Number(tableRow.TYPE === undefined ? tableRow.type : tableRow.TYPE);
    if (tableType !== 6) throw invalid('선택한 table은 TAG table이 아닙니다.', { table: target.table });
    const tableId = tableRow.ID === undefined ? tableRow.id : tableRow.ID;
    const columns = rowsOf(connection.query(
      'SELECT c.NAME, c.TYPE, c.ID, c.LENGTH, c.FLAG FROM M$SYS_COLUMNS c, M$SYS_TABLES t '
      + 'WHERE c.TABLE_ID = t.ID AND c.DATABASE_ID = t.DATABASE_ID AND t.ID = ? '
      + 'AND t.DATABASE_ID = -1 AND c.ID < 65534 ORDER BY c.ID ASC',
      tableId,
    )).map(mapColumn);
    return { target, columns };
  }

  function column(columns, requested, fallback, predicate, label) {
    const name = identifier(requested || fallback, label);
    const found = columns.find((item) => item.name === name);
    if (!found || (predicate && !predicate(found))) throw invalid(`${label}이 table metadata와 맞지 않습니다.`, { column: name });
    return found;
  }

  function roleColumn(columns, requested, role, label) {
    const requestedName = requested === undefined || requested === null || requested === ''
      ? null : identifier(requested, label);
    const candidates = columns.filter((item) => item[role] === true);
    const found = candidates[0];
    if (candidates.length !== 1 || (requestedName && requestedName !== found.name)) {
      throw invalid(`${label}이 table metadata와 맞지 않습니다.`, { column: requestedName });
    }
    return found;
  }

  function request(params, serverRequired) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('DB 요청은 객체여야 합니다.');
    if (serverRequired !== false && (typeof params.server !== 'string' || !params.server)) throw invalid('server가 필요합니다.');
    return params;
  }

  function invalidJob(name, reason) {
    throw error('JOB_INVALID_CONFIG', reason || '저장된 Job DB 설정을 사용할 수 없습니다.', { name });
  }

  function sourceMismatch(name, reason, details) {
    throw error('JOB_DATA_SOURCE_MISMATCH', reason, { job: name, ...(details || {}) });
  }

  function jobDataRequest(params, requireNames = true) {
    request(params, false);
    const name = jobName(params.job);
    let document;
    if (!jobs) jobs = new JobRepository({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir });
    try { document = jobs.read(name); } catch (failure) {
      if (failure && (failure.code === 'JOB_NOT_FOUND' || failure.code === 'JOB_INVALID_CONFIG')) throw failure;
      invalidJob(name);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || document.schemaVersion !== 1 || document.name !== name
      || !document.database || typeof document.database !== 'object' || Array.isArray(document.database)
      || !Array.isArray(document.methodCalls) || document.methodCalls.length < 1) {
      invalidJob(name);
    }
    const database = document.database;
    if (typeof database.server !== 'string' || !database.server
      || typeof database.table !== 'string' || typeof database.valueColumn !== 'string'
      || typeof database.stringValueColumn !== 'string') invalidJob(name);
    let table;
    let valueColumn;
    let stringValueColumn;
    try {
      table = qualifiedTable(database.table).table;
      valueColumn = identifier(database.valueColumn, 'database.valueColumn');
      stringValueColumn = database.stringValueColumn
        ? identifier(database.stringValueColumn, 'database.stringValueColumn') : null;
    } catch (_) { invalidJob(name); }
    if (typeof params.server !== 'string' || !params.server
      || typeof params.table !== 'string' || !params.table
      || (requireNames && !Object.prototype.hasOwnProperty.call(params, 'names'))) {
      sourceMismatch(name, requireNames ? 'job, server, table, names가 모두 필요합니다.' : 'job, server, table이 모두 필요합니다.');
    }
    const requestedNames = requireNames ? namesOf(params.names) : [];
    if (params.server !== database.server) {
      sourceMismatch(name, '요청 server가 Job DB 설정과 다릅니다.');
    }
    let requestedTable;
    try { requestedTable = qualifiedTable(params.table).table; } catch (_) {
      sourceMismatch(name, '요청 table 형식이 잘못되었습니다.');
    }
    if (requestedTable !== table) {
      sourceMismatch(name, '요청 table이 Job DB 설정과 다릅니다.');
    }
    if (params.valueColumn !== undefined && identifier(params.valueColumn, 'valueColumn') !== valueColumn) {
      sourceMismatch(name, '요청 valueColumn이 Job DB 설정과 다릅니다.');
    }
    if (params.stringValueColumn !== undefined) {
      const requestedStringValue = params.stringValueColumn
        ? identifier(params.stringValueColumn, 'stringValueColumn') : null;
      if (requestedStringValue !== stringValueColumn) {
        sourceMismatch(name, '요청 stringValueColumn이 Job DB 설정과 다릅니다.');
      }
    }
    const tagEntries = [];
    document.methodCalls.forEach((call, callIndex) => {
      const callLabel = String(call?.name || call?.id || `Call ${callIndex + 1}`).trim() || `Call ${callIndex + 1}`;
      const groups = Array.isArray(call.outputSelections)
        ? call.outputSelections.map((selection) => selection.tags || [])
        : [call.tags || []];
      groups.flat().forEach((tag) => {
        const tagName = String(tag?.name || '').trim();
        if (tagName && !tagEntries.some((item) => item.name === tagName)) {
          tagEntries.push({ name: tagName, treePath: [callLabel, tagName] });
        }
      });
    });
    return {
      name,
      names: requestedNames,
      tagEntries,
      database: { server: database.server, table, valueColumn, stringValueColumn },
    };
  }

  function hasOpcuaPaging(params) {
    return ['page', 'pageSize', 'boundedRange', 'cursorSide', 'cursorTime', 'cursorName', 'cursorOffset']
      .some((key) => Object.prototype.hasOwnProperty.call(params || {}, key));
  }

  function nonNegativeInteger(value, fallback, maximum, label) {
    const number = value === undefined || value === null || value === '' ? fallback : Number(value);
    if (!Number.isInteger(number) || number < 0 || number > maximum) throw invalid(`${label}은 0~${maximum} 정수여야 합니다.`);
    return number;
  }

  function opcuaPageParams(params, selectedJob) {
    const pageSize = positiveInteger(params.pageSize, 100, MAX_TOTAL_ROWS, 'pageSize');
    const page = positiveInteger(params.page, 1, 1000000, 'page');
    const from = optionalDate(params.from, 'from');
    const to = optionalDate(params.to, 'to');
    if (from && to && from > to) throw invalid('from은 to보다 늦을 수 없습니다.');
    const cursorSide = params.cursorSide === 'next' || params.cursorSide === 'prev' ? params.cursorSide : null;
    const cursorTime = optionalDate(params.cursorTime, 'cursorTime');
    const cursorName = cursorSide && cursorTime ? String(params.cursorName || '') : '';
    if ((cursorSide && !cursorTime) || (!cursorSide && (cursorTime || params.cursorName !== undefined || params.cursorOffset !== undefined))) {
      throw invalid('cursor fields가 함께 필요합니다.');
    }
    return {
      names: selectedJob.names,
      job: selectedJob.name,
      direction: params.direction === 'oldest' ? 'oldest' : 'latest',
      page,
      pageSize,
      boundedRange: params.boundedRange === true || params.boundedRange === 'true',
      cursorSide,
      cursorTime,
      cursorName,
      cursorOffset: nonNegativeInteger(params.cursorOffset, 0, MAX_TOTAL_ROWS, 'cursorOffset'),
      from,
      to,
    };
  }

  function opcuaCursor(parsed, primary, time) {
    if (!parsed.cursorSide || !parsed.cursorTime) return null;
    const latest = parsed.direction !== 'oldest';
    const next = parsed.cursorSide === 'next';
    if (latest && next) return { sql: `(${time.name} < ? OR (${time.name} = ? AND ${primary.name} > ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: 'DESC', orderName: 'ASC', reverse: false };
    if (latest) return { sql: `(${time.name} > ? OR (${time.name} = ? AND ${primary.name} < ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: 'ASC', orderName: 'DESC', reverse: true };
    if (next) return { sql: `(${time.name} > ? OR (${time.name} = ? AND ${primary.name} > ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: 'ASC', orderName: 'ASC', reverse: false };
    return { sql: `(${time.name} < ? OR (${time.name} = ? AND ${primary.name} < ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: 'DESC', orderName: 'DESC', reverse: true };
  }

  function mapViewerRow(row, primary, time, numeric, stringValue) {
    const date = new Date(rowValue(row, time.name));
    if (!Number.isFinite(date.getTime())) return null;
    const numberValue = numeric ? rowValue(row, numeric.name) : null;
    const textValue = stringValue ? rowValue(row, stringValue.name) : null;
    return {
      name: String(rowValue(row, primary.name)),
      time: date.toISOString(),
      value: numberValue === undefined ? null : numberValue,
      stringValue: textValue === undefined ? null : textValue,
    };
  }

  function opcuaPage(connection, server, selectedJob, params) {
    const parsed = opcuaPageParams(params, selectedJob);
    const value = metadata(connection, selectedJob.database.table, server.user);
    const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
    const time = roleColumn(value.columns, params.timeColumn, 'basetime', 'timeColumn');
    const numeric = column(value.columns, selectedJob.database.valueColumn, null, (item) => item.numeric, 'valueColumn');
    const stringValue = selectedJob.database.stringValueColumn ? column(
      value.columns, selectedJob.database.stringValueColumn, null,
      (item) => item.string && !item.primaryKey, 'stringValueColumn',
    ) : null;
    const clauses = [`${primary.name} IN (${parsed.names.map(() => '?').join(', ')})`];
    const values = parsed.names.slice();
    if (parsed.from) { clauses.push(`${time.name} >= ?`); values.push(parsed.from); }
    if (parsed.to) { clauses.push(`${time.name} <= ?`); values.push(parsed.to); }
    const cursor = opcuaCursor(parsed, primary, time);
    if (cursor) { clauses.push(cursor.sql); values.push(...cursor.values); }
    const orderTime = cursor ? cursor.orderTime : (parsed.direction === 'oldest' ? 'ASC' : 'DESC');
    const orderName = cursor ? cursor.orderName : 'ASC';
    const selected = [primary.name, time.name, numeric.name];
    if (stringValue) selected.push(stringValue.name);
    let limit = '';
    if (!parsed.boundedRange) {
      const offset = cursor ? parsed.cursorOffset : (parsed.page - 1) * parsed.pageSize;
      values.push(offset, parsed.pageSize);
      limit = ' LIMIT ?, ?';
    }
    const rows = rowsOf(connection.query(
      `SELECT ${selected.join(', ')} FROM ${value.target.table} WHERE ${clauses.join(' AND ')} `
      + `ORDER BY ${time.name} ${orderTime}, ${primary.name} ${orderName}${limit}`,
      ...values,
    ));
    const ordered = cursor && cursor.reverse ? rows.reverse() : rows;
    return {
      server: server.name,
      job: selectedJob.name,
      table: value.target.table,
      columns: { primary: primary.name, time: time.name, numericValue: numeric.name, stringValue: stringValue ? stringValue.name : null },
      names: parsed.names,
      direction: parsed.direction,
      page: parsed.page,
      pageSize: parsed.pageSize,
      rows: ordered.map((row) => mapViewerRow(row, primary, time, numeric, stringValue)).filter(Boolean),
    };
  }

  return {
    connect(params, callback) {
      try { request(params); } catch (failure) { callback(failure); return; }
      withServer(params.server, (_connection, server) => ({
        server: server.name, connected: true, host: server.host, port: server.port, user: server.user,
      }), callback);
    },
    createTable(params, callback) {
      try { request(params); } catch (failure) { callback(failure); return; }
      let table;
      let valueColumn;
      let stringValueColumn;
      try {
        table = identifier(params.table, 'table');
        valueColumn = identifier(params.valueColumn, 'valueColumn');
        if (params.stringValueColumn === undefined || params.stringValueColumn === null || params.stringValueColumn === '') {
          stringValueColumn = null;
        } else stringValueColumn = identifier(params.stringValueColumn, 'stringValueColumn');
        if (valueColumn === 'NAME' || valueColumn === 'TIME' || valueColumn === stringValueColumn
          || (stringValueColumn && (stringValueColumn === 'NAME' || stringValueColumn === 'TIME'))) {
          throw tableInvalid('TAG table column 이름이 기본 key/time 열과 겹칩니다.');
        }
      } catch (failure) {
        callback(failure && failure.code === 'TABLE_INVALID' ? failure
          : tableInvalid('TAG table 또는 value column 설정이 잘못되었습니다.'));
        return;
      }
      withServer(params.server, (connection, server) => {
        const existing = rowsOf(connection.query(
          'SELECT ID FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1', table,
        ));
        if (existing.length) throw error('TABLE_ALREADY_EXISTS', '같은 이름의 table이 이미 있습니다.', { table });
        const definitions = [
          'NAME VARCHAR(100) PRIMARY KEY',
          'TIME DATETIME BASETIME',
          `${valueColumn} DOUBLE SUMMARIZED`,
        ];
        if (stringValueColumn) definitions.push(`${stringValueColumn} VARCHAR(1024)`);
        connection.exec(`CREATE TAG TABLE ${table} (${definitions.join(', ')})`);
        return {
          server: server.name,
          table,
          primaryKeyColumn: 'NAME',
          basetimeColumn: 'TIME',
          valueColumn,
          stringValueColumn,
        };
      }, callback);
    },
    listTables(params, callback) {
      try { request(params); } catch (failure) { callback(failure); return; }
      withServer(params.server, (connection) => {
        const users = rowsOf(connection.query('SELECT USER_ID, NAME FROM M$SYS_USERS'));
        const names = {};
        users.forEach((row) => { names[row.USER_ID === undefined ? row.user_id : row.USER_ID] = row.NAME || row.name; });
        return rowsOf(connection.query(
          'SELECT NAME, TYPE, ID, USER_ID FROM M$SYS_TABLES WHERE TYPE IN (0, 6) AND DATABASE_ID = -1',
        )).filter((row) => Number(row.TYPE === undefined ? row.type : row.TYPE) === 6).map((row) => ({
          name: row.NAME || row.name,
          user: names[row.USER_ID === undefined ? row.user_id : row.USER_ID] || null,
          type: 'TAG',
        }));
      }, callback);
    },
    columns(params, callback) {
      try { request(params); } catch (failure) { callback(failure); return; }
      withServer(params.server, (connection, server) => {
        const value = metadata(connection, params.table, server.user);
        return {
          server: server.name,
          table: value.target.table,
          tableType: 'TAG',
          columns: value.columns,
          primaryColumn: (value.columns.find((item) => item.primaryKey) || {}).name || null,
          timeColumn: (value.columns.find((item) => item.basetime) || {}).name || null,
          numericValueColumns: value.columns.filter((item) => item.numeric && !item.primaryKey).map((item) => item.name),
          stringValueColumns: value.columns.filter((item) => item.string && !item.primaryKey).map((item) => item.name),
        };
      }, callback);
    },
    tags(params, callback) {
      let selectedJob;
      try { selectedJob = jobDataRequest(params, false); } catch (failure) { callback(failure); return; }
      // LS has one shared table, so a table-level Tag scan would include rows
      // owned by every Job. Its Data Viewer must instead start from the Tags
      // configured for the requested Job. Those Tags should remain visible
      // even before their first row has created table metadata.
      if (jobScopedTags) {
        const tagEntries = selectedJob.tagEntries || [];
        let limit = tagEntries.length;
        if (params.limit !== undefined && params.limit !== '') {
          try {
            if (tagEntries.length) limit = positiveInteger(params.limit, tagEntries.length, tagEntries.length, 'limit');
            else if (Number(params.limit) !== 0) throw invalid('limit은 Tag가 없을 때 0이어야 합니다.');
          } catch (failure) { callback(failure); return; }
        }
        return callback(null, {
          server: selectedJob.database.server,
          table: selectedJob.database.table,
          tags: tagEntries.slice(0, limit).map((tag) => ({ id: null, name: tag.name, treePath: tag.treePath })),
          assetHierarchy: null,
          limited: tagEntries.length > limit,
          limit,
        });
      }
      let limit;
      try { limit = positiveInteger(params.limit, 200, MAX_TAGS, 'limit'); } catch (failure) { callback(failure); return; }
      withServer(selectedJob.database.server, (connection, server) => {
        const value = metadata(connection, selectedJob.database.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
        const metaTable = value.target.tableUser
          ? `${value.target.tableUser}._${value.target.tableName}_META`
          : `_${value.target.tableName}_META`;
        const hierarchyRows = rowsOf(connection.query(
          `SELECT * FROM ${metaTable} WHERE ${primary.name} = ?`, HIERARCHY_TAG_NAME,
        ));
        const assetHierarchy = findAssetHierarchy(hierarchyRows[0]);
        // Asset hierarchy itself is stored as one reserved Meta row. Fetch one
        // more row in that shape so the caller's limit always means real Tags.
        const queryLimit = limit + (assetHierarchy ? 2 : 1);
        const rows = rowsOf(connection.query(
          assetHierarchy
            ? `SELECT * FROM ${metaTable} ORDER BY ${primary.name} LIMIT ?`
            : `SELECT _ID, ${primary.name} FROM ${metaTable} ORDER BY ${primary.name} LIMIT ?`,
          queryLimit,
        ));
        const allTags = mapTagMetaRows(rows, assetHierarchy, primary.name);
        const tags = allTags.slice(0, limit);
        return {
          server: server.name,
          table: value.target.table,
          tags,
          assetHierarchy,
          limited: allTags.length > limit,
          limit,
        };
      }, callback);
    },
    data(params, callback) {
      let selectedJob;
      try { selectedJob = jobDataRequest(params); } catch (failure) { callback(failure); return; }
      if (hasOpcuaPaging(params)) {
        withServer(selectedJob.database.server, (connection, server) => opcuaPage(connection, server, selectedJob, params), callback);
        return;
      }
      let parsed;
      try {
        parsed = {
          names: selectedJob.names,
          job: selectedJob.name,
          rowsPerTag: positiveInteger(params.rowsPerTag, 100, MAX_ROWS_PER_TAG, 'rowsPerTag'),
          direction: params.direction === 'oldest' ? 'oldest' : 'latest',
          from: optionalDate(params.from, 'from'),
          to: optionalDate(params.to, 'to'),
          timezone: timezone(params),
          cursor: decodeCursor(params.cursor),
        };
        if (parsed.names.length * parsed.rowsPerTag > MAX_TOTAL_ROWS) throw invalid(`한 요청의 row는 최대 ${MAX_TOTAL_ROWS}개입니다.`);
        parsed.offset = parsed.cursor.page * parsed.rowsPerTag;
        if (!Number.isSafeInteger(parsed.offset)) throw invalid('cursor page가 너무 큽니다.');
        if (parsed.from && parsed.to && parsed.from > parsed.to) throw invalid('from은 to보다 늦을 수 없습니다.');
      } catch (failure) { callback(failure); return; }
      withServer(selectedJob.database.server, (connection, server) => {
        const value = metadata(connection, selectedJob.database.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
        const time = roleColumn(value.columns, params.timeColumn, 'basetime', 'timeColumn');
        const numeric = column(value.columns, selectedJob.database.valueColumn, null, (item) => item.numeric, 'valueColumn');
        const stringValue = selectedJob.database.stringValueColumn ? column(
          value.columns, selectedJob.database.stringValueColumn, null,
          (item) => item.string && !item.primaryKey, 'stringValueColumn',
        ) : null;
        if (!numeric && !stringValue) throw invalid('valueColumn 또는 stringValueColumn이 필요합니다.');
        const order = parsed.direction === 'oldest' ? 'ASC' : 'DESC';
        const pageRows = [];
        let anyHasMore = false;
        parsed.names.forEach((name) => {
          const clauses = [`${primary.name} = ?`];
          const values = [name];
          if (parsed.from) { clauses.push(`${time.name} >= ?`); values.push(parsed.from); }
          if (parsed.to) { clauses.push(`${time.name} <= ?`); values.push(parsed.to); }
          values.push(parsed.offset, parsed.rowsPerTag + 1);
          const selected = [primary.name, time.name];
          if (numeric) selected.push(numeric.name);
          if (stringValue) selected.push(stringValue.name);
          const fetchedRows = rowsOf(connection.query(
            `SELECT ${selected.join(', ')} FROM ${value.target.table} WHERE ${clauses.join(' AND ')} `
            + `ORDER BY ${time.name} ${order} LIMIT ?, ?`,
            ...values,
          ));
          if (fetchedRows.length > parsed.rowsPerTag) anyHasMore = true;
          const rows = fetchedRows.slice(0, parsed.rowsPerTag);
          rows.forEach((row) => {
            const date = new Date(rowValue(row, time.name));
            if (!Number.isFinite(date.getTime())) return;
            const numberValue = numeric ? rowValue(row, numeric.name) : null;
            const textValue = stringValue ? rowValue(row, stringValue.name) : null;
            pageRows.push({
              name: String(rowValue(row, primary.name)),
              time: date.toISOString(),
              value: numberValue === undefined ? null : numberValue,
              stringValue: textValue === undefined ? null : textValue,
            });
          });
        });
        pageRows.sort((left, right) => parsed.direction === 'oldest'
          ? left.time.localeCompare(right.time) : right.time.localeCompare(left.time));
        return {
          server: server.name,
          job: parsed.job,
          table: value.target.table,
          columns: {
            primary: primary.name,
            time: time.name,
            numericValue: numeric ? numeric.name : null,
            stringValue: stringValue ? stringValue.name : null,
          },
          names: parsed.names,
          direction: parsed.direction,
          timezone: parsed.timezone,
          rowsPerTag: parsed.rowsPerTag,
          rows: pageRows,
          cursor: {
            next: anyHasMore ? encodeCursor({ side: 'next', page: parsed.cursor.page + 1 }) : null,
            previous: parsed.cursor.page > 0
              ? encodeCursor({ side: 'previous', page: parsed.cursor.page - 1 }) : null,
          },
        };
      }, callback);
    },
    stat(params, callback) {
      let selectedJob;
      try { selectedJob = jobDataRequest(params); } catch (failure) { callback(failure); return; }
      withServer(selectedJob.database.server, (connection, server) => {
        const value = metadata(connection, selectedJob.database.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
        const time = roleColumn(value.columns, params.timeColumn, 'basetime', 'timeColumn');
        const rows = rowsOf(connection.query(
          `SELECT MIN(${time.name}) AS MIN_TIME, MAX(${time.name}) AS MAX_TIME FROM ${value.target.table} `
          + `WHERE ${primary.name} IN (${selectedJob.names.map(() => '?').join(', ')})`,
          ...selectedJob.names,
        ));
        const row = rows[0] || {};
        const asIso = (source) => {
          if (source === undefined || source === null || source === '') return null;
          const date = new Date(source);
          return Number.isFinite(date.getTime()) ? date.toISOString() : null;
        };
        return {
          server: server.name,
          job: selectedJob.name,
          table: value.target.table,
          names: selectedJob.names,
          minTime: asIso(rowValue(row, 'MIN_TIME')),
          maxTime: asIso(rowValue(row, 'MAX_TIME')),
        };
      }, callback);
    },
    dataTotal(params, callback) {
      let selectedJob;
      let parsed;
      try {
        selectedJob = jobDataRequest(params);
        parsed = opcuaPageParams(params, selectedJob);
      } catch (failure) { callback(failure); return; }
      withServer(selectedJob.database.server, (connection, server) => {
        const value = metadata(connection, selectedJob.database.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
        const time = roleColumn(value.columns, params.timeColumn, 'basetime', 'timeColumn');
        const clauses = [`${primary.name} IN (${parsed.names.map(() => '?').join(', ')})`];
        const values = parsed.names.slice();
        if (parsed.from) { clauses.push(`${time.name} >= ?`); values.push(parsed.from); }
        if (parsed.to) { clauses.push(`${time.name} <= ?`); values.push(parsed.to); }
        const rows = rowsOf(connection.query(
          `SELECT COUNT(*) AS ROW_COUNT FROM ${value.target.table} WHERE ${clauses.join(' AND ')}`,
          ...values,
        ));
        const total = Number(rowValue(rows[0] || {}, 'ROW_COUNT'));
        if (!Number.isSafeInteger(total) || total < 0) throw invalid('row count를 읽을 수 없습니다.');
        return {
          server: server.name,
          job: selectedJob.name,
          table: value.target.table,
          names: parsed.names,
          total,
          pageSize: parsed.pageSize,
          lastPage: Math.max(1, Math.ceil(total / parsed.pageSize)),
        };
      }, callback);
    },
    chart(params, callback) {
      let selectedJob;
      try { selectedJob = jobDataRequest(params); } catch (failure) { callback(failure); return; }
      let parsed;
      try {
        parsed = {
          names: selectedJob.names,
          job: selectedJob.name,
          from: optionalDate(params.from, 'from'),
          to: optionalDate(params.to, 'to'),
          timezone: timezone(params),
        };
      } catch (failure) { callback(failure); return; }
      withServer(selectedJob.database.server, (connection, server) => {
        const value = metadata(connection, selectedJob.database.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
        const time = roleColumn(value.columns, params.timeColumn, 'basetime', 'timeColumn');
        const numeric = column(value.columns, selectedJob.database.valueColumn, null, (item) => item.numeric, 'valueColumn');
        const clauses = [`${primary.name} IN (${parsed.names.map((name) => `'${escapeSqlString(name)}'`).join(', ')})`];
        if (parsed.from) clauses.push(`${time.name} >= ${formatSqlDateLiteral(parsed.from)}`);
        if (parsed.to) clauses.push(`${time.name} <= ${formatSqlDateLiteral(parsed.to)}`);
        const query = `SELECT ${time.name} AS TIME, ${primary.name} AS NAME, ${numeric.name} AS VALUE `
          + `FROM ${value.target.table} WHERE ${clauses.join(' AND ')} ORDER BY ${time.name} ASC, ${primary.name} ASC`;
        return {
          server: server.name,
          job: parsed.job,
          table: value.target.table,
          columns: { primary: primary.name, time: time.name, numericValue: numeric.name },
          names: parsed.names,
          timezone: parsed.timezone,
          range: {
            from: parsed.from ? parsed.from.toISOString() : null,
            to: parsed.to ? parsed.to.toISOString() : null,
          },
          query,
        };
      }, callback);
    },
  };
}

module.exports = {
  MAX_NAMES,
  MAX_ROWS_PER_TAG,
  MAX_TOTAL_ROWS,
  createDataViewer,
  identifier,
  qualifiedTable,
  rowsOf,
};
