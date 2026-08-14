'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    env: {
      ...process.env,
      REQUEST_METHOD: settings.method || 'GET',
      QUERY_STRING: settings.query || '',
      ...(settings.environment || {}),
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

function customProfile() {
  return {
    schemaVersion: 1,
    id: 'custom-cgi',
    profileVersion: 99,
    displayName: 'Custom CGI',
    vendor: 'Example',
    builtIn: true,
    compatibility: { minNeoVersion: '8.5.6' },
    defaults: { busType: 'system', destination: 'example.device' },
    methods: [],
  };
}

function customMethod() {
  return {
    id: 'read-cgi',
    displayName: 'Read CGI',
    objectPath: '/example/device',
    interface: 'example.device',
    methodName: 'ReadValue',
    inputs: [{ id: 'address', type: 'string', required: true }],
    output: { decoder: 'raw', shape: 'scalar' },
  };
}

function run() {
  const source = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-profile-cgi-'));
  const root = path.join(temporary, 'cgi-bin');
  try {
    fs.cpSync(source, root, { recursive: true });
    fs.rmSync(path.join(root, 'provider.json'), { force: true });
    fs.rmSync(path.join(root, 'interfaces.d'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'conf.d'), { recursive: true });
    fs.writeFileSync(path.join(root, 'conf.d', 'settings.json'), JSON.stringify({
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
    }), 'utf8');
    const legacyExample = path.join(root, 'conf.d', 'jobs', 'example.json');
    if (fs.existsSync(legacyExample)) fs.unlinkSync(legacyExample);

    let versionResponse = runCgi(path.join(root, 'api', 'profile', 'list.js'), {
      environment: { MACHBASE_NEO_VERSION: 'v8.5.6' },
    });
    assert.equal(versionResponse.status, 200);
    assert.equal(versionResponse.payload.data[0].compatible, true);

    versionResponse = runCgi(path.join(root, 'api', 'profile', 'list.js'), {
      environment: { MACHBASE_NEO_VERSION: 'not-a-version' },
    });
    assert.equal(versionResponse.status, 503);
    assert.deepEqual(Object.keys(versionResponse.payload).sort(), ['code', 'details', 'ok', 'reason']);
    assert.equal(versionResponse.payload.code, 'RUNTIME_VERSION_INVALID');

    let response = runCgi(path.join(root, 'api', 'settings.js'));
    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.deepEqual(response.payload.data, {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
      defaults: { database: { server: 'localhost' } },
      provider: null,
    });

    response = runCgi(path.join(root, 'api', 'settings.js'), {
      method: 'PUT',
      body: JSON.stringify({
        limits: { maxGeneratedTagsPerCall: 250, maxBufferedRowsPerCycle: 2000 },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload.data, {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 250, maxBufferedRowsPerCycle: 2000 },
      defaults: { database: { server: 'localhost' } },
    });

    for (const malformedBody of ['null', '[]', '"text"']) {
      response = runCgi(path.join(root, 'api', 'settings.js'), {
        method: 'PUT', body: malformedBody,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(Object.keys(response.payload).sort(), ['code', 'details', 'ok', 'reason']);
      assert.equal(response.payload.code, 'REQUEST_INVALID');
    }

    response = runCgi(path.join(root, 'api', 'profile', 'list.js'));
    assert.equal(response.status, 200);
    assert.equal(response.payload.data[0].id, 'ls-electric-plc');
    assert.equal(response.payload.data[0].default, false);

    response = runCgi(path.join(root, 'api', 'profile.js'));
    assert.equal(response.status, 400);
    assert.equal(response.payload.code, 'REQUEST_INVALID');

    response = runCgi(path.join(root, 'api', 'profile.js'), {
      method: 'POST', body: JSON.stringify(customProfile()),
    });
    assert.equal(response.status, 201);
    assert.deepEqual({ builtIn: response.payload.data.builtIn, version: response.payload.data.profileVersion }, {
      builtIn: false, version: 1,
    });

    response = runCgi(path.join(root, 'api', 'method.js'), {
      method: 'POST', body: JSON.stringify({ profileId: 'custom-cgi', method: customMethod() }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.payload.data.id, 'read-cgi');

    response = runCgi(path.join(root, 'api', 'method', 'list.js'), {
      query: 'profileId=custom-cgi',
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.data.length, 1);

    response = runCgi(path.join(root, 'api', 'method', 'list.js'));
    assert.equal(response.status, 400);
    assert.equal(response.payload.code, 'REQUEST_INVALID');

    response = runCgi(path.join(root, 'api', 'method.js'), {
      method: 'POST', body: 'null',
    });
    assert.equal(response.status, 400);
    assert.equal(response.payload.code, 'REQUEST_INVALID');

    response = runCgi(path.join(root, 'api', 'method.js'));
    assert.equal(response.status, 400);
    assert.equal(response.payload.code, 'REQUEST_INVALID');

    response = runCgi(path.join(root, 'api', 'profile.js'), {
      method: 'DELETE', query: 'id=ls-electric-plc',
    });
    assert.equal(response.status, 409);
    assert.deepEqual(Object.keys(response.payload).sort(), ['code', 'details', 'ok', 'reason']);
    assert.equal(response.payload.code, 'PROFILE_READ_ONLY');

    response = runCgi(path.join(root, 'api', 'method.js'), {
      method: 'DELETE', query: 'profileId=custom-cgi&id=read-cgi',
    });
    assert.equal(response.status, 200);
    response = runCgi(path.join(root, 'api', 'profile.js'), {
      method: 'DELETE', query: 'id=custom-cgi',
    });
    assert.equal(response.status, 200);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run();
console.log('Settings/Profile/Method CGI: ok');
