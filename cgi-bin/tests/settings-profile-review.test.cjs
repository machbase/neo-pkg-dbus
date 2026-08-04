'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic } = require('../src/config/atomic-json.js');
const { ProfileManager } = require('../src/profiles/manager.js');
const { ProfileStore } = require('../src/profiles/store.js');
const {
  MAX_INPUTS_PER_METHOD,
  MAX_METHODS_PER_PROFILE,
  MAX_PROFILE_JSON_BYTES,
  validateMethod,
  validateProfile,
} = require('../src/profiles/validator.js');

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error && error.code === code);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function method(id) {
  return {
    id,
    displayName: id,
    objectPath: '/example/device',
    interface: 'example.device',
    methodName: 'ReadValue',
    inputs: [{
      id: 'count',
      type: 'uint16',
      required: true,
      validation: { minimum: 1, maximum: 100, pattern: '^[0-9]+$' },
    }],
    output: {
      decoder: 'json',
      shape: 'array',
      path: 'payload.values',
      success: { path: 'result.code', operator: 'equals', value: 1 },
      returnedCountPath: 'result.count',
      expectedCount: { source: 'input', inputId: 'count' },
    },
  };
}

function profile(id) {
  return {
    schemaVersion: 1,
    id,
    profileVersion: 1,
    displayName: id,
    vendor: 'Example',
    builtIn: false,
    compatibility: { minNeoVersion: '8.5.6' },
    defaults: { busType: 'system', destination: 'example.device' },
    methods: [method('read-value')],
  };
}

function setupRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeJson(path.join(root, 'conf.d', 'settings.json'), {
    schemaVersion: 1,
    defaultProfileId: 'custom-plc',
    limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
  });
  writeJson(path.join(root, 'conf.d', 'profiles', 'custom-plc.json'), profile('custom-plc'));
  return root;
}

async function testInvalidJobIdentity() {
  const root = setupRoot('neo-profile-invalid-job-');
  try {
    const custom = profile('custom-plc');
    custom.methods.push(method('spare-method'));
    writeJson(path.join(root, 'conf.d', 'profiles', 'custom-plc.json'), custom);
    writeJson(path.join(root, 'conf.d', 'jobs', 'safe-stem.json'), {
      schemaVersion: 1,
      name: '../unsafe-name',
      profileId: 'custom-plc',
      methodCalls: [{ id: 'call-1', methodId: 'read-value' }],
    });
    const queried = [];
    const manager = new ProfileManager({
      cgiRoot: root,
      runtimeNeoVersion: '8.5.6',
      controller: { status(name, callback) { queried.push(name); callback(null, { status: 'STOPPED' }); } },
    });
    const current = (await call(manager, 'getProfile', 'custom-plc')).profile;
    await rejectsCode(
      call(manager, 'updateProfile', { ...current, displayName: 'must block' }),
      'JOB_INVALID_CONFIG',
    );
    await rejectsCode(
      call(manager, 'updateMethod', 'custom-plc', { ...method('spare-method'), displayName: 'must block' }),
      'JOB_INVALID_CONFIG',
    );
    assert.deepEqual(queried, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testMutationGuards() {
  for (const state of ['RUNNING', 'STARTING', 'STOPPING', 'PAUSED']) {
    const root = setupRoot(`neo-profile-create-guard-${state}-`);
    try {
      writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
        schemaVersion: 1,
        name: 'alpha',
        profileId: 'custom-plc',
        methodCalls: [{ id: 'call-1', methodId: 'read-value' }],
      });
      const manager = new ProfileManager({
        cgiRoot: root,
        runtimeNeoVersion: '8.5.6',
        controller: { status(_name, callback) { callback(null, { status: state }); } },
      });
      await rejectsCode(
        call(manager, 'createMethod', 'custom-plc', method('new-method')),
        'METHOD_IN_USE_BY_RUNNING_JOB',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const rpcRoot = setupRoot('neo-profile-create-guard-rpc-');
  try {
    writeJson(path.join(rpcRoot, 'conf.d', 'jobs', 'alpha.json'), {
      schemaVersion: 1,
      name: 'alpha',
      profileId: 'custom-plc',
      methodCalls: [{ id: 'call-1', methodId: 'read-value' }],
    });
    const rpcManager = new ProfileManager({
      cgiRoot: rpcRoot,
      runtimeNeoVersion: '8.5.6',
      controller: { status(_name, callback) { callback(new Error('RPC failed')); } },
    });
    await rejectsCode(
      call(rpcManager, 'createMethod', 'custom-plc', method('new-method')),
      'METHOD_IN_USE_BY_RUNNING_JOB',
    );

    const stoppedManager = new ProfileManager({
      cgiRoot: rpcRoot,
      runtimeNeoVersion: '8.5.6',
      controller: { status(_name, callback) { callback(null, { status: 'STOPPED' }); } },
    });
    const current = (await call(stoppedManager, 'getProfile', 'custom-plc')).profile;
    await rejectsCode(
      call(stoppedManager, 'updateProfile', { ...current, methods: [] }),
      'METHOD_IN_USE',
    );
  } finally {
    fs.rmSync(rpcRoot, { recursive: true, force: true });
  }
}

function testStrictValidation() {
  const valid = method('strict-method');
  assert.equal(validateMethod(valid).id, 'strict-method');
  const invalidMethods = [
    { ...valid, password: 'must-not-survive' },
    { ...valid, inputs: [{ ...valid.inputs[0], required: 'yes' }] },
    { ...valid, inputs: [{ ...valid.inputs[0], validation: { minimum: 10, maximum: 1 } }] },
    { ...valid, inputs: [{ ...valid.inputs[0], validation: { pattern: '[' } }] },
    { ...valid, output: { ...valid.output, success: { path: 'bad..path', operator: 'equals', value: 1 } } },
    { ...valid, output: { ...valid.output, success: { path: 'result.code', operator: 'eval', value: 1 } } },
    { ...valid, output: { ...valid.output, returnedCountPath: 'bad()' } },
    { ...valid, output: { ...valid.output, expectedCount: { source: 'input', inputId: 'missing' } } },
  ];
  invalidMethods.forEach((value) => assert.throws(() => validateMethod(value), { code: 'METHOD_INVALID' }));

  const integerMethod = (type, validation) => ({
    ...valid,
    inputs: [{ id: 'count', type, required: true, validation }],
  });
  for (const value of [
    integerMethod('uint64', { minimum: 0.5 }),
    integerMethod('uint64', { minimum: '18446744073709551616' }),
    integerMethod('int64', { minimum: '-9223372036854775809' }),
    integerMethod('uint16', { minimum: -1 }),
    integerMethod('uint16', { maximum: 65536 }),
    integerMethod('uint16', { minimum: 0.5 }),
  ]) {
    assert.throws(() => validateMethod(value), { code: 'METHOD_INVALID' });
  }
  const wide = validateMethod(integerMethod('uint64', {
    minimum: '0', maximum: '18446744073709551615',
  }));
  assert.deepEqual(wide.inputs[0].validation, { minimum: '0', maximum: '18446744073709551615' });
  assert.equal(validateMethod(integerMethod('float64', { minimum: 0.5, maximum: 1.5 })).inputs[0].validation.minimum, 0.5);

  assert.throws(() => validateProfile({ ...profile('strict-profile'), password: 'secret' }), {
    code: 'PROFILE_INVALID',
  });
  assert.throws(() => validateProfile({
    ...profile('too-many-methods'),
    methods: Array.from({ length: MAX_METHODS_PER_PROFILE + 1 }, (_, index) => method(`method-${index}`)),
  }), { code: 'PROFILE_INVALID' });
  assert.throws(() => validateProfile({
    ...profile('too-many-inputs'),
    methods: [{
      ...method('many-inputs'),
      inputs: Array.from({ length: MAX_INPUTS_PER_METHOD + 1 }, (_, index) => ({
        id: `input${index}`, type: 'string', required: true,
      })),
    }],
  }), { code: 'PROFILE_INVALID' });
  assert.throws(() => validateProfile({
    ...profile('too-large'),
    displayName: 'x'.repeat(MAX_PROFILE_JSON_BYTES),
  }), { code: 'PROFILE_INVALID' });
}

function testRuntimeCompatibility() {
  assert.throws(() => new ProfileStore({
    cgiRoot: '/tmp', runtimeNeoVersion: '8.5',
  }), { code: 'RUNTIME_VERSION_INVALID' });
  assert.throws(() => new ProfileStore({
    cgiRoot: '/tmp', runtimeNeoVersion: '8.5.6-01',
  }), { code: 'RUNTIME_VERSION_INVALID' });
  const prefixedRuntime = new ProfileStore({ cgiRoot: '/tmp', runtimeNeoVersion: 'v8.5.6' });
  assert.equal(prefixedRuntime.runtimeNeoVersion, '8.5.6');
  assert.throws(() => validateProfile({
    ...profile('prefixed-min'),
    compatibility: { minNeoVersion: 'v8.5.6' },
  }), { code: 'PROFILE_INVALID' });
  const root = setupRoot('neo-profile-version-');
  try {
    const future = profile('future-plc');
    future.compatibility.minNeoVersion = '9.0.0';
    writeJson(path.join(root, 'conf.d', 'profiles', 'future-plc.json'), future);
    const oldRuntime = new ProfileStore({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    const newRuntime = new ProfileStore({ cgiRoot: root, runtimeNeoVersion: '9.1.0' });
    assert.equal(oldRuntime.isCompatible(oldRuntime.find('future-plc')), false);
    assert.equal(newRuntime.isCompatible(newRuntime.find('future-plc')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testAtomicRenameFailure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-atomic-failure-'));
  const target = path.join(root, 'settings.json');
  fs.writeFileSync(target, '{"old":true}\n', 'utf8');
  const opened = [];
  const writes = [];
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeSync;
  const originalRename = fs.renameSync;
  fs.openSync = (file, flags, ...args) => {
    opened.push({ file: String(file), flags });
    return originalOpen.call(fs, file, flags, ...args);
  };
  fs.writeSync = (descriptor, text, ...args) => {
    writes.push({ descriptor, text });
    return originalWrite.call(fs, descriptor, text, ...args);
  };
  fs.renameSync = () => { throw new Error('rename failed'); };
  try {
    assert.throws(() => writeJsonAtomic(target, { old: false }), /rename failed/);
  } finally {
    fs.openSync = originalOpen;
    fs.writeSync = originalWrite;
    fs.renameSync = originalRename;
  }
  try {
    assert.equal(opened.length, 1);
    assert.equal(opened[0].flags, 'wx');
    assert.match(path.basename(opened[0].file), /\.tmp-[a-f0-9]{24,}$/);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].descriptor, Number(writes[0].descriptor));
    assert.equal(writes[0].text, '{\n  "old": false\n}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}\n');
    assert.deepEqual(fs.readdirSync(root), ['settings.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testDamagedJobDocuments() {
  const cases = [
    {
      name: 'wrong schema',
      document: {
        schemaVersion: 2,
        name: 'damaged',
        profileId: 'custom-plc',
        methodCalls: [{ id: 'call-1', methodId: 'read-value' }],
      },
      mutation(manager, current) {
        return call(manager, 'updateProfile', { ...current, displayName: 'blocked schema' });
      },
    },
    {
      name: 'invalid call element',
      document: {
        schemaVersion: 1,
        name: 'damaged',
        profileId: 'custom-plc',
        methodCalls: [{ id: 'call-1' }],
      },
      mutation(manager) {
        return call(manager, 'createMethod', 'custom-plc', method('new-method'));
      },
    },
    {
      name: 'missing profile id is global',
      document: {
        schemaVersion: 1,
        name: 'damaged',
        methodCalls: [{ id: 'call-1', methodId: 'read-value' }],
      },
      mutation(manager) {
        return call(manager, 'createProfile', profile('unrelated-profile'));
      },
    },
  ];
  for (const testCase of cases) {
    const root = setupRoot(`neo-profile-damaged-${testCase.name.replace(/ /g, '-')}-`);
    try {
      writeJson(path.join(root, 'conf.d', 'jobs', 'damaged.json'), testCase.document);
      const queried = [];
      const manager = new ProfileManager({
        cgiRoot: root,
        runtimeNeoVersion: '8.5.6',
        controller: { status(name, callback) { queried.push(name); callback(null, { status: 'STOPPED' }); } },
      });
      const current = (await call(manager, 'getProfile', 'custom-plc')).profile;
      await rejectsCode(testCase.mutation(manager, current), 'JOB_INVALID_CONFIG');
      assert.deepEqual(queried, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

async function testReferenceDetails() {
  const root = setupRoot('neo-profile-reference-detail-');
  try {
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
      schemaVersion: 1,
      name: 'alpha',
      profileId: 'custom-plc',
      methodCalls: [{ id: 'call-1', methodId: 'read-value' }],
    });
    const manager = new ProfileManager({
      cgiRoot: root,
      runtimeNeoVersion: '8.5.6',
      controller: { status(_name, callback) { callback(null, { status: 'RUNNING' }); } },
    });
    const detail = await call(manager, 'getProfile', 'custom-plc');
    assert.equal(detail.compatibilityReason, null);
    assert.equal(detail.references[0].executionState, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  const cases = [
    ['invalid job identity', testInvalidJobIdentity],
    ['mutation guards', testMutationGuards],
    ['strict validation', testStrictValidation],
    ['runtime compatibility', testRuntimeCompatibility],
    ['atomic rename failure', testAtomicRenameFailure],
    ['damaged job documents', testDamagedJobDocuments],
    ['reference details', testReferenceDetails],
  ];
  const failures = [];
  for (const [name, operation] of cases) {
    try {
      await operation();
    } catch (caseError) {
      failures.push({ name, caseError });
      console.error(`RED ${name}: ${caseError.message}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} review regression case(s) failed`);
}

run().then(() => console.log('Settings/Profile review regressions: ok')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
