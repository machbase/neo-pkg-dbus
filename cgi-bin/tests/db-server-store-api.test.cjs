'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic } = require('../src/config/atomic-json.js');
const { createServerStore } = require('../src/db/server-store.js');

function call(target, method, ...args) {
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

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-db-server-'));
  try {
    const store = createServerStore({ cgiRoot: root });

    let concurrentFailure = null;
    const competing = createServerStore({ cgiRoot: root });
    const reserving = createServerStore({
      cgiRoot: root,
      atomicWriter(file, document) {
        competing.create({
          name: 'race-db', host: 'second', port: 5656, user: 'sys', password: 'second-secret',
        }, (failure) => { concurrentFailure = failure; });
        writeJsonAtomic(file, document);
      },
    });
    await call(reserving, 'create', {
      name: 'race-db', host: 'first', port: 5656, user: 'sys', password: 'first-secret',
    });
    assert.equal(concurrentFailure && concurrentFailure.code, 'DB_SERVER_CREATE_LOCKED');
    assert.equal((await call(store, 'get', 'race-db')).host, 'first');
    assert.equal(fs.readdirSync(path.join(root, 'conf.d', 'db-servers')).includes('.race-db.lock'), false);

    fs.writeFileSync(path.join(root, 'conf.d', 'db-servers', '.locked-db.lock'), JSON.stringify({ createdAt: 'old' }));
    const legacyLockCreated = await call(store, 'create', {
      name: 'locked-db', host: 'localhost', port: 5656, user: 'sys', password: 'locked-secret',
    });
    assert.equal(legacyLockCreated.name, 'locked-db', 'obsolete create-only lock files must not block the leased operation lock');
    assert.equal(fs.existsSync(path.join(root, 'conf.d', 'db-servers', '.locked-db.lock')), true);
    const created = await call(store, 'create', {
      name: 'local-db', host: '127.0.0.1', port: 5656, user: 'sys', password: 'secret',
    });
    assert.deepEqual(created, {
      schemaVersion: 1, name: 'local-db', host: '127.0.0.1', port: 5656, user: 'sys', hasPassword: true,
      defaultTable: '', valueColumn: '', stringValueColumn: '',
    });
    assert.equal(JSON.stringify(created).includes('secret'), false);
    assert.equal((await call(store, 'get', 'local-db')).password, 'secret');
    assert.deepEqual(await call(store, 'getPublic', 'local-db'), created);
    const publicServers = await call(store, 'list');
    assert.deepEqual(publicServers.find((server) => server.name === 'local-db'), created);
    assert.deepEqual(publicServers.find((server) => server.name === 'localhost'), {
      schemaVersion: 1, name: 'localhost', host: '127.0.0.1', port: 5656, user: 'sys', hasPassword: true,
      defaultTable: 'DEFAULT_DBUS', valueColumn: 'VALUE', stringValueColumn: '',
    });
    assert.deepEqual(await call(store, 'setDefaultTableColumns', 'localhost', 'default_dbus', 'value', ''), {
      schemaVersion: 1, name: 'localhost', host: '127.0.0.1', port: 5656, user: 'sys', hasPassword: true,
      defaultTable: 'DEFAULT_DBUS', valueColumn: 'VALUE', stringValueColumn: '',
    });
    assert.equal((await call(store, 'get', 'localhost')).password, 'manager');
    assert.deepEqual(await call(store, 'setDefaultTableColumns', 'localhost', 'OTHER_TABLE', 'OTHER_VALUE', ''), {
      schemaVersion: 1, name: 'localhost', host: '127.0.0.1', port: 5656, user: 'sys', hasPassword: true,
      defaultTable: 'DEFAULT_DBUS', valueColumn: 'VALUE', stringValueColumn: '',
    });
    assert.equal(publicServers.some((server) => Object.prototype.hasOwnProperty.call(server, 'password')), false);

    const saved = JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'db-servers', 'local-db.json'), 'utf8'));
    assert.deepEqual(saved, {
      schemaVersion: 1, name: 'local-db', host: '127.0.0.1', port: 5656, user: 'sys', password: 'secret',
      defaultTable: '', valueColumn: '', stringValueColumn: '',
    });

    const tableOnly = await call(store, 'create', {
      name: 'table-only', host: '127.0.0.1', port: 5656, user: 'sys', password: 'secret',
      defaultTable: 'tag_data',
    });
    assert.equal(tableOnly.defaultTable, 'TAG_DATA');
    assert.equal(tableOnly.valueColumn, 'VALUE');

    fs.writeFileSync(path.join(root, 'conf.d', 'db-servers', 'legacy.json'), JSON.stringify({
      schemaVersion: 1, name: 'legacy', host: '127.0.0.1', port: 5656, user: 'sys', password: 'secret',
      defaultTable: 'OLD_TAG', valueColumn: '', stringValueColumn: '',
    }));
    assert.equal((await call(store, 'getPublic', 'legacy')).valueColumn, 'VALUE');
    assert.equal(fs.readdirSync(path.join(root, 'conf.d', 'db-servers')).some((name) => name.includes('.tmp-')), false);

    await rejectsCode(call(store, 'update', 'local-db', {
      host: 'db.internal', port: 5657, user: 'manager', password: '',
    }), 'DB_SERVER_INVALID');
    await rejectsCode(call(store, 'update', 'local-db', {
      host: 'db.internal', port: 5657, user: 'manager',
    }), 'DB_SERVER_INVALID');
    const updated = await call(store, 'update', 'local-db', {
      host: 'db.internal', port: 5657, user: 'manager', password: 'new-secret',
    });
    assert.deepEqual(updated, {
      schemaVersion: 1, name: 'local-db', host: 'db.internal', port: 5657, user: 'manager', hasPassword: true,
      defaultTable: '', valueColumn: '', stringValueColumn: '',
    });
    assert.equal((await call(store, 'get', 'local-db')).password, 'new-secret');

    await rejectsCode(call(store, 'create', {
      name: 'local-db', host: 'x', port: 1, user: 'u', password: 'different-secret',
    }), 'DB_SERVER_ALREADY_EXISTS');
    await rejectsCode(call(store, 'getPublic', '../escape'), 'DB_SERVER_INVALID');

    const jobDir = path.join(root, 'conf.d', 'jobs');
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'production-line.json'), JSON.stringify({
      schemaVersion: 1,
      name: 'production-line',
      database: { server: 'local-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' },
    }));
    await rejectsCode(call(store, 'remove', 'local-db'), 'DB_SERVER_IN_USE');
    fs.unlinkSync(path.join(jobDir, 'production-line.json'));
    assert.deepEqual(await call(store, 'remove', 'local-db'), { name: 'local-db' });
    assert.equal(await call(store, 'get', 'local-db'), null);

    await call(store, 'create', {
      name: 'unrelated-db', host: 'localhost', port: 5656, user: 'sys', password: 'unrelated-secret',
    });
    fs.writeFileSync(path.join(jobDir, 'other-job.json'), JSON.stringify({
      schemaVersion: 1,
      name: 'other-job',
      database: { server: 'remote-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' },
    }));
    assert.deepEqual(await call(store, 'remove', 'unrelated-db'), { name: 'unrelated-db' });

    await call(store, 'create', {
      name: 'guarded-db', host: 'localhost', port: 5656, user: 'sys', password: 'guarded-secret',
    });
    fs.writeFileSync(path.join(jobDir, 'damaged.json'), '{"schemaVersion":');
    await rejectsCode(call(store, 'remove', 'guarded-db'), 'DB_SERVER_REFERENCE_UNKNOWN');
    fs.unlinkSync(path.join(jobDir, 'damaged.json'));

    fs.writeFileSync(path.join(jobDir, 'wrong-name.json'), JSON.stringify({
      schemaVersion: 1,
      name: 'different-name',
      database: { server: 'remote-db' },
    }));
    await rejectsCode(call(store, 'remove', 'guarded-db'), 'DB_SERVER_REFERENCE_UNKNOWN');
    fs.unlinkSync(path.join(jobDir, 'wrong-name.json'));

    fs.writeFileSync(path.join(jobDir, 'wrong-schema.json'), JSON.stringify({
      schemaVersion: 2,
      name: 'wrong-schema',
      database: { server: 'remote-db' },
    }));
    await rejectsCode(call(store, 'remove', 'guarded-db'), 'DB_SERVER_REFERENCE_UNKNOWN');
    fs.unlinkSync(path.join(jobDir, 'wrong-schema.json'));

    fs.mkdirSync(path.join(jobDir, 'unreadable.json'));
    await rejectsCode(call(store, 'remove', 'guarded-db'), 'DB_SERVER_REFERENCE_UNKNOWN');
    fs.rmSync(path.join(jobDir, 'unreadable.json'), { recursive: true, force: true });
    fs.unlinkSync(path.join(jobDir, 'other-job.json'));
    assert.deepEqual(await call(store, 'remove', 'guarded-db'), { name: 'guarded-db' });

    await call(store, 'create', {
      name: 'scan-db', host: 'localhost', port: 5656, user: 'sys', password: 'scan-secret',
    });
    fs.rmSync(jobDir, { recursive: true, force: true });
    fs.writeFileSync(jobDir, 'not-a-directory');
    await rejectsCode(call(store, 'remove', 'scan-db'), 'DB_SERVER_REFERENCE_UNKNOWN');
    fs.unlinkSync(jobDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('DB server store API contract: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
