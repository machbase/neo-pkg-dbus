'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { SettingsManager } = require('../src/config/settings-manager.js');
const { validateSettings } = require('../src/config/settings-validator.js');

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (failure, value) => (failure ? reject(failure) : resolve(value)));
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runCgi(script, options) {
  const settings = options || {};
  const program = `
    const environment = process.env;
    process.env = { ...environment, get: (name) => environment[name] };
    process.stdin.read = () => process.argv[2] || '';
    require(process.argv[1]);
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', program, script, settings.body || ''], {
    encoding: 'utf8',
    env: { ...process.env, REQUEST_METHOD: settings.method || 'GET' },
  });
  assert.equal(result.status, 0, result.stderr);
  const splitAt = result.stdout.indexOf('\r\n\r\n');
  assert.notEqual(splitAt, -1, result.stdout);
  return {
    status: Number(/Status: (\d+)/.exec(result.stdout.slice(0, splitAt))[1]),
    payload: JSON.parse(result.stdout.slice(splitAt + 4)),
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-settings-contract-'));
  try {
    const original = {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
      defaults: { database: { server: 'localhost' } },
    };
    writeJson(path.join(root, 'conf.d', 'settings.json'), original);

    assert.deepEqual(validateSettings(original), original);
    const manager = new SettingsManager({ cgiRoot: root });
    assert.deepEqual(await call(manager, 'get'), { ...original, provider: null });

    const updated = await call(manager, 'update', {
      limits: { maxGeneratedTagsPerCall: 250, maxBufferedRowsPerCycle: 2000 },
    });
    assert.deepEqual(updated, {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 250, maxBufferedRowsPerCycle: 2000 },
      defaults: { database: { server: 'localhost' } },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'settings.json'), 'utf8')), updated);

    writeJson(path.join(root, 'conf.d', 'settings.json'), {
      ...original,
      defaultProfileId: 'legacy-profile',
    });
    assert.deepEqual(await call(manager, 'get'), { ...original, provider: null });
    assert.deepEqual(await call(manager, 'update', { limits: original.limits }), original);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'settings.json'), 'utf8')), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }


  const source = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-settings-http-contract-'));
  const cgiRoot = path.join(temporary, 'cgi-bin');
  try {
    fs.cpSync(source, cgiRoot, { recursive: true });
    const settingsScript = path.join(cgiRoot, 'api', 'settings.js');
    const settingsFile = path.join(cgiRoot, 'conf.d', 'settings.json');
    const providerFile = path.join(cgiRoot, 'provider.json');
    writeJson(settingsFile, {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
      defaults: { database: { server: 'localhost' } },
    });
    if (fs.existsSync(providerFile)) fs.unlinkSync(providerFile);

    let response = runCgi(settingsScript);
    assert.equal(response.status, 200);
    assert.equal(response.payload.data.provider, null);

    const provider = {
      schemaVersion: 1,
      id: 'ls',
      jobMode: 'fixed',
      interfaceId: 'ls-plc-device',
      methodId: 'get-device-data',
      outputSelections: [{
        id: 'return-data', sourceIndex: 0, interpretation: 'json', selector: '/data',
        valueType: 'array', elementType: 'numeric', tags: [],
      }],
      tagGenerator: { kind: 'ls-memory-address-v1' },
    };
    writeJson(providerFile, provider);
    response = runCgi(settingsScript);
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload.data.provider, provider);

    response = runCgi(settingsScript, {
      method: 'PUT',
      body: JSON.stringify({ provider: null }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.payload.code, 'SETTINGS_INVALID');
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), 'provider'), false);

    fs.writeFileSync(providerFile, '{invalid json', 'utf8');
    response = runCgi(settingsScript);
    assert.equal(response.status, 400);
    assert.equal(response.payload.code, 'PROVIDER_PROFILE_INVALID');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run().then(() => console.log('Settings contract: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
