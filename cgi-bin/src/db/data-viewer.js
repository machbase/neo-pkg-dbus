'use strict';

const { error } = require('../config/errors.js');
const { JobRepository } = require('../jobs/repository.js');
const { createServerStore } = require('./server-store.js');

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const MAX_NAMES = 100;
const MAX_ROWS_PER_TAG = 1000;
const MAX_TOTAL_ROWS = 10000;
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

function invalid(reason, details) {
  return error('DB_REQUEST_INVALID', reason, details);
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

function pad(value, size) { return String(value).padStart(size || 2, '0'); }

function formatOffsetTime(date, zone) {
  return date.toISOString();
}

function createDataViewer(options) {
  const settings = options || {};
  const store = settings.serverStore || createServerStore({ cgiRoot: settings.cgiRoot });
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

  function jobDataRequest(params) {
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
    const allowedTags = new Set();
    document.methodCalls.forEach((method) => {
      if (!method || typeof method !== 'object' || !Array.isArray(method.tags)) invalidJob(name);
      method.tags.forEach((tag) => {
        if (!tag || typeof tag.name !== 'string' || !tag.name.trim()) invalidJob(name);
        allowedTags.add(tag.name);
      });
    });
    const requestedNames = namesOf(params.names || params.name);
    const forbidden = requestedNames.filter((tag) => !allowedTags.has(tag));
    if (forbidden.length) throw invalid('선택한 Tag는 이 Job에 속하지 않습니다.', { job: name, names: forbidden });
    if (params.server !== undefined && params.server !== database.server) {
      throw invalid('요청 server가 Job DB 설정과 다릅니다.', { job: name });
    }
    if (params.table !== undefined && qualifiedTable(params.table).table !== table) {
      throw invalid('요청 table이 Job DB 설정과 다릅니다.', { job: name });
    }
    if (params.valueColumn !== undefined && identifier(params.valueColumn, 'valueColumn') !== valueColumn) {
      throw invalid('요청 valueColumn이 Job DB 설정과 다릅니다.', { job: name });
    }
    if (params.stringValueColumn !== undefined) {
      const requestedStringValue = params.stringValueColumn
        ? identifier(params.stringValueColumn, 'stringValueColumn') : null;
      if (requestedStringValue !== stringValueColumn) {
        throw invalid('요청 stringValueColumn이 Job DB 설정과 다릅니다.', { job: name });
      }
    }
    return {
      name,
      names: requestedNames,
      database: { server: database.server, table, valueColumn, stringValueColumn },
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
      try { table = identifier(params.table, 'table'); } catch (failure) { callback(failure); return; }
      withServer(params.server, (connection, server) => {
        connection.exec(`CREATE TAG TABLE ${table} (NAME VARCHAR(100) PRIMARY KEY, TIME DATETIME BASETIME, VALUE DOUBLE SUMMARIZED, STR_VALUE VARCHAR(1024))`);
        return { server: server.name, table, created: true };
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
      try { request(params); } catch (failure) { callback(failure); return; }
      let limit;
      try { limit = positiveInteger(params.limit, 200, MAX_TAGS, 'limit'); } catch (failure) { callback(failure); return; }
      withServer(params.server, (connection, server) => {
        const value = metadata(connection, params.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
        const rows = rowsOf(connection.query(
          `SELECT _ID, ${primary.name} FROM _${value.target.tableName}_META ORDER BY ${primary.name} LIMIT ?`,
          limit + 1,
        ));
        return {
          server: server.name,
          table: value.target.table,
          tags: rows.slice(0, limit).map((row) => ({ name: String(rowValue(row, primary.name)) })),
          limited: rows.length > limit,
          limit,
        };
      }, callback);
    },
    data(params, callback) {
      let selectedJob;
      try { selectedJob = jobDataRequest(params); } catch (failure) { callback(failure); return; }
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
          const selected = ['_RID', primary.name, time.name];
          if (numeric) selected.push(numeric.name);
          if (stringValue) selected.push(stringValue.name);
          const fetchedRows = rowsOf(connection.query(
            `SELECT ${selected.join(', ')} FROM ${value.target.table} WHERE ${clauses.join(' AND ')} `
            + `ORDER BY ${time.name} ${order}, _RID ${order} LIMIT ?, ?`,
            ...values,
          ));
          if (fetchedRows.length > parsed.rowsPerTag) anyHasMore = true;
          const rows = fetchedRows.slice(0, parsed.rowsPerTag);
          rows.forEach((row) => {
            const date = new Date(rowValue(row, time.name));
            if (!Number.isFinite(date.getTime())) return;
            const numberValue = numeric ? rowValue(row, numeric.name) : null;
            const textValue = stringValue ? rowValue(row, stringValue.name) : null;
            const display = textValue === null || textValue === undefined ? numberValue : textValue;
            pageRows.push({
              name: String(rowValue(row, primary.name)),
              time: date.toISOString(),
              value: numberValue === undefined ? null : numberValue,
              stringValue: textValue === undefined ? null : textValue,
              grid: {
                name: String(rowValue(row, primary.name)),
                time: formatOffsetTime(date, parsed.timezone),
                value: display === null || display === undefined ? '' : String(display),
              },
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
          nextCursor: anyHasMore ? encodeCursor({ side: 'next', page: parsed.cursor.page + 1 }) : null,
          previousCursor: parsed.cursor.page > 0
            ? encodeCursor({ side: 'previous', page: parsed.cursor.page - 1 }) : null,
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
          limit: positiveInteger(params.limit, 10000, 10000, 'limit'),
        };
      } catch (failure) { callback(failure); return; }
      withServer(selectedJob.database.server, (connection, server) => {
        const value = metadata(connection, selectedJob.database.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, 'primaryKey', 'primaryColumn');
        const time = roleColumn(value.columns, params.timeColumn, 'basetime', 'timeColumn');
        const numeric = column(value.columns, selectedJob.database.valueColumn, null, (item) => item.numeric, 'valueColumn');
        const clauses = [`${primary.name} IN (${parsed.names.map(() => '?').join(', ')})`];
        const values = parsed.names.slice();
        if (parsed.from) { clauses.push(`${time.name} >= ?`); values.push(parsed.from); }
        if (parsed.to) { clauses.push(`${time.name} <= ?`); values.push(parsed.to); }
        values.push(parsed.limit);
        const rows = rowsOf(connection.query(
          `SELECT ${time.name}, ${primary.name}, ${numeric.name} FROM ${value.target.table} WHERE ${clauses.join(' AND ')} ORDER BY ${time.name} ASC, ${primary.name} ASC LIMIT ?`,
          ...values,
        ));
        const byName = Object.create(null);
        parsed.names.forEach((name) => { byName[name] = []; });
        rows.forEach((row) => {
          const name = String(rowValue(row, primary.name));
          const date = new Date(rowValue(row, time.name));
          const number = Number(rowValue(row, numeric.name));
          if (Object.prototype.hasOwnProperty.call(byName, name)
            && Number.isFinite(date.getTime()) && Number.isFinite(number)) {
            byName[name].push({ time: date.toISOString(), value: number });
          }
        });
        return {
          server: server.name,
          job: parsed.job,
          table: value.target.table,
          columns: { primary: primary.name, time: time.name, numericValue: numeric.name },
          names: parsed.names,
          timezone: parsed.timezone,
          series: parsed.names.map((name) => ({ name, points: byName[name] })),
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
