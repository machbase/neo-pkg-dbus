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

  const unavailable = createDatabaseValidationAdapter({ loadDependencies() { throw new Error('db modules missing'); } });
  await rejectsCode(call(unavailable, database), 'DB_UNAVAILABLE');
}

run().then(() => console.log('Database validation adapter: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
