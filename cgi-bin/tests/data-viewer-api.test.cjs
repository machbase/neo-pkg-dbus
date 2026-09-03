'use strict';

const assert = require('node:assert/strict');
const { error } = require('../src/config/errors.js');
const { createDataViewer, rowsOf } = require('../src/db/data-viewer.js');

function call(target, method, ...args) {
  if ((method === 'data' || method === 'chart' || method === 'stat' || method === 'tags') && args[0]) {
    args[0] = { job: 'line-a', server: 'local-db', table: 'TAG', ...args[0] };
  }
  return rawCall(target, method, ...args).then((value) => {
    if (method === 'data' && value && value.cursor) {
      Object.defineProperties(value, {
        nextCursor: { value: value.cursor.next, enumerable: false },
        previousCursor: { value: value.cursor.previous, enumerable: false },
      });
    }
    return value;
  });
}

function rawCall(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (failure, value) => {
    if (failure) reject(failure);
    else resolve(value);
  }));
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (failure) => {
    assert.equal(failure && failure.code, code);
    assert.equal(JSON.stringify(failure).includes('secret'), false);
    return true;
  });
}

function jobDocument(name, overrides) {
  return {
    schemaVersion: 1,
    name,
    database: { server: 'local-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' },
    methodCalls: [{ tags: [{ name: '%MB3' }, { name: '%MB4' }] }],
    ...(overrides || {}),
  };
}

function dataRow(name, time, value, stringValue) {
  return {
    NAME: name,
    TIME: new Date(time),
    VALUE: value === undefined ? 1 : value,
    STR_VALUE: stringValue === undefined ? null : stringValue,
  };
}

function decodedCursor(cursor) {
  return JSON.parse(decodeURIComponent(cursor));
}

function fixture(options) {
  const settings = options || {};
  const calls = [];
  let dataQueryIndex = 0;
  const columns = settings.columns || [
    { NAME: 'NAME', TYPE: 5, ID: 0, LENGTH: 100, FLAG: 0x8000000 },
    { NAME: 'TIME', TYPE: 6, ID: 1, LENGTH: 0, FLAG: 0x1000000 },
    { NAME: 'VALUE', TYPE: 20, ID: 2, LENGTH: 0, FLAG: 0x2000000 },
    { NAME: 'STR_VALUE', TYPE: 5, ID: 3, LENGTH: 1024, FLAG: 0 },
  ];
  const primaryColumn = (columns.find((column) => Number(column.FLAG) & 0x8000000) || {}).NAME || null;
  const connection = {
    query(sql, ...values) {
      calls.push({ type: 'query', sql, values });
      if (sql.includes('M$SYS_USERS')) return [{ USER_ID: 1, NAME: 'SYS' }];
      if (sql.includes('M$SYS_TABLES') && sql.includes('TYPE IN')) return [{ NAME: 'TAG', TYPE: 6, ID: 7, USER_ID: 1 }];
      if (/SELECT ID FROM M\$SYS_TABLES/.test(sql)) return settings.existingTable ? [{ ID: 7 }] : [];
      if (sql.includes('M$SYS_TABLES') && sql.includes('SELECT ID')) return [{ ID: 7, TYPE: 6, NAME: 'TAG' }];
      if (sql.includes('M$SYS_COLUMNS')) return columns;
      if (sql.includes('_TAG_META') && sql.includes('WHERE')) return settings.hierarchyRows || [];
      if (sql.includes('_TAG_META')) return settings.metaRows || [{ _ID: 1, [primaryColumn]: '%MB3' }, { _ID: 2, [primaryColumn]: '%MB4' }];
      if (sql.includes('MIN(') && sql.includes('MAX(')) {
        return [{ MIN_TIME: new Date('2026-08-01T00:00:00.000Z'), MAX_TIME: new Date('2026-08-03T00:00:00.000Z') }];
      }
      if (sql.includes('COUNT(*) AS ROW_COUNT')) return [{ ROW_COUNT: 42 }];
      if (sql.includes('FROM TAG') && sql.includes(`${primaryColumn} IN`) && sql.startsWith(`SELECT ${primaryColumn},`)) {
        const selectedRows = [
          { [primaryColumn]: '%MB3', TIME: new Date('2026-08-03T00:00:00.000Z'), VALUE: 12.5, STR_VALUE: null },
          { [primaryColumn]: '%MB4', TIME: new Date('2026-08-03T00:00:01.000Z'), VALUE: 8.5, STR_VALUE: null },
        ].filter((row) => values.includes(row[primaryColumn]));
        const offset = Number(values.at(-2));
        const limit = Number(values.at(-1));
        return Number.isInteger(offset) && Number.isInteger(limit) ? selectedRows.slice(offset, offset + limit) : selectedRows;
      }
      if (sql.includes('FROM TAG') && sql.includes(`${primaryColumn} = ?`)) {
        const tag = values[0];
        if (settings.dataRows) {
          const rows = settings.dataRows({ tag, sql, values, index: dataQueryIndex });
          dataQueryIndex += 1;
          return rows;
        }
        return tag === '%MB3'
          ? [{ NAME: tag, TIME: new Date('2026-08-03T00:00:00.000Z'), VALUE: 12.5, STR_VALUE: null }]
          : [{ NAME: tag, TIME: new Date('2026-08-03T00:00:01.000Z'), VALUE: null, STR_VALUE: 'ready' }];
      }
      if (sql.includes('FROM TAG') && sql.includes(`${primaryColumn} IN`)) return settings.chartRows || [
        { NAME: '%MB3', TIME: new Date('2026-08-03T00:00:00.000Z'), VALUE: 12.5 },
      ];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    exec(sql, ...values) {
      calls.push({ type: 'exec', sql, values });
      return 1;
    },
    close() { calls.push({ type: 'close' }); },
  };
  const viewer = createDataViewer({
    productPolicy: settings.productPolicy,
    jobRepository: settings.jobRepository || {
      read(name) {
        if (name === 'line-a') return jobDocument(name);
        if (name === 'line-b') return jobDocument(name, {
          methodCalls: [{ tags: [{ name: 'OTHER-JOB-TAG' }] }],
        });
        throw error('JOB_NOT_FOUND', 'Job을 찾을 수 없습니다.', { name });
      },
    },
    serverStore: {
      get(name, callback) {
        callback(null, name === 'local-db' ? {
          schemaVersion: 1, name, host: '127.0.0.1', port: 5656, user: 'sys', password: 'secret',
        } : null);
      },
    },
    connectionFactory(config) {
      assert.equal(config.password, 'secret');
      return connection;
    },
  });
  return { viewer, calls };
}

function testRowsCloseExactlyOnce() {
  let closed = 0;
  const rows = rowsOf({
    *[Symbol.iterator]() { yield { value: 1 }; yield { value: 2 }; },
    close() { closed += 1; },
  });
  assert.deepEqual(rows, [{ value: 1 }, { value: 2 }]);
  assert.equal(closed, 1);

  let failedClose = 0;
  assert.throws(() => rowsOf({
    *[Symbol.iterator]() { yield { value: 1 }; throw new Error('iteration failed'); },
    close() { failedClose += 1; },
  }), /iteration failed/);
  assert.equal(failedClose, 1);
}

async function testQueryFailureClosesConnection() {
  let connectionClosed = 0;
  const viewer = createDataViewer({
    serverStore: { get(_name, callback) { callback(null, {
      name: 'local-db', host: 'localhost', port: 5656, user: 'sys', password: 'hidden',
    }); } },
    connectionFactory() {
      return {
        query() { throw new Error('query failed'); },
        close() { connectionClosed += 1; },
      };
    },
  });
  await rejectsCode(call(viewer, 'listTables', { server: 'local-db' }), 'DB_UNAVAILABLE');
  assert.equal(connectionClosed, 1);
}

async function testJobScopedDataViewer() {
  await rejectsCode(rawCall(fixture().viewer, 'data', {
    job: 'line-a', names: ['%MB3'],
  }), 'JOB_DATA_SOURCE_MISMATCH');
  await rejectsCode(rawCall(fixture().viewer, 'chart', {
    job: 'line-a', server: 'local-db', names: ['%MB3'],
  }), 'JOB_DATA_SOURCE_MISMATCH');
  const derived = fixture();
  const page = await call(derived.viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'],
  });
  assert.equal(page.server, 'local-db');
  assert.equal(page.table, 'TAG');
  assert.deepEqual(page.columns, {
    primary: 'NAME', time: 'TIME', numericValue: 'VALUE', stringValue: 'STR_VALUE',
  });
  const publicPage = await rawCall(derived.viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'],
  });
  assert.deepEqual(publicPage.cursor, { next: null, previous: null });
  assert.equal(Object.prototype.hasOwnProperty.call(publicPage, 'nextCursor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicPage, 'previousCursor'), false);

  const numericOnly = fixture({
    jobRepository: {
      read(name) {
        return jobDocument(name, {
          database: { server: 'local-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: '' },
        });
      },
    },
  });
  const numericPage = await call(numericOnly.viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'],
  });
  assert.equal(numericPage.columns.stringValue, null);
  assert.equal(numericPage.rows[0].stringValue, null);
  assert.equal(Object.prototype.hasOwnProperty.call(numericPage.rows[0], 'grid'), false);
  const numericQuery = numericOnly.calls.find((entry) => entry.type === 'query' && entry.sql.includes('FROM TAG'));
  assert.equal(numericQuery.sql.includes('STR_VALUE'), false);

  await rejectsCode(rawCall(fixture().viewer, 'data', {
    job: 'missing', names: ['%MB3'],
  }), 'JOB_NOT_FOUND');
  const otherTag = await call(fixture().viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['OTHER-JOB-TAG'],
  });
  assert.deepEqual(otherTag.names, ['OTHER-JOB-TAG']);
  const otherChartTag = await call(fixture().viewer, 'chart', {
    job: 'line-a', names: ['OTHER-JOB-TAG'],
  });
  assert.deepEqual(otherChartTag.names, ['OTHER-JOB-TAG']);
  await rejectsCode(call(fixture().viewer, 'data', {
    job: 'line-a', server: 'other-db', table: 'TAG', names: ['%MB3'],
  }), 'JOB_DATA_SOURCE_MISMATCH');
  await rejectsCode(call(fixture().viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'OTHER', names: ['%MB3'],
  }), 'JOB_DATA_SOURCE_MISMATCH');
  await rejectsCode(call(fixture().viewer, 'chart', {
    job: 'line-a', valueColumn: 'STR_VALUE', names: ['%MB3'],
  }), 'JOB_DATA_SOURCE_MISMATCH');

  const sameTable = fixture();
  const own = await call(sameTable.viewer, 'data', { job: 'line-b', names: ['OTHER-JOB-TAG'] });
  assert.deepEqual(own.names, ['OTHER-JOB-TAG']);
  assert.equal(sameTable.calls.some((entry) => entry.type === 'query'
    && entry.sql.includes('FROM TAG') && entry.values[0] === '%MB3'), false);

  const invalidStored = fixture({
    jobRepository: { read() { return jobDocument('different-name'); } },
  });
  await rejectsCode(call(invalidStored.viewer, 'data', {
    job: 'line-a', names: ['%MB3'],
  }), 'JOB_INVALID_CONFIG');
  const invalidSchema = fixture({
    jobRepository: { read() { return jobDocument('line-a', { schemaVersion: 2 }); } },
  });
  await rejectsCode(call(invalidSchema.viewer, 'data', {
    job: 'line-a', names: ['%MB3'],
  }), 'JOB_INVALID_CONFIG');
}

async function testOpcuaViewerCanReadAnyTagInTheMappedTable() {
  const source = fixture({
    jobRepository: {
      read(name) {
        return jobDocument(name, { methodCalls: [{ tags: [{ name: '%MB3' }] }] });
      },
    },
  });
  const page = await rawCall(source.viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB4'],
    page: 1, pageSize: 20,
  });
  assert.equal(page.rows[0].name, '%MB4');
}

async function testOpcuaViewerReadsSelectedTagTimeBounds() {
  const source = fixture();
  const result = await rawCall(source.viewer, 'stat', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3', '%MB4'],
  });
  assert.deepEqual(result, {
    server: 'local-db', job: 'line-a', table: 'TAG', names: ['%MB3', '%MB4'],
    minTime: '2026-08-01T00:00:00.000Z', maxTime: '2026-08-03T00:00:00.000Z',
  });
}

async function testOpcuaViewerRawPageUsesOneSharedPage() {
  const source = fixture({
    chartRows: [],
  });
  const page = await rawCall(source.viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3', '%MB4'],
    direction: 'latest', page: 2, pageSize: 1,
  });
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 1);
  assert.equal(page.rows.length, 1);
  const query = source.calls.find((entry) => entry.type === 'query' && entry.sql.includes('FROM TAG'));
  assert.match(query.sql, /NAME IN \(\?, \?\)/);
  assert.match(query.sql, /ORDER BY TIME DESC, NAME ASC LIMIT \?, \?/);
}

async function testOpcuaViewerReadsTheLastRawPageCount() {
  const source = fixture();
  const result = await rawCall(source.viewer, 'dataTotal', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], pageSize: 20,
  });
  assert.deepEqual(result, {
    server: 'local-db', job: 'line-a', table: 'TAG', names: ['%MB3'], total: 42, pageSize: 20, lastPage: 3,
  });
}

async function run() {
  testRowsCloseExactlyOnce();
  await testQueryFailureClosesConnection();
  await testJobScopedDataViewer();
  await testOpcuaViewerCanReadAnyTagInTheMappedTable();
  await testOpcuaViewerReadsSelectedTagTimeBounds();
  await testOpcuaViewerRawPageUsesOneSharedPage();
  await testOpcuaViewerReadsTheLastRawPageCount();
  const connected = fixture();
  assert.deepEqual(await call(connected.viewer, 'connect', { server: 'local-db' }), {
    server: 'local-db', connected: true, host: '127.0.0.1', port: 5656, user: 'sys',
  });

  const created = fixture();
  assert.deepEqual(await call(created.viewer, 'createTable', {
    server: 'local-db', table: 'TAG_NEW', valueColumn: 'MEASURE', stringValueColumn: null,
  }), {
    server: 'local-db', table: 'TAG_NEW', primaryKeyColumn: 'NAME', basetimeColumn: 'TIME',
    valueColumn: 'MEASURE', stringValueColumn: null,
  });
  const ddl = created.calls.find((entry) => entry.type === 'exec');
  assert.match(ddl.sql, /^CREATE TAG TABLE TAG_NEW /);
  assert.match(ddl.sql, /MEASURE DOUBLE SUMMARIZED/);
  assert.equal(ddl.sql.includes('STR_VALUE'), false);
  await rejectsCode(call(created.viewer, 'createTable', {
    server: 'local-db', table: 'TAG_NEW', valueColumn: '',
  }), 'TABLE_INVALID');
  await rejectsCode(call(fixture({ existingTable: true }).viewer, 'createTable', {
    server: 'local-db', table: 'TAG_EXISTS', valueColumn: 'VALUE',
  }), 'TABLE_ALREADY_EXISTS');

  const listed = fixture();
  assert.deepEqual(await call(listed.viewer, 'listTables', { server: 'local-db' }), [
    { name: 'TAG', user: 'SYS', type: 'TAG' },
  ]);

  const metadata = fixture();
  assert.deepEqual(await call(metadata.viewer, 'columns', { server: 'local-db', table: 'TAG' }), {
    server: 'local-db',
    table: 'TAG',
    tableType: 'TAG',
    columns: [
      { name: 'NAME', type: 'varchar(100)', primaryKey: true, basetime: false, summarized: false, metadata: false, numeric: false, string: true },
      { name: 'TIME', type: 'datetime', primaryKey: false, basetime: true, summarized: false, metadata: false, numeric: false, string: false },
      { name: 'VALUE', type: 'double', primaryKey: false, basetime: false, summarized: true, metadata: false, numeric: true, string: false },
      { name: 'STR_VALUE', type: 'varchar(1024)', primaryKey: false, basetime: false, summarized: false, metadata: false, numeric: false, string: true },
    ],
    primaryColumn: 'NAME',
    timeColumn: 'TIME',
    numericValueColumns: ['VALUE'],
    stringValueColumns: ['STR_VALUE'],
  });

  const tags = fixture();
  assert.deepEqual(await call(tags.viewer, 'tags', { server: 'local-db', table: 'TAG', limit: '1' }), {
    server: 'local-db', table: 'TAG', tags: [{ id: '1', name: '%MB3' }], assetHierarchy: null, limited: true, limit: 1,
  });

  const lsScopedTags = fixture({ productPolicy: { target: 'ls' } });
  assert.deepEqual(await call(lsScopedTags.viewer, 'tags', { job: 'line-b', server: 'local-db', table: 'TAG' }), {
    server: 'local-db', table: 'TAG', tags: [{ id: null, name: 'OTHER-JOB-TAG', treePath: ['Call 1', 'OTHER-JOB-TAG'] }], assetHierarchy: null, limited: false, limit: 1,
  });
  assert.equal(lsScopedTags.calls.some((entry) => entry.type === 'query'), false, 'LS Tag 목록은 shared table metadata를 읽지 않습니다.');

  const alternateRoles = fixture({
    columns: [
      { NAME: 'TAG_ID', TYPE: 5, ID: 0, LENGTH: 100, FLAG: 0x8000000 },
      { NAME: 'TS', TYPE: 6, ID: 1, LENGTH: 0, FLAG: 0x1000000 },
      { NAME: 'VALUE', TYPE: 20, ID: 2, LENGTH: 0, FLAG: 0x2000000 },
      { NAME: 'STR_VALUE', TYPE: 5, ID: 3, LENGTH: 1024, FLAG: 0 },
    ],
    dataRows({ tag }) {
      return [{ TAG_ID: tag, TS: new Date('2026-08-03T00:00:00.000Z'), VALUE: 12.5, STR_VALUE: null }];
    },
    chartRows: [{ TAG_ID: '%MB3', TS: new Date('2026-08-03T00:00:00.000Z'), VALUE: 12.5 }],
  });
  assert.deepEqual(await call(alternateRoles.viewer, 'tags', { server: 'local-db', table: 'TAG' }), {
    server: 'local-db', table: 'TAG', tags: [{ id: '1', name: '%MB3' }, { id: '2', name: '%MB4' }], assetHierarchy: null, limited: false, limit: 200,
  });
  const alternateTagQuery = alternateRoles.calls.find((entry) => entry.type === 'query' && entry.sql.includes('_TAG_META'));
  assert.match(alternateTagQuery.sql, /SELECT \* FROM _TAG_META WHERE TAG_ID = \?/);

  const assetHierarchy = {
    column: 'asset', schema: ['site', 'line'], tree: [{ key: 'site', value: 'A', children: [{ key: 'line', value: '1', children: [] }] }],
  };
  const assetTags = fixture({
    hierarchyRows: [{ NAME: '__machbase_hierarchy__', HIERARCHY: JSON.stringify(assetHierarchy) }],
    metaRows: [
      { _ID: 1, NAME: '__machbase_hierarchy__' },
      { _ID: 2, NAME: '%MB3', ASSET: '{"site":"A","line":"1"}' },
    ],
  });
  assert.deepEqual(await call(assetTags.viewer, 'tags', { server: 'local-db', table: 'TAG' }), {
    server: 'local-db', table: 'TAG', tags: [{ id: '2', name: '%MB3', asset: { site: 'A', line: '1' } }],
    assetHierarchy, limited: false, limit: 200,
  });
  assert.deepEqual(await call(assetTags.viewer, 'tags', { server: 'local-db', table: 'TAG', limit: '1' }), {
    server: 'local-db', table: 'TAG', tags: [{ id: '2', name: '%MB3', asset: { site: 'A', line: '1' } }],
    assetHierarchy, limited: false, limit: 1,
  });

  const alternatePage = await call(alternateRoles.viewer, 'data', {
    job: 'line-a', names: ['%MB3'],
  });
  assert.deepEqual(alternatePage.columns, {
    primary: 'TAG_ID', time: 'TS', numericValue: 'VALUE', stringValue: 'STR_VALUE',
  });
  assert.equal(alternatePage.rows[0].name, '%MB3');
  const alternateDataQuery = alternateRoles.calls.find((entry) => entry.type === 'query' && entry.sql.includes('FROM TAG'));
  assert.match(alternateDataQuery.sql, /SELECT TAG_ID, TS, VALUE, STR_VALUE FROM TAG WHERE TAG_ID = \?/);
  assert.match(alternateDataQuery.sql, /ORDER BY TS DESC LIMIT \?, \?/);
  assert.equal(alternateDataQuery.sql.includes('_RID'), false);

  const alternateChart = await call(alternateRoles.viewer, 'chart', {
    job: 'line-a', names: ['%MB3'],
  });
  assert.deepEqual(alternateChart.columns, { primary: 'TAG_ID', time: 'TS', numericValue: 'VALUE' });
  assert.match(alternateChart.query, /SELECT TS AS TIME, TAG_ID AS NAME, VALUE AS VALUE FROM TAG/);
  assert.match(alternateChart.query, /TAG_ID IN \('%MB3'\)/);

  await rejectsCode(call(alternateRoles.viewer, 'tags', {
    server: 'local-db', table: 'TAG', primaryColumn: 'VALUE',
  }), 'DB_REQUEST_INVALID');
  await rejectsCode(call(alternateRoles.viewer, 'data', {
    job: 'line-a', names: ['%MB3'], primaryColumn: 'VALUE',
  }), 'DB_REQUEST_INVALID');
  await rejectsCode(call(alternateRoles.viewer, 'chart', {
    job: 'line-a', names: ['%MB3'], timeColumn: 'VALUE',
  }), 'DB_REQUEST_INVALID');

  const duplicatePrimary = fixture({
    columns: [
      { NAME: 'NAME', TYPE: 5, ID: 0, LENGTH: 100, FLAG: 0x8000000 },
      { NAME: 'OTHER_NAME', TYPE: 5, ID: 1, LENGTH: 100, FLAG: 0x8000000 },
      { NAME: 'TIME', TYPE: 6, ID: 2, LENGTH: 0, FLAG: 0x1000000 },
      { NAME: 'VALUE', TYPE: 20, ID: 3, LENGTH: 0, FLAG: 0x2000000 },
      { NAME: 'STR_VALUE', TYPE: 5, ID: 4, LENGTH: 1024, FLAG: 0 },
    ],
  });
  await rejectsCode(call(duplicatePrimary.viewer, 'tags', {
    server: 'local-db', table: 'TAG', primaryColumn: 'NAME',
  }), 'DB_REQUEST_INVALID');

  const noPrimary = fixture({
    columns: [
      { NAME: 'NAME', TYPE: 5, ID: 0, LENGTH: 100, FLAG: 0 },
      { NAME: 'TIME', TYPE: 6, ID: 1, LENGTH: 0, FLAG: 0x1000000 },
      { NAME: 'VALUE', TYPE: 20, ID: 2, LENGTH: 0, FLAG: 0x2000000 },
      { NAME: 'STR_VALUE', TYPE: 5, ID: 3, LENGTH: 1024, FLAG: 0 },
    ],
  });
  await rejectsCode(call(noPrimary.viewer, 'tags', {
    server: 'local-db', table: 'TAG',
  }), 'DB_REQUEST_INVALID');

  const duplicateBasetime = fixture({
    columns: [
      { NAME: 'NAME', TYPE: 5, ID: 0, LENGTH: 100, FLAG: 0x8000000 },
      { NAME: 'TIME', TYPE: 6, ID: 1, LENGTH: 0, FLAG: 0x1000000 },
      { NAME: 'OTHER_TIME', TYPE: 6, ID: 2, LENGTH: 0, FLAG: 0x1000000 },
      { NAME: 'VALUE', TYPE: 20, ID: 3, LENGTH: 0, FLAG: 0x2000000 },
      { NAME: 'STR_VALUE', TYPE: 5, ID: 4, LENGTH: 1024, FLAG: 0 },
    ],
  });
  await rejectsCode(call(duplicateBasetime.viewer, 'data', {
    job: 'line-a', names: ['%MB3'], timeColumn: 'TIME',
  }), 'DB_REQUEST_INVALID');

  const noBasetime = fixture({
    columns: [
      { NAME: 'NAME', TYPE: 5, ID: 0, LENGTH: 100, FLAG: 0x8000000 },
      { NAME: 'TIME', TYPE: 6, ID: 1, LENGTH: 0, FLAG: 0 },
      { NAME: 'VALUE', TYPE: 20, ID: 2, LENGTH: 0, FLAG: 0x2000000 },
      { NAME: 'STR_VALUE', TYPE: 5, ID: 3, LENGTH: 1024, FLAG: 0 },
    ],
  });
  await rejectsCode(call(noBasetime.viewer, 'chart', {
    job: 'line-a', names: ['%MB3'],
  }), 'DB_REQUEST_INVALID');

  const data = fixture();
  const page = await call(data.viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3', '%MB4'], primaryColumn: 'NAME', timeColumn: 'TIME',
    valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE', direction: 'latest', rowsPerTag: '2',
    from: '2026-08-01T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z',
  });
  assert.equal(page.rows.length, 2);
  assert.equal(page.job, 'line-a');
  assert.deepEqual(page.columns, {
    primary: 'NAME', time: 'TIME', numericValue: 'VALUE', stringValue: 'STR_VALUE',
  });
  assert.deepEqual(page.rows.find((row) => row.name === '%MB3'), {
    name: '%MB3', time: '2026-08-03T00:00:00.000Z', value: 12.5, stringValue: null,
  });
  assert.equal(page.nextCursor, null);
  assert.equal(page.previousCursor, null);
  const dataQuery = data.calls.find((entry) => entry.type === 'query' && entry.sql.includes('FROM TAG'));
  assert.match(dataQuery.sql, /NAME = \?/);
  assert.equal(dataQuery.sql.includes('%MB3'), false);
  assert.deepEqual(dataQuery.values.slice(0, 3), ['%MB3', new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-04T00:00:00.000Z')]);

  const multiTag = fixture({
    jobRepository: {
      read() {
        return jobDocument('line-a', {
          methodCalls: [{ tags: [{ name: '%MB3' }, { name: '%MB4' }, { name: '%EMPTY' }] }],
        });
      },
    },
    dataRows({ tag, values }) {
      const rows = tag === '%EMPTY' ? [] : (tag === '%MB3' ? [
        dataRow(tag, '2026-08-03T00:00:04.000Z'),
        dataRow(tag, '2026-08-03T00:00:03.000Z'),
        dataRow(tag, '2026-08-03T00:00:02.000Z'),
      ] : [
        dataRow(tag, '2026-08-03T00:00:04.000Z', null, 'new'),
        dataRow(tag, '2026-08-03T00:00:03.000Z', null, 'old'),
      ]);
      return rows.slice(values.at(-2), values.at(-2) + values.at(-1));
    },
  });
  const multiTagPage = await call(multiTag.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4', '%EMPTY'], direction: 'latest', rowsPerTag: '2',
  });
  assert.equal(multiTagPage.rows.length, 4);
  assert.equal(typeof multiTagPage.nextCursor, 'string');
  assert.deepEqual(decodedCursor(multiTagPage.nextCursor), {
    side: 'next', page: 1,
  });
  const multiTagNextPage = await call(multiTag.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4', '%EMPTY'], direction: 'latest', rowsPerTag: '2',
    cursor: multiTagPage.nextCursor,
  });
  assert.deepEqual(multiTagNextPage.rows.map((row) => [row.name, row.time]), [
    ['%MB3', '2026-08-03T00:00:02.000Z'],
  ]);
  assert.equal(multiTagNextPage.nextCursor, null);

  const oldest = fixture({
    dataRows({ tag, values }) {
      return [
        dataRow(tag, '2026-08-03T00:00:00.000Z'),
        dataRow(tag, '2026-08-03T00:00:01.000Z'),
        dataRow(tag, '2026-08-03T00:00:02.000Z'),
      ].slice(values.at(-2), values.at(-2) + values.at(-1));
    },
  });
  const oldestPage = await call(oldest.viewer, 'data', {
    job: 'line-a', names: ['%MB3'], direction: 'oldest', rowsPerTag: '2',
  });
  assert.deepEqual(oldestPage.rows.map((row) => row.time), [
    '2026-08-03T00:00:00.000Z',
    '2026-08-03T00:00:01.000Z',
  ]);
  assert.deepEqual(decodedCursor(oldestPage.nextCursor), {
    side: 'next', page: 1,
  });

  const pagedRows = [
    dataRow('%MB3', '2026-08-03T00:00:04.000Z'),
    dataRow('%MB3', '2026-08-03T00:00:03.000Z'),
    dataRow('%MB3', '2026-08-03T00:00:02.000Z'),
    dataRow('%MB3', '2026-08-03T00:00:01.000Z'),
  ];
  const paged = fixture({
    dataRows({ values }) { return pagedRows.slice(values.at(-2), values.at(-2) + values.at(-1)); },
  });
  const firstPage = await call(paged.viewer, 'data', {
    job: 'line-a', names: ['%MB3'], direction: 'latest', rowsPerTag: '2',
  });
  const secondPage = await call(paged.viewer, 'data', {
    job: 'line-a', names: ['%MB3'], direction: 'latest', rowsPerTag: '2', cursor: firstPage.nextCursor,
  });
  assert.deepEqual(secondPage.rows.map((row) => row.time), [
    '2026-08-03T00:00:02.000Z',
    '2026-08-03T00:00:01.000Z',
  ]);
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(decodedCursor(secondPage.previousCursor), {
    side: 'previous', page: 0,
  });
  const returnedPage = await call(paged.viewer, 'data', {
    job: 'line-a', names: ['%MB3'], direction: 'latest', rowsPerTag: '2', cursor: secondPage.previousCursor,
  });
  assert.deepEqual(returnedPage.rows.map((row) => row.time), [
    '2026-08-03T00:00:04.000Z',
    '2026-08-03T00:00:03.000Z',
  ]);

  const staggered = fixture({
    dataRows({ tag, sql, values }) {
      const ascending = /ORDER BY TIME ASC/.test(sql);
      const source = tag === '%MB4' ? [5, 4] : [8, 7, 6, 5, 4, 3];
      const ordered = (ascending ? source.slice().reverse() : source)
        .map((second) => dataRow(tag, `2026-08-03T00:00:0${second}.000Z`));
      return ordered.slice(values.at(-2), values.at(-2) + values.at(-1));
    },
  });
  const staggeredFirst = await call(staggered.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'latest', rowsPerTag: '2',
  });
  const staggeredSecond = await call(staggered.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'latest', rowsPerTag: '2',
    cursor: staggeredFirst.nextCursor,
  });
  const staggeredThird = await call(staggered.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'latest', rowsPerTag: '2',
    cursor: staggeredSecond.nextCursor,
  });
  assert.deepEqual(staggeredThird.rows.map((row) => row.name), ['%MB3', '%MB3']);
  const staggeredBackToSecond = await call(staggered.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'latest', rowsPerTag: '2',
    cursor: staggeredThird.previousCursor,
  });
  assert.deepEqual(staggeredBackToSecond.rows.map((row) => [row.name, row.time]), [
    ['%MB3', '2026-08-03T00:00:06.000Z'],
    ['%MB3', '2026-08-03T00:00:05.000Z'],
  ]);
  const staggeredBackToFirst = await call(staggered.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'latest', rowsPerTag: '2',
    cursor: staggeredBackToSecond.previousCursor,
  });
  assert.deepEqual(staggeredBackToFirst.rows.map((row) => [row.name, row.time]), [
    ['%MB3', '2026-08-03T00:00:08.000Z'],
    ['%MB3', '2026-08-03T00:00:07.000Z'],
    ['%MB4', '2026-08-03T00:00:05.000Z'],
    ['%MB4', '2026-08-03T00:00:04.000Z'],
  ]);

  const oldestGap = fixture({
    dataRows({ tag, values }) {
      const source = tag === '%MB4' ? [1, 2] : [1, 2, 3, 4];
      return source.map((second) => dataRow(tag, `2026-08-03T00:00:0${second}.000Z`))
        .slice(values.at(-2), values.at(-2) + values.at(-1));
    },
  });
  const oldestGapFirst = await call(oldestGap.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'oldest', rowsPerTag: '2',
  });
  const oldestGapSecond = await call(oldestGap.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'oldest', rowsPerTag: '2',
    cursor: oldestGapFirst.nextCursor,
  });
  assert.deepEqual(oldestGapSecond.rows.map((row) => row.name), ['%MB3', '%MB3']);
  const oldestGapReturned = await call(oldestGap.viewer, 'data', {
    job: 'line-a', names: ['%MB3', '%MB4'], direction: 'oldest', rowsPerTag: '2',
    cursor: oldestGapSecond.previousCursor,
  });
  assert.deepEqual(oldestGapReturned.rows.map((row) => [row.name, row.time]), [
    ['%MB3', '2026-08-03T00:00:01.000Z'],
    ['%MB4', '2026-08-03T00:00:01.000Z'],
    ['%MB3', '2026-08-03T00:00:02.000Z'],
    ['%MB4', '2026-08-03T00:00:02.000Z'],
  ]);

  const specialNames = ['__proto__', 'constructor'];
  const special = fixture({
    jobRepository: {
      read(name) {
        return jobDocument(name, {
          methodCalls: [{ tags: specialNames.map((tagName) => ({ name: tagName })) }],
        });
      },
    },
    dataRows({ tag, values }) {
      return [
        dataRow(tag, '2026-08-03T00:00:03.000Z'),
        dataRow(tag, '2026-08-03T00:00:02.000Z'),
        dataRow(tag, '2026-08-03T00:00:01.000Z'),
      ].slice(values.at(-2), values.at(-2) + values.at(-1));
    },
  });
  const specialPage = await call(special.viewer, 'data', {
    job: 'line-a', names: specialNames, direction: 'latest', rowsPerTag: '2',
  });
  assert.deepEqual(specialPage.rows.map((row) => row.name), [
    '__proto__', 'constructor', '__proto__', 'constructor',
  ]);
  assert.deepEqual(decodedCursor(specialPage.nextCursor), { side: 'next', page: 1 });

  const malformedCursors = [
    { side: 'sideways', page: 0 },
    { side: 'next', page: -1 },
    { side: 'next', page: 1.5 },
    { side: 'next', page: '1' },
    { side: 'next', page: Number.MAX_SAFE_INTEGER },
    { side: 'next' },
    { page: 0 },
    { side: 'next', page: 0, offset: 1 },
    { side: 'next', positions: {} },
    {},
    [],
  ];
  for (const malformedCursor of malformedCursors) {
    await rejectsCode(call(fixture().viewer, 'data', {
      job: 'line-a', names: ['%MB3'], direction: 'latest', rowsPerTag: '2',
      cursor: encodeURIComponent(JSON.stringify(malformedCursor)),
    }), 'DB_REQUEST_INVALID');
  }

  const manyNames = Array.from({ length: 100 }, (_, index) => `tag-${String(index).padStart(3, '0')}`);
  const many = fixture({
    jobRepository: {
      read(name) {
        return jobDocument(name, {
          methodCalls: [{ tags: manyNames.map((tagName) => ({ name: tagName })) }],
        });
      },
    },
    dataRows({ tag, values }) {
      const tagNumber = Number(tag.slice(-3));
      const seconds = tagNumber % 2 === 0 ? [9, 8, 7, 6, 5, 4, 3, 2, 1] : [9, 8];
      return seconds.map((second) => dataRow(
        tag, `2026-08-03T00:00:0${second}.000Z`,
      )).slice(values.at(-2), values.at(-2) + values.at(-1));
    },
  });
  const boundedCursorLengths = [];
  let manyCursor = null;
  for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
    const manyPage = await call(many.viewer, 'data', {
      job: 'line-a', names: manyNames, direction: 'latest', rowsPerTag: '2',
      cursor: manyCursor,
    });
    manyCursor = manyPage.nextCursor;
    const queryBytes = Buffer.byteLength(new URLSearchParams({ cursor: manyCursor }).toString(), 'utf8');
    boundedCursorLengths.push(queryBytes);
    assert.equal(queryBytes < 16 * 1024, true, `page ${pageNumber + 1} cursor exceeds CGI query limit`);
  }
  assert.equal(new Set(boundedCursorLengths).size, 1, 'cursor bytes must not grow with page count');

  const offsetRows = {
    '%MB3': [5, 4, 3, 2, 1].map((value) => ({
      NAME: '%MB3', TIME: new Date(`2026-08-03T00:00:0${value}.000Z`), VALUE: value, STR_VALUE: null,
    })),
    '%MB4': [3, 2, 1].map((value) => ({
      NAME: '%MB4', TIME: new Date(`2026-08-03T00:00:0${value}.000Z`), VALUE: value * 10, STR_VALUE: null,
    })),
  };
  const offsetFixture = fixture({
    dataRows({ tag, sql, values }) {
      assert.match(sql, /ORDER BY TIME (ASC|DESC) LIMIT \?, \?/);
      assert.equal(sql.includes('_RID'), false);
      const ascending = /ORDER BY TIME ASC LIMIT/.test(sql);
      const ordered = offsetRows[tag].slice().sort((left, right) => {
        const timeOrder = left.TIME.getTime() - right.TIME.getTime();
        return ascending ? timeOrder : -timeOrder;
      });
      return ordered.slice(values.at(-2), values.at(-2) + values.at(-1));
    },
  });
  async function offsetPage(direction, cursor) {
    return call(offsetFixture.viewer, 'data', {
      job: 'line-a', names: ['%MB3', '%MB4'], direction, rowsPerTag: '2', cursor,
    });
  }
  const offsetLatest1 = await offsetPage('latest');
  assert.equal(Object.prototype.hasOwnProperty.call(offsetLatest1.rows[0], '_RID'), false);
  const offsetLatest2 = await offsetPage('latest', offsetLatest1.nextCursor);
  const offsetLatest3 = await offsetPage('latest', offsetLatest2.nextCursor);
  assert.deepEqual(offsetLatest2.rows.map((row) => [row.name, row.value]), [
    ['%MB3', 3], ['%MB3', 2], ['%MB4', 10],
  ]);
  assert.deepEqual(offsetLatest3.rows.map((row) => [row.name, row.value]), [['%MB3', 1]]);
  assert.equal(offsetLatest3.nextCursor, null);
  const offsetLatestBack2 = await offsetPage('latest', offsetLatest3.previousCursor);
  const offsetLatestBack1 = await offsetPage('latest', offsetLatestBack2.previousCursor);
  assert.deepEqual(offsetLatestBack2.rows, offsetLatest2.rows);
  assert.deepEqual(offsetLatestBack1.rows, offsetLatest1.rows);

  const offsetOldest1 = await offsetPage('oldest');
  const offsetOldest2 = await offsetPage('oldest', offsetOldest1.nextCursor);
  const offsetOldest3 = await offsetPage('oldest', offsetOldest2.nextCursor);
  assert.deepEqual(offsetOldest2.rows.map((row) => [row.name, row.value]), [
    ['%MB3', 3], ['%MB4', 30], ['%MB3', 4],
  ]);
  assert.deepEqual(offsetOldest3.rows.map((row) => [row.name, row.value]), [['%MB3', 5]]);
  const offsetOldestBack2 = await offsetPage('oldest', offsetOldest3.previousCursor);
  const offsetOldestBack1 = await offsetPage('oldest', offsetOldestBack2.previousCursor);
  assert.deepEqual(offsetOldestBack2.rows, offsetOldest2.rows);
  assert.deepEqual(offsetOldestBack1.rows, offsetOldest1.rows);

  const chart = fixture();
  const chartQuery = await call(chart.viewer, 'chart', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], primaryColumn: 'NAME', timeColumn: 'TIME',
    valueColumn: 'VALUE', from: '2026-08-01T00:00:00Z', to: '2026-08-04T00:00:00Z',
  });
  assert.equal(chartQuery.job, 'line-a');
  assert.deepEqual(chartQuery.columns, { primary: 'NAME', time: 'TIME', numericValue: 'VALUE' });
  assert.match(chartQuery.query, /SELECT TIME AS TIME, NAME AS NAME, VALUE AS VALUE FROM TAG/);
  assert.match(chartQuery.query, /NAME IN \('%MB3'\)/);
  const specialChart = fixture({
    jobRepository: {
      read(name) {
        return jobDocument(name, {
          methodCalls: [{ tags: specialNames.map((tagName) => ({ name: tagName })) }],
        });
      },
    },
    chartRows: [
      { NAME: '__proto__', TIME: new Date('2026-08-03T00:00:00.000Z'), VALUE: 1 },
      { NAME: 'constructor', TIME: new Date('2026-08-03T00:00:01.000Z'), VALUE: 2 },
    ],
  });
  const specialQuery = await call(specialChart.viewer, 'chart', {
    job: 'line-a', names: specialNames,
  });
  assert.match(specialQuery.query, /NAME IN \('__proto__', 'constructor'\)/);
  await rejectsCode(call(chart.viewer, 'chart', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], valueColumn: 'STR_VALUE',
  }), 'JOB_DATA_SOURCE_MISMATCH');

  await rejectsCode(call(fixture().viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: Array.from({ length: 101 }, (_, index) => `tag-${index}`), valueColumn: 'VALUE',
  }), 'DB_REQUEST_INVALID');
  await rejectsCode(call(fixture().viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], valueColumn: 'VALUE', timezone: '../../etc/passwd',
  }), 'TIMEZONE_UNSUPPORTED');
  await rejectsCode(call(fixture().viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], valueColumn: 'VALUE', timezone: 'Asia/Seoul',
  }), 'TIMEZONE_UNSUPPORTED');
  await rejectsCode(call(fixture().viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], valueColumn: 'VALUE', timezone: '+09:00',
  }), 'TIMEZONE_UNSUPPORTED');
  await rejectsCode(call(fixture().viewer, 'chart', {
    job: 'line-a', names: ['%MB3'], timezone: '',
  }), 'TIMEZONE_UNSUPPORTED');
  await rejectsCode(call(fixture().viewer, 'data', {
    job: 'line-a', server: 'local-db', table: 'TAG', names: ['%MB3'], valueColumn: 'VALUE', from: '2026-08-01',
  }), 'DB_REQUEST_INVALID');
  await rejectsCode(call(fixture().viewer, 'chart', {
    job: 'line-a', names: ['%MB3'], from: '2026-02-30T00:00:00Z',
  }), 'DB_REQUEST_INVALID');
  await rejectsCode(rawCall(fixture().viewer, 'data', {
    server: 'local-db', table: 'TAG', names: ['%MB3'], valueColumn: 'VALUE',
  }), 'DB_REQUEST_INVALID');
}

run().then(() => console.log('DataViewer DB API contract: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
