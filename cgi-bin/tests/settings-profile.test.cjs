'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SettingsManager } = require('../src/config/settings-manager.js');
const { ProfileManager } = require('../src/profiles/manager.js');

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function method(id) {
  return {
    id,
    displayName: `Method ${id}`,
    objectPath: '/example/device',
    interface: 'example.device',
    methodName: 'ReadValue',
    inputs: [
      { id: 'address', type: 'string', required: true },
    ],
    output: { decoder: 'json', shape: 'array', path: 'payload.values' },
  };
}

function profile(id) {
  return {
    schemaVersion: 1,
    id,
    profileVersion: 1,
    displayName: `Profile ${id}`,
    vendor: 'Example',
    builtIn: true,
    compatibility: { minNeoVersion: '8.5.6' },
    defaults: { busType: 'system', destination: 'example.device' },
    methods: [method('read-value')],
  };
}

function fakeController(states) {
  return {
    status(name, callback) {
      const state = states[name];
      if (state instanceof Error) callback(state);
      else callback(null, state === undefined ? { status: 'STOPPED' } : { status: state });
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-settings-profile-'));
  try {
    const builtIn = profile('ls-electric-plc');
    builtIn.builtIn = true;
    writeJson(path.join(root, 'profiles.d', 'ls-electric-plc.json'), builtIn);
    writeJson(path.join(root, 'conf.d', 'settings.json'), {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
    });

    const manager = new ProfileManager({ cgiRoot: root, controller: fakeController({}) });
    const settings = new SettingsManager({ cgiRoot: root });

    assert.deepEqual(await call(settings, 'get'), {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
      defaults: { database: { server: 'localhost' } },
      logging: { maxFileBytes: 1024 * 1024, maxFiles: 3, summaryIntervalMs: 60 * 60 * 1000 },
      provider: null,
    });
    const updatedSettings = await call(settings, 'update', {
      limits: { maxGeneratedTagsPerCall: 250, maxBufferedRowsPerCycle: 2000 },
    });
    assert.equal(updatedSettings.limits.maxGeneratedTagsPerCall, 250);
    assert.equal(Object.hasOwn(updatedSettings, 'provider'), false);

    await rejectsCode(call(settings, 'update', {
      provider: null,
      defaults: updatedSettings.defaults,
    }), 'SETTINGS_INVALID');
    assert.equal(fs.existsSync(path.join(root, 'provider.json')), false);

    const builtInDetail = await call(manager, 'getProfile', 'ls-electric-plc');
    assert.equal(builtInDetail.profile.builtIn, true);
    await rejectsCode(call(manager, 'updateProfile', builtIn), 'PROFILE_READ_ONLY');
    await rejectsCode(call(manager, 'deleteProfile', 'ls-electric-plc'), 'PROFILE_READ_ONLY');

    const created = await call(manager, 'createProfile', profile('custom-plc'));
    assert.equal(created.builtIn, false);
    assert.equal(created.profileVersion, 1);
    assert.equal(fs.existsSync(path.join(root, 'conf.d', 'profiles', 'custom-plc.json')), true);
    const hundredCharacterProfileId = `p${'a'.repeat(99)}`;
    assert.equal((await call(manager, 'createProfile', profile(hundredCharacterProfileId))).id, hundredCharacterProfileId);
    await rejectsCode(call(manager, 'createProfile', profile(`p${'a'.repeat(100)}`)), 'PROFILE_INVALID');
    await rejectsCode(call(manager, 'createProfile', profile('custom-plc')), 'PROFILE_ALREADY_EXISTS');

    const changed = { ...created, displayName: 'Changed profile' };
    const updated = await call(manager, 'updateProfile', changed);
    assert.equal(updated.displayName, 'Changed profile');
    assert.equal(updated.profileVersion, 2);

    const addedMethod = await call(manager, 'createMethod', 'custom-plc', method('write-value'));
    assert.equal(addedMethod.id, 'write-value');
    assert.equal((await call(manager, 'getProfile', 'custom-plc')).profile.profileVersion, 3);
    await rejectsCode(
      call(manager, 'createMethod', 'custom-plc', method('write-value')),
      'METHOD_ALREADY_EXISTS',
    );
    const editedMethod = await call(manager, 'updateMethod', 'custom-plc', {
      ...addedMethod,
      displayName: 'Write changed',
    });
    assert.equal(editedMethod.displayName, 'Write changed');
    assert.equal((await call(manager, 'getProfile', 'custom-plc')).profile.profileVersion, 4);
    await call(manager, 'deleteMethod', 'custom-plc', 'write-value');
    assert.equal((await call(manager, 'getProfile', 'custom-plc')).profile.profileVersion, 5);
    await rejectsCode(call(manager, 'getMethod', 'custom-plc', 'write-value'), 'METHOD_NOT_FOUND');

    await call(manager, 'deleteProfile', 'custom-plc');
    await rejectsCode(call(manager, 'getProfile', 'custom-plc'), 'PROFILE_NOT_FOUND');

    await rejectsCode(call(manager, 'createProfile', {
      ...profile('../escape'),
      id: '../escape',
    }), 'PROFILE_INVALID');
    await rejectsCode(call(manager, 'createProfile', {
      ...profile('bad-method'),
      methods: [{ ...method('bad'), objectPath: 'relative/path' }],
    }), 'PROFILE_INVALID');
    await rejectsCode(call(manager, 'createProfile', {
      ...profile('bad-capability'),
      methods: [{
        ...method('bad'),
        tagGeneration: { capability: 'ls-get-device-data', countInputId: 'missing' },
      }],
    }), 'PROFILE_INVALID');
    await rejectsCode(call(manager, 'createProfile', {
      ...profile('fractional-wide-bound'),
      methods: [{
        ...method('read-wide'),
        inputs: [{ id: 'value', type: 'uint64', required: true, validation: { minimum: 0.5 } }],
      }],
    }), 'PROFILE_INVALID');

    const filesAfterAtomicWrite = fs.readdirSync(path.join(root, 'conf.d'));
    assert.equal(filesAfterAtomicWrite.some((name) => name.includes('.tmp-')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'settings.json'), 'utf8')),
      updatedSettings);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const guardedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-profile-guard-'));
  try {
    writeJson(path.join(guardedRoot, 'conf.d', 'settings.json'), {
      schemaVersion: 1,
      limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
    });
    writeJson(path.join(guardedRoot, 'conf.d', 'profiles', 'custom-plc.json'), {
      ...profile('custom-plc'), builtIn: false,
    });
    writeJson(path.join(guardedRoot, 'conf.d', 'jobs', 'running.json'), {
      schemaVersion: 1,
      name: 'running',
      profileId: 'custom-plc',
      methodCalls: [{ id: 'call-1', methodId: 'read-value' }],
    });
    const running = new ProfileManager({
      cgiRoot: guardedRoot,
      controller: fakeController({ _dbu_running: 'RUNNING' }),
    });
    const current = (await call(running, 'getProfile', 'custom-plc')).profile;
    await rejectsCode(
      call(running, 'updateProfile', { ...current, displayName: 'blocked' }),
      'PROFILE_IN_USE_BY_RUNNING_JOB',
    );
    await rejectsCode(
      call(running, 'updateMethod', 'custom-plc', { ...method('read-value'), displayName: 'blocked' }),
      'METHOD_IN_USE_BY_RUNNING_JOB',
    );
    await rejectsCode(call(running, 'deleteMethod', 'custom-plc', 'read-value'), 'METHOD_IN_USE');
    await rejectsCode(call(running, 'deleteProfile', 'custom-plc'), 'PROFILE_IN_USE');

    const unknown = new ProfileManager({
      cgiRoot: guardedRoot,
      controller: fakeController({ _dbu_running: 'PAUSED' }),
    });
    await rejectsCode(
      call(unknown, 'updateProfile', { ...current, displayName: 'blocked unknown' }),
      'PROFILE_IN_USE_BY_RUNNING_JOB',
    );

    const notInstalledError = new Error('service not found');
    notInstalledError.rpcCode = -32004;
    const configOnly = new ProfileManager({
      cgiRoot: guardedRoot,
      controller: fakeController({ _dbu_running: notInstalledError }),
    });
    const configOnlyUpdate = await call(configOnly, 'updateProfile', {
      ...current,
      displayName: 'config-only can change',
    });
    assert.equal(configOnlyUpdate.displayName, 'config-only can change');

    const unavailable = new ProfileManager({
      cgiRoot: guardedRoot,
      controller: fakeController({ _dbu_running: new Error('RPC unavailable') }),
    });
    await rejectsCode(
      call(unavailable, 'updateMethod', 'custom-plc', method('read-value')),
      'METHOD_IN_USE_BY_RUNNING_JOB',
    );

    let clientInstances = 0;
    const stoppedClientManager = new ProfileManager({
      cgiRoot: guardedRoot,
      serviceModule: {
        Client: class FakeClient {
          constructor() { clientInstances += 1; }
          status(_name, callback) { callback(null, { status: 'STOPPED' }); }
        },
      },
    });
    const stoppedCurrent = (await call(stoppedClientManager, 'getProfile', 'custom-plc')).profile;
    const clientUpdated = await call(stoppedClientManager, 'updateProfile', {
      ...stoppedCurrent, displayName: 'Client adapter used',
    });
    assert.equal(clientUpdated.displayName, 'Client adapter used');
    assert.equal(clientInstances, 1);
  } finally {
    fs.rmSync(guardedRoot, { recursive: true, force: true });
  }

  const providerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-provider-profile-'));
  try {
    const provider = {
      schemaVersion: 1,
      id: 'ls',
      jobMode: 'fixed',
      interfaceId: 'ls-plc-device',
      methodId: 'get-device-data',
      outputSelections: [{
        id: 'return-data',
        sourceIndex: 0,
        interpretation: 'json',
        selector: '/data',
        valueType: 'array',
        elementType: 'numeric',
        tags: [],
      }],
      tagGenerator: { kind: 'ls-memory-address-v1' },
    };
    writeJson(path.join(providerRoot, 'provider.json'), provider);
    const providerSettings = new SettingsManager({ cgiRoot: providerRoot });
    assert.deepEqual((await call(providerSettings, 'get')).provider, provider);

    const { loadProviderProfile, validateProviderProfile } = require('../src/config/provider-profile.js');
    assert.deepEqual(loadProviderProfile(providerRoot), provider);
    assert.throws(() => validateProviderProfile({ ...provider, password: 'secret' }), {
      code: 'PROVIDER_PROFILE_INVALID',
    });
    assert.throws(() => validateProviderProfile({
      ...provider,
      outputSelections: [{ ...provider.outputSelections[0], tags: [{ name: 'must-not-live-here' }] }],
    }), { code: 'PROVIDER_PROFILE_INVALID' });
    assert.throws(() => validateProviderProfile({
      ...provider,
      tagGenerator: { kind: 'unsupported' },
    }), { code: 'PROVIDER_PROFILE_INVALID' });
    assert.throws(() => validateProviderProfile({
      ...provider,
      outputSelections: [{
        ...provider.outputSelections[0],
        interpretation: 'native',
        selector: undefined,
      }],
    }), { code: 'PROVIDER_PROFILE_INVALID' });

    fs.writeFileSync(path.join(providerRoot, 'provider.json'), '{bad json', 'utf8');
    await rejectsCode(call(providerSettings, 'get'), 'PROVIDER_PROFILE_INVALID');
  } finally {
    fs.rmSync(providerRoot, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log('Settings/Profile/Method management: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
