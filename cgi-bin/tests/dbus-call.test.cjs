'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = require('../profiles.d/ls-electric-plc.json');
const { TestCallManager } = require('../src/dbus/test-call.js');

function call(manager, payload) {
  return new Promise((resolve, reject) => manager.call(payload, (error, value) => {
    if (error) reject(error); else resolve(value);
  }));
}

async function testDraftCallIsEphemeral() {
  const dbusCalls = [];
  let closes = 0;
  const instants = [new Date('2026-08-03T00:00:00.000Z'), new Date('2026-08-03T00:00:00.025Z')];
  const manager = new TestCallManager({
    settings: { limits: { maxGeneratedTagsPerCall: 1000 } },
    now() { return instants.shift(); },
    dbusFactory() {
      return {
        connect(type) { assert.equal(type, 'system'); },
        call(config, method, args) {
          dbusCalls.push({ config, method, args });
          return { body: ['{"rtn":1,"data-count":2,"time-stamp-us":99,"data":[1,"READY"]}'] };
        },
        close() { closes += 1; },
      };
    },
    details: { setLastRun() { throw new Error('Test Call은 details를 저장하면 안 됩니다.'); } },
    database: { append() { throw new Error('Test Call은 DB에 저장하면 안 됩니다.'); } },
  });
  const methodDraft = { ...profile.methods[0], displayName: 'Unsaved Draft Method' };
  const result = await call(manager, {
    profile: { ...profile, profileVersion: 99, methods: [methodDraft] },
    method: methodDraft,
    dbus: { busType: 'system', destination: 'draft.plc' },
    inputs: { dataCount: 2, memoryAddress: '%MB8' },
  });
  assert.deepEqual(result, {
    requestedAt: '2026-08-03T00:00:00.000Z',
    durationMs: 25,
    success: true,
    valueCount: 2,
    returnedCount: 2,
    values: [1, 'READY'],
    suggestedTags: [
      { outputIndex: 0, sourceAddress: '%MB8', name: '%MB8', bias: 0, multiplier: 1, calcOrder: 'bm' },
      { outputIndex: 1, sourceAddress: '%MB9', name: '%MB9', bias: 0, multiplier: 1, calcOrder: 'bm' },
    ],
    body: { rtn: 1, 'data-count': 2, 'time-stamp-us': 99, data: [1, 'READY'] },
  });
  assert.equal(dbusCalls[0].config.destination, 'draft.plc');
  assert.equal(dbusCalls[0].method.displayName, 'Unsaved Draft Method');
  assert.deepEqual(dbusCalls[0].args, ['uint16:2', 'string:%MB8']);
  assert.equal(closes, 1);
}

async function testCallFailureDoesNotLeakBody() {
  const manager = new TestCallManager({
    settings: { limits: { maxGeneratedTagsPerCall: 1000 } },
    dbusFactory() {
      return {
        connect() {},
        call() { throw new Error('raw body: {password:secret}'); },
        close() {},
      };
    },
  });
  await assert.rejects(call(manager, {
    profile,
    method: profile.methods[0],
    dbus: { busType: 'system', destination: 'ls.plc' },
    inputs: { dataCount: 1, memoryAddress: '%MB3' },
  }), (failure) => {
    assert.equal(failure.code, 'DBUS_CALL_FAILED');
    assert.equal(JSON.stringify(failure.details).includes('secret'), false);
    assert.equal(failure.message.includes('secret'), false);
    return true;
  });
}

async function testCustomOutputsWithoutExpectedCount() {
  const scalar = {
    id: 'read-scalar', displayName: 'Read Scalar', objectPath: '/custom',
    interface: 'custom.device', methodName: 'ReadScalar', inputs: [],
    output: { decoder: 'raw', shape: 'scalar' },
  };
  const array = { ...scalar, id: 'read-array', displayName: 'Read Array', methodName: 'ReadArray',
    output: { decoder: 'raw', shape: 'array' } };
  const customProfile = {
    schemaVersion: 1, id: 'custom-profile', profileVersion: 1, displayName: 'Custom', vendor: 'Custom',
    builtIn: false, compatibility: { minNeoVersion: '8.5.6' },
    defaults: { busType: 'system', destination: 'custom.device' }, methods: [scalar, array],
  };
  const replies = [{ body: [7] }, { body: [[1, 2]] }];
  const manager = new TestCallManager({
    settings: { limits: { maxGeneratedTagsPerCall: 1000 } },
    dbusFactory() { return { connect() {}, call() { return replies.shift(); }, close() {} }; },
  });
  const scalarResult = await call(manager, {
    profile: customProfile, method: scalar, dbus: { busType: 'system', destination: 'custom.device' }, inputs: {},
  });
  assert.deepEqual({ values: scalarResult.values, tags: scalarResult.suggestedTags }, { values: [7], tags: [] });
  const arrayResult = await call(manager, {
    profile: customProfile, method: array, dbus: { busType: 'system', destination: 'custom.device' }, inputs: {},
  });
  assert.deepEqual({ values: arrayResult.values, tags: arrayResult.suggestedTags }, { values: [1, 2], tags: [] });
}

function runCgi(script, moduleRoot, stateFile, payload) {
  const program = `
    const environment = process.env;
    process.env = { ...environment, get: (name) => environment[name] };
    process.stdin.read = () => process.argv[2] || '';
    require(process.argv[1]);
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', program, script, JSON.stringify(payload)], {
    encoding: 'utf8', env: { ...process.env, NODE_PATH: moduleRoot, REQUEST_METHOD: 'POST', DBUS_STATE: stateFile },
  });
  assert.equal(result.status, 0, result.stderr);
  const split = result.stdout.indexOf('\r\n\r\n');
  assert.notEqual(split, -1, result.stdout);
  return {
    status: Number(/Status: (\d+)/.exec(result.stdout.slice(0, split))[1]),
    payload: JSON.parse(result.stdout.slice(split + 4)),
  };
}

function testCgiEnvelopeAndNoTimeout() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-call-api-'));
  try {
    const moduleRoot = path.join(temporary, 'node_modules');
    const dbusDir = path.join(moduleRoot, 'dbus');
    const stateFile = path.join(temporary, 'state.json');
    fs.mkdirSync(dbusDir, { recursive: true });
    fs.writeFileSync(path.join(dbusDir, 'index.js'), `
      'use strict';
      const fs = require('fs');
      class Connection {
        constructor(options) { this.options = options; }
        call(request) { fs.writeFileSync(process.env.DBUS_STATE, JSON.stringify({ request, closed: false })); return { body: ['{"rtn":1,"data-count":1,"data":[7]}'] }; }
        close() { const value = JSON.parse(fs.readFileSync(process.env.DBUS_STATE, 'utf8')); value.closed = true; fs.writeFileSync(process.env.DBUS_STATE, JSON.stringify(value)); }
      }
      module.exports = { Connection };
    `);
    const draft = profile.methods[0];
    const response = runCgi(path.resolve(__dirname, '..', 'api', 'dbus', 'call.js'), moduleRoot, stateFile, {
      profile,
      method: draft,
      dbus: { busType: 'system', destination: 'ls.plc' },
      inputs: { dataCount: 1, memoryAddress: '%MB3' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.data.body.data[0], 7);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.closed, true);
    assert.equal(Object.prototype.hasOwnProperty.call(state.request, 'timeout'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.request, 'signal'), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

testDraftCallIsEphemeral().then(testCallFailureDoesNotLeakBody).then(testCustomOutputsWithoutExpectedCount).then(() => {
  testCgiEnvelopeAndNoTimeout();
  console.log('DBus Test Call: ok');
}).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
