'use strict';

const assert = require('node:assert/strict');
const { createDatabaseValidationAdapter } = require('../src/db/validation-adapter.js');
const { jobConfig } = require('./job-fixture.cjs');

function call(adapter, database) {
  return new Promise((resolve, reject) => adapter.validate(database, (error, value) => {
    if (error) reject(error);
    else resolve(value);
  }));
}

function ensure(adapter, database, options) {
  return new Promise((resolve, reject) => adapter.ensure(database, options || {}, (error, value) => {
    if (error) reject(error);
    else resolve(value);
  }));
}

function dependencies(columns, options) {
  const settings = options || {};
  return {
    serverStore: {
      get(name, callback) {
        if (settings.serverError) callback(settings.serverError);
        else callback(null, settings.missingServer ? null : { name, host: 'localhost' });
      },
    },
    metadataReader: {
      columns(server, table, callback) {
        if (settings.metadataError) callback(settings.metadataError);
        else if (settings.emptyMetadata) callback(null, null);
        else callback(null, { table, tableType: settings.tableType || 'TAG', columns });
      },
    },
  };
}

const validColumns = [
  { name: 'NAME', type: 'varchar', primaryKey: true, basetime: false },
  { name: 'TIME', type: 'datetime', primaryKey: false, basetime: true },
  { name: 'VALUE', type: 'double', primaryKey: false, basetime: false },
  { name: 'STR_VALUE', type: 'varchar', primaryKey: false, basetime: false },
];

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (failure) => {
    assert.equal(failure.code, code);
    return true;
  });
}

async function run() {
  const database = jobConfig().database;
  const adapter = createDatabaseValidationAdapter(dependencies(validColumns));
  assert.deepEqual(await call(adapter, database), {
    server: 'local-db',
    table: 'TAG',
    tagNameColumn: 'NAME',
    basetimeColumn: 'TIME',
    valueColumn: 'VALUE',
    stringValueColumn: 'STR_VALUE',
  });
  assert.deepEqual(await call(adapter, { ...database, stringValueColumn: '' }), {
    server: 'local-db',
    table: 'TAG',
    tagNameColumn: 'NAME',
    basetimeColumn: 'TIME',
    valueColumn: 'VALUE',
    stringValueColumn: null,
  });

  await rejectsCode(call(createDatabaseValidationAdapter(dependencies(validColumns, {
    missingServer: true,
  })), database), 'JOB_INVALID');
  await rejectsCode(call(createDatabaseValidationAdapter(dependencies(validColumns, {
    metadataError: new Error('connection refused'),
  })), database), 'DB_UNAVAILABLE');
  await rejectsCode(call(createDatabaseValidationAdapter(dependencies(validColumns, {
    tableType: 'LOG',
  })), database), 'JOB_INVALID');
  await rejectsCode(call(createDatabaseValidationAdapter(dependencies(
    validColumns.filter((column) => !column.primaryKey),
  )), database), 'JOB_INVALID');
  await rejectsCode(call(createDatabaseValidationAdapter(dependencies(
    validColumns.map((column) => (column.name === 'VALUE' ? { ...column, type: 'varchar' } : column)),
  )), database), 'JOB_INVALID');
  await rejectsCode(call(createDatabaseValidationAdapter(dependencies(
    validColumns.map((column) => (column.name === 'STR_VALUE' ? { ...column, type: 'json' } : column)),
  )), database), 'JOB_INVALID');

  const unavailable = createDatabaseValidationAdapter({ loadDependencies() { throw new Error('db modules missing'); } });
  await rejectsCode(call(unavailable, database), 'DB_UNAVAILABLE');

  const existingMapping = {
    ...database,
    table: 'external_tag',
    valueColumn: 'external_value',
    stringValueColumn: '',
  };
  const existingAdapter = createDatabaseValidationAdapter(dependencies([], { tableType: 'TAG' }));
  assert.deepEqual(await ensure(existingAdapter, existingMapping, { needsStringValueColumn: false }), {
    server: 'local-db', table: 'EXTERNAL_TAG', valueColumn: 'EXTERNAL_VALUE', stringValueColumn: '',
  }, '기존 Table은 선택된 Column metadata를 다시 검증하지 않습니다.');
  await rejectsCode(ensure(createDatabaseValidationAdapter(dependencies([], {
    emptyMetadata: true,
  })), { ...existingMapping }, { needsStringValueColumn: false }), 'DB_UNAVAILABLE');

  let tableExists = false;
  const created = [];
  const assignedDefaultColumns = [];
  const provisioning = createDatabaseValidationAdapter({
    serverStore: {
      get(name, callback) { callback(null, { name, host: 'localhost', defaultTable: 'NUMERIC_TAG' }); },
      setDefaultTableColumns(name, table, valueColumn, stringValueColumn, callback) {
        assignedDefaultColumns.push({ name, table, valueColumn, stringValueColumn });
        callback(null, { name, defaultTable: table, valueColumn, stringValueColumn });
      },
    },
    metadataReader: {
      columns(_server, table, callback) {
        callback(null, tableExists
          ? { table, tableType: 'TAG', columns: validColumns }
          : { table, tableType: 'NOT_FOUND', columns: [] });
      },
    },
    tableCreator: {
      createTable(request, callback) {
        created.push(request);
        tableExists = true;
        callback(null, { ...request, table: request.table.toUpperCase() });
      },
    },
  });
  const numericDatabase = { ...database, table: 'numeric_tag', valueColumn: 'CUSTOM_VALUE', stringValueColumn: 'CUSTOM_STR' };
  assert.deepEqual(await ensure(provisioning, numericDatabase, { needsStringValueColumn: false }), {
    server: 'local-db', table: 'NUMERIC_TAG', valueColumn: 'VALUE', stringValueColumn: '',
  });
  assert.deepEqual(created, [{ server: 'local-db', table: 'NUMERIC_TAG', valueColumn: 'VALUE', stringValueColumn: null }]);
  assert.deepEqual(assignedDefaultColumns, [{
    name: 'local-db', table: 'NUMERIC_TAG', valueColumn: 'VALUE', stringValueColumn: '',
  }]);
  assert.equal(numericDatabase.stringValueColumn, '');

  let stringTableExists = false;
  const stringCreated = [];
  const stringProvisioning = createDatabaseValidationAdapter({
    serverStore: { get(name, callback) { callback(null, { name, host: 'localhost' }); } },
    metadataReader: {
      columns(_server, table, callback) {
        callback(null, stringTableExists
          ? { table, tableType: 'TAG', columns: validColumns }
          : { table, tableType: 'NOT_FOUND', columns: [] });
      },
    },
    tableCreator: {
      createTable(request, callback) {
        stringCreated.push(request);
        stringTableExists = true;
        callback(null, request);
      },
    },
  });
  assert.deepEqual(await ensure(stringProvisioning, {
    ...database,
    table: 'string_tag',
    valueColumn: 'CUSTOM_VALUE',
    stringValueColumn: 'CUSTOM_STR',
  }, { needsStringValueColumn: true }), {
    server: 'local-db', table: 'STRING_TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE',
  });
  assert.deepEqual(stringCreated, [{ server: 'local-db', table: 'STRING_TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' }]);

  let createCalls = 0;
  const racingProvisioning = createDatabaseValidationAdapter({
    serverStore: { get(name, callback) { callback(null, { name, host: 'localhost' }); } },
    metadataReader: {
      columns(_server, table, callback) {
        callback(null, { table, tableType: 'NOT_FOUND', columns: [] });
      },
    },
    tableCreator: {
      createTable(request, callback) {
        createCalls += 1;
        callback(Object.assign(new Error('race'), { code: 'TABLE_ALREADY_EXISTS' }));
      },
    },
  });
  assert.deepEqual(await ensure(racingProvisioning, {
    ...database, table: 'race_tag', valueColumn: 'VALUE', stringValueColumn: '',
  }, { needsStringValueColumn: false }), {
    server: 'local-db', table: 'RACE_TAG', valueColumn: 'VALUE', stringValueColumn: '',
  });
  assert.equal(createCalls, 1, '경쟁으로 먼저 생긴 Table은 다시 만들거나 변경하지 않습니다.');
}

run().then(() => console.log('Database validation adapter: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
