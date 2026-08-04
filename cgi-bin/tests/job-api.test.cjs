'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jobConfig } = require('./job-fixture.cjs');

function runCgi(script, moduleRoot, stateFile, options) {
  const settings = options || {};
  const program = `
    const environment = process.env;
    process.env = { ...environment, get: (name) => environment[name] };
    process.stdin.read = () => process.argv[2] || '';
    require(process.argv[1]);
  `;
  const result = childProcess.spawnSync(process.execPath, [
    '-e', program, script, settings.body || '',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: moduleRoot,
      REQUEST_METHOD: settings.method || 'GET',
      QUERY_STRING: settings.query || '',
      JOB_API_STATE_FILE: stateFile,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const splitAt = result.stdout.indexOf('\r\n\r\n');
  assert.notEqual(splitAt, -1, result.stdout);
  return {
    status: Number(/Status: (\d+)/.exec(result.stdout.slice(0, splitAt))[1]),
    payload: JSON.parse(result.stdout.slice(splitAt + 4)),
  };
}

function assertEnvelope(response, status, ok) {
  assert.equal(response.status, status);
  assert.equal(response.payload.ok, ok);
  if (ok) assert.deepEqual(Object.keys(response.payload).sort(), ['data', 'ok']);
  else assert.deepEqual(Object.keys(response.payload).sort(), ['code', 'details', 'ok', 'reason']);
}

function run() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-api-'));
  const cgiRoot = path.join(temporary, 'cgi-bin');
  const moduleRoot = path.join(temporary, 'node_modules');
  const stateFile = path.join(temporary, 'controller-state.json');
  try {
    fs.cpSync(path.resolve(__dirname, '..'), cgiRoot, { recursive: true });
    fs.rmSync(path.join(cgiRoot, 'conf.d', 'jobs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(cgiRoot, 'conf.d', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(moduleRoot, 'service'), { recursive: true });
    fs.writeFileSync(path.join(moduleRoot, 'service', 'index.js'), `
      'use strict';
      const fs = require('fs');
      const file = process.env.JOB_API_STATE_FILE;
      function read() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; } }
      function write(value) { fs.writeFileSync(file, JSON.stringify(value)); }
      function missing(callback) { const error = new Error('service not found'); error.rpcCode = -32004; callback(error); }
      class Client {
        constructor() {
          this.details = { get(name, key, callback) {
            const all = read();
            const details = (all[name] && all[name].details) || {};
            callback(null, { details: { [key]: details[key] === undefined ? null : details[key] } });
          } };
        }
        status(name, callback) { const all = read(); if (!all[name]) return missing(callback); callback(null, { status: all[name].status }); }
        install(descriptor, callback) { const all = read(); all[descriptor.name] = { status: 'STOPPED', descriptor, details: {} }; write(all); callback(null, { status: 'STOPPED' }); }
        start(name, callback) { const all = read(); all[name].status = 'RUNNING'; write(all); callback(null, { status: 'RUNNING' }); }
        stop(name, callback) { const all = read(); all[name].status = 'STOPPED'; write(all); callback(null, { status: 'STOPPED' }); }
        uninstall(name, callback) { const all = read(); delete all[name]; write(all); callback(null); }
      }
      module.exports = { Client };
    `, 'utf8');
    fs.mkdirSync(path.join(cgiRoot, 'conf.d', 'db-servers'), { recursive: true });
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'db-servers', 'local-db.json'), JSON.stringify({
      schemaVersion: 1,
      name: 'local-db',
      host: 'localhost',
      port: 5656,
      user: 'sys',
      password: 'manager',
    }), 'utf8');
    fs.mkdirSync(path.join(moduleRoot, 'machcli'), { recursive: true });
    fs.writeFileSync(path.join(moduleRoot, 'machcli', 'index.js'), `
      'use strict';
      class Client {
        connect() {
          return {
            query(sql) {
              if (sql.includes('M$SYS_COLUMNS')) return [
                { NAME: 'NAME', TYPE: 5, ID: 0, LENGTH: 80, FLAG: 134217728 },
                { NAME: 'TIME', TYPE: 6, ID: 1, LENGTH: 0, FLAG: 16777216 },
                { NAME: 'VALUE', TYPE: 20, ID: 2, LENGTH: 0, FLAG: 0 },
                { NAME: 'STR_VALUE', TYPE: 5, ID: 3, LENGTH: 256, FLAG: 0 },
              ];
              if (sql.includes('M$SYS_TABLES')) return [{ ID: 1, TYPE: 6, NAME: 'TAG' }];
              throw new Error('unexpected metadata query');
            },
            close() {},
          };
        }
        close() {}
      }
      module.exports = { Client };
    `, 'utf8');

    const jobScript = path.join(cgiRoot, 'api', 'job.js');
    let response = runCgi(jobScript, moduleRoot, stateFile, { method: 'POST', body: '{bad json' });
    assertEnvelope(response, 400, false);
    assert.equal(response.payload.code, 'REQUEST_INVALID');

    response = runCgi(jobScript, moduleRoot, stateFile, {
      method: 'POST', body: JSON.stringify({ name: 'alpha', config: { ...jobConfig(), name: 'hidden' } }),
    });
    assertEnvelope(response, 400, false);
    assert.equal(response.payload.code, 'JOB_INVALID');

    response = runCgi(jobScript, moduleRoot, stateFile, {
      method: 'POST', body: JSON.stringify({ name: 'alpha', config: jobConfig() }),
    });
    assertEnvelope(response, 201, true);
    assert.equal(response.payload.data.configState, 'config-only');

    response = runCgi(path.join(cgiRoot, 'api', 'job', 'list.js'), moduleRoot, stateFile);
    assertEnvelope(response, 200, true);
    assert.equal(response.payload.data[0].name, 'alpha');

    response = runCgi(jobScript, moduleRoot, stateFile, { method: 'GET', query: 'name=alpha' });
    assertEnvelope(response, 200, true);
    assert.equal(response.payload.data.controllerState, 'NOT_INSTALLED');
    assert.equal(response.payload.data.revision, 1);

    response = runCgi(jobScript, moduleRoot, stateFile, {
      method: 'PUT', query: 'name=alpha', body: JSON.stringify({ schedule: { intervalMs: 2000 } }),
    });
    assertEnvelope(response, 400, false);
    assert.equal(response.payload.code, 'JOB_REVISION_REQUIRED');

    response = runCgi(jobScript, moduleRoot, stateFile, {
      method: 'PUT', query: 'name=alpha', body: JSON.stringify({ revision: 1, schedule: { intervalMs: 2000 } }),
    });
    assertEnvelope(response, 200, true);
    assert.equal(response.payload.data.revision, 2);
    assert.equal(response.payload.data.config.schedule.intervalMs, 2000);

    response = runCgi(jobScript, moduleRoot, stateFile, {
      method: 'PUT', query: 'name=alpha', body: JSON.stringify({ revision: 1, schedule: { intervalMs: 3000 } }),
    });
    assertEnvelope(response, 409, false);
    assert.equal(response.payload.code, 'JOB_CONFLICT');
    assert.deepEqual(response.payload.details, {
      name: 'alpha', expectedRevision: 1, currentRevision: 2,
    });

    response = runCgi(jobScript, moduleRoot, stateFile, {
      method: 'PUT', query: 'name=alpha', body: JSON.stringify({ name: 'renamed' }),
    });
    assertEnvelope(response, 409, false);
    assert.equal(response.payload.code, 'JOB_NAME_IMMUTABLE');

    response = runCgi(path.join(cgiRoot, 'api', 'job', 'validate.js'), moduleRoot, stateFile, {
      method: 'POST', body: JSON.stringify({ name: 'draft', config: jobConfig() }),
    });
    assertEnvelope(response, 200, true);
    assert.equal(response.payload.data.valid, true);

    response = runCgi(path.join(cgiRoot, 'api', 'job', 'install.js'), moduleRoot, stateFile, {
      method: 'POST', query: 'name=alpha',
    });
    assertEnvelope(response, 200, true);
    assert.equal(response.payload.data.controllerState, 'STOPPED');
    const descriptor = JSON.parse(fs.readFileSync(stateFile, 'utf8'))._dbu_alpha.descriptor;
    assert.equal(descriptor.enable, true);
    assert.equal(descriptor.args[0], 'alpha.json');

    response = runCgi(path.join(cgiRoot, 'api', 'job', 'start.js'), moduleRoot, stateFile, {
      method: 'POST', query: 'name=alpha',
    });
    assertEnvelope(response, 200, true);
    assert.equal(response.payload.data.executionState, 'running');

    response = runCgi(jobScript, moduleRoot, stateFile, {
      method: 'PUT', query: 'name=alpha', body: JSON.stringify({ schedule: { intervalMs: 2000 } }),
    });
    assertEnvelope(response, 409, false);
    assert.equal(response.payload.code, 'JOB_RUNNING');

    response = runCgi(path.join(cgiRoot, 'api', 'job', 'stop.js'), moduleRoot, stateFile, {
      method: 'POST', query: 'name=alpha',
    });
    assertEnvelope(response, 200, true);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state._dbu_alpha.details = { lastRun: { status: 'success', body: 'raw must not leak' } };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    response = runCgi(path.join(cgiRoot, 'api', 'job', 'last-run.js'), moduleRoot, stateFile, {
      method: 'GET', query: 'name=alpha',
    });
    assertEnvelope(response, 200, true);
    assert.deepEqual(response.payload.data, { lastRun: { status: 'success' } });

    response = runCgi(jobScript, moduleRoot, stateFile, { method: 'DELETE', query: 'name=alpha' });
    assertEnvelope(response, 200, true);
    assert.deepEqual(response.payload.data, { name: 'alpha' });

    response = runCgi(jobScript, moduleRoot, stateFile, { method: 'GET', query: '%E0%A4%A' });
    assertEnvelope(response, 400, false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run();
console.log('Job CGI API: ok');
