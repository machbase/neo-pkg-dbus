'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServerStore } = require('../src/db/server-store.js');
const { createMetadataReader } = require('../src/db/metadata-reader.js');

function call(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (error, value) => {
    if (error) reject(error);
    else resolve(value);
  }));
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-default-db-adapter-'));
  try {
    const directory = path.join(root, 'conf.d', 'db-servers');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'local-db.json'), JSON.stringify({
      schemaVersion: 1,
      name: 'local-db',
      host: '127.0.0.1',
      port: 5656,
      user: 'sys',
      password: 'secret',
    }), 'utf8');
    const store = createServerStore({ cgiRoot: root });
    assert.deepEqual(await call(store, 'get', 'local-db'), {
      schemaVersion: 1,
      name: 'local-db',
      host: '127.0.0.1',
      port: 5656,
      user: 'sys',
      password: 'secret',
    });
    assert.equal(await call(store, 'get', 'missing'), null);
    await assert.rejects(call(store, 'get', '../escape'), /server name/i);

    const events = [];
    const reader = createMetadataReader({
      clientFactory(config) {
        events.push(['client', config]);
        return {
          connect() {
            events.push(['connect']);
            return {
              query(sql, ...values) {
                events.push(['query', sql, values]);
                if (sql.includes('M$SYS_COLUMNS')) return [
                  { NAME: 'NAME', TYPE: 5, ID: 0, LENGTH: 80, FLAG: 134217728 },
                  { NAME: 'TIME', TYPE: 6, ID: 1, LENGTH: 0, FLAG: 16777216 },
                  { NAME: 'VALUE', TYPE: 20, ID: 2, LENGTH: 0, FLAG: 0 },
                  { NAME: 'STR_VALUE', TYPE: 5, ID: 3, LENGTH: 256, FLAG: 0 },
                ];
                if (sql.includes('M$SYS_TABLES')) return [{ ID: 7, TYPE: 6, NAME: 'TAG' }];
                throw new Error('unexpected query');
              },
              close() { events.push(['connection.close']); },
            };
          },
          close() { events.push(['client.close']); },
        };
      },
    });
    assert.deepEqual(await call(reader, 'columns', await call(store, 'get', 'local-db'), 'TAG'), {
      table: 'TAG',
      tableType: 'TAG',
      columns: [
        { name: 'NAME', type: 'varchar(80)', primaryKey: true, basetime: false },
        { name: 'TIME', type: 'datetime', primaryKey: false, basetime: true },
        { name: 'VALUE', type: 'double', primaryKey: false, basetime: false },
        { name: 'STR_VALUE', type: 'varchar(256)', primaryKey: false, basetime: false },
      ],
    });
    assert.deepEqual(events[0], ['client', {
      host: '127.0.0.1', port: 5656, user: 'sys', password: 'secret',
    }]);
    assert.equal(events.some(([event]) => event === 'connection.close'), true);
    assert.equal(events.some(([event]) => event === 'client.close'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('Default database adapters: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
