'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { JobManager } = require('../src/jobs/manager.js');
const { ProfileManager } = require('../src/profiles/manager.js');
const { createJobOperationLock } = require('../src/jobs/operation-lock.js');
const { call, jobConfig, setupRoot, writeJson } = require('./job-fixture.cjs');

function service() {
  const states = new Map([['_dbu_alpha', { status: 'STOPPED' }]]);
  const calls = [];
  let pendingStart = null;
  let startStarted;
  let resolveStartStarted;
  function resetStart() { startStarted = new Promise((resolve) => { resolveStartStarted = resolve; }); }
  resetStart();
  class Client {
    status(name, callback) {
      if (!states.has(name)) { const missing = new Error('missing'); missing.rpcCode = -32004; callback(missing); return; }
      callback(null, states.get(name));
    }
    start(name, callback) { calls.push(['start', name]); pendingStart = { name, callback }; resolveStartStarted(); }
  }
  return {
    Client, calls,
    direct: { status(name, callback) { new Client().status(name, callback); } },
    waitStart() { return startStarted; },
    finishStart() { const pending = pendingStart; pendingStart = null; states.set(pending.name, { status: 'RUNNING' }); pending.callback(null, { status: 'RUNNING' }); },
  };
}

function customProfile(root) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'profiles.d', 'ls-electric-plc.json'), 'utf8'));
  const custom = { ...source, id: 'custom-plc', displayName: 'Custom PLC', builtIn: false };
  writeJson(path.join(root, 'conf.d', 'profiles', 'custom-plc.json'), custom);
  return custom;
}

function database() { return { validate(_value, callback) { callback(null, {}); } }; }

function methodFrom(profile, id) {
  return { ...profile.methods[0], id, displayName: `Method ${id}` };
}

function expectedProfileLockKey(profileId) {
  return crypto.createHash('sha256').update(String(profileId), 'utf8').digest('hex');
}

function interleaveBeforeFence(manager, profileId, operation) {
  const base = manager.profileMutationLock;
  let interleaved = false;
  manager.profileMutationLock = {
    acquire(id) {
      if (!interleaved && id === expectedProfileLockKey(profileId)) {
        interleaved = true;
        operation();
      }
      return base.acquire(id);
    },
  };
  return () => interleaved;
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (failure) => failure && failure.code === code);
}

async function testProfilePutHoldsReferenceJobLockAgainstStart() {
  const root = setupRoot('neo-profile-job-put-start-race-');
  try {
    const profile = customProfile(root);
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
      ...jobConfig({ profileId: 'custom-plc' }), name: 'alpha', revision: 1,
    });
    const runtime = service();
    const profiles = new ProfileManager({ cgiRoot: root, controller: runtime.direct, runtimeNeoVersion: '8.5.6' });
    const jobs = new JobManager({ cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), runtimeNeoVersion: '8.5.6' });
    const originalSave = profiles.store.save.bind(profiles.store);
    let racedStart;
    profiles.store.save = (value) => {
      racedStart = call(jobs, 'start', 'alpha');
      return originalSave(value);
    };

    const updated = await call(profiles, 'updateProfile', { ...profile, displayName: 'Updated safely' });
    assert.equal(updated.displayName, 'Updated safely');
    if (runtime.calls.length) runtime.finishStart();
    await rejectsCode(racedStart, 'JOB_CONFLICT');
    assert.equal(runtime.calls.length, 0, 'Profile 저장 중 Start Controller 호출은 금지되어야 합니다.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testStartHoldsReferenceJobLockAgainstProfilePut() {
  const root = setupRoot('neo-profile-job-start-put-race-');
  try {
    const profile = customProfile(root);
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
      ...jobConfig({ profileId: 'custom-plc' }), name: 'alpha', revision: 1,
    });
    const runtime = service();
    const profiles = new ProfileManager({ cgiRoot: root, controller: runtime.direct, runtimeNeoVersion: '8.5.6' });
    const jobs = new JobManager({ cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), runtimeNeoVersion: '8.5.6' });

    const starting = call(jobs, 'start', 'alpha');
    await runtime.waitStart();
    await rejectsCode(call(profiles, 'updateProfile', { ...profile, displayName: 'must not save' }), 'JOB_CONFLICT');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'profiles', 'custom-plc.json'), 'utf8')).displayName, 'Custom PLC');
    runtime.finishStart();
    await starting;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testCreateHoldsFreshProfileReaderBeforeValidation() {
  const root = setupRoot('neo-profile-job-create-reader-race-');
  try {
    const profile = customProfile(root);
    const runtime = service();
    const profiles = new ProfileManager({ cgiRoot: root, controller: runtime.direct, runtimeNeoVersion: '8.5.6' });
    const store = profiles.store;
    const originalFind = store.find.bind(store);
    let mutationFailure = null;
    let interleaved = false;
    store.find = (id) => {
      if (!interleaved && id === 'custom-plc') {
        interleaved = true;
        profiles.updateMethod('custom-plc', { ...profile.methods[0], displayName: 'must conflict' }, (failure) => { mutationFailure = failure; });
      }
      return originalFind(id);
    };
    const jobs = new JobManager({ cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), profileStore: store, runtimeNeoVersion: '8.5.6' });
    const created = await call(jobs, 'create', { name: 'beta', config: jobConfig({ profileId: 'custom-plc' }) });
    assert.equal(created.name, 'beta');
    assert.equal(interleaved, true);
    assert.equal(mutationFailure && mutationFailure.code, 'JOB_CONFLICT', 'Profile Method 저장은 새 Job의 reader와 함께 성공하면 안 됩니다.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testStartReadsCurrentProfileBeforeTakingReader() {
  const root = setupRoot('neo-profile-job-start-fresh-reader-');
  try {
    const profile = customProfile(root);
    const b = { ...profile, id: 'custom-plc-b', displayName: 'Custom PLC B' };
    writeJson(path.join(root, 'conf.d', 'profiles', 'custom-plc-b.json'), b);
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), { ...jobConfig({ profileId: 'custom-plc-b' }), name: 'alpha', revision: 2 });
    const runtime = service(); const profiles = new ProfileManager({ cgiRoot: root, controller: runtime.direct, runtimeNeoVersion: '8.5.6' });
    const base = createJobOperationLock({ directory: path.join(root, 'conf.d', '.profile-mutation-readers') }); let mutation;
    const reader = { assertAvailable: (...args) => base.assertAvailable(...args), acquire(key) { const handle = base.acquire(key); if (key === `${expectedProfileLockKey('custom-plc-b')}--alpha`) profiles.updateMethod('custom-plc-b', { ...b.methods[0], displayName: 'blocked B' }, (failure) => { mutation = failure; }); return handle; } };
    const jobs = new JobManager({ cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), profileReaderLock: reader, runtimeNeoVersion: '8.5.6' });
    const started = call(jobs, 'start', 'alpha');
    runtime.finishStart();
    await started;
    assert.equal(mutation && mutation.code, 'JOB_CONFLICT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testUpdateHoldsBothFreshAndTargetProfileReaders() {
  const root = setupRoot('neo-profile-job-update-fresh-reader-');
  try {
    const a = customProfile(root); const b = { ...a, id: 'custom-plc-b', displayName: 'Custom PLC B' };
    writeJson(path.join(root, 'conf.d', 'profiles', 'custom-plc-b.json'), b);
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), { ...jobConfig({ profileId: 'custom-plc-b' }), name: 'alpha', revision: 2 });
    const runtime = service(); const profiles = new ProfileManager({ cgiRoot: root, controller: runtime.direct, runtimeNeoVersion: '8.5.6' });
    const base = createJobOperationLock({ directory: path.join(root, 'conf.d', '.profile-mutation-readers') }); const mutations = {};
    const reader = { assertAvailable: (...args) => base.assertAvailable(...args), acquire(key) { const handle = base.acquire(key); const profile = key.startsWith(`${expectedProfileLockKey('custom-plc-b')}--`) ? b : a; if (key.endsWith('--alpha')) profiles.updateMethod(profile.id, { ...profile.methods[0], displayName: 'blocked' }, (failure) => { mutations[profile.id] = failure; }); return handle; } };
    const jobs = new JobManager({ cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), profileReaderLock: reader, runtimeNeoVersion: '8.5.6' });
    await call(jobs, 'update', 'alpha', { revision: 2, profileId: 'custom-plc', schedule: { intervalMs: 2000 } });
    assert.equal(mutations['custom-plc-b'] && mutations['custom-plc-b'].code, 'JOB_CONFLICT');
    assert.equal(mutations['custom-plc'] && mutations['custom-plc'].code, 'JOB_CONFLICT');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testCreateProfileChecksExistenceAfterFence() {
  const root = setupRoot('neo-profile-create-fence-race-');
  try {
    const template = customProfile(root);
    const raced = { ...template, id: 'raced-profile', displayName: 'Raced profile', profileVersion: 1 };
    const first = new ProfileManager({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    const second = new ProfileManager({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    let secondFailure = null;
    const didInterleave = interleaveBeforeFence(first, raced.id, () => {
      second.createProfile(raced, (failure) => { secondFailure = failure; });
    });
    await rejectsCode(call(first, 'createProfile', raced), 'PROFILE_ALREADY_EXISTS');
    assert.equal(didInterleave(), true);
    assert.equal(secondFailure, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testProfileAndMethodWritersReadLatestProfileAfterFence() {
  const root = setupRoot('neo-profile-writer-fence-race-');
  try {
    const current = customProfile(root);
    const first = new ProfileManager({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    const second = new ProfileManager({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    const secondMethod = methodFrom(current, 'second-value');
    let secondFailure = null;
    const didInterleave = interleaveBeforeFence(first, current.id, () => {
      second.createMethod(current.id, secondMethod, (failure) => { secondFailure = failure; });
    });
    await call(first, 'createMethod', current.id, methodFrom(current, 'first-value'));
    assert.equal(didInterleave(), true);
    assert.equal(secondFailure, null);
    let stored = first.store.find(current.id);
    assert.deepEqual(stored.methods.map((item) => item.id).sort(), ['first-value', 'get-device-data', 'second-value']);

    const thirdMethod = methodFrom(current, 'third-value');
    let thirdFailure = null;
    const didUpdateInterleave = interleaveBeforeFence(first, current.id, () => {
      second.createMethod(current.id, thirdMethod, (failure) => { thirdFailure = failure; });
    });
    const firstMethod = stored.methods.find((item) => item.id === 'first-value');
    await call(first, 'updateMethod', current.id, { ...firstMethod, displayName: 'First value updated' });
    assert.equal(didUpdateInterleave(), true);
    assert.equal(thirdFailure, null);
    stored = first.store.find(current.id);
    assert.equal(stored.methods.find((item) => item.id === 'first-value').displayName, 'First value updated');
    assert.equal(stored.methods.some((item) => item.id === 'third-value'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testProfileUpdateDoesNotRecreateDeletedProfile() {
  const root = setupRoot('neo-profile-update-delete-race-');
  try {
    const current = customProfile(root);
    const first = new ProfileManager({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    const second = new ProfileManager({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    let deleteFailure = null;
    const didInterleave = interleaveBeforeFence(first, current.id, () => {
      second.deleteProfile(current.id, (failure) => { deleteFailure = failure; });
    });
    await rejectsCode(call(first, 'updateProfile', { ...current, displayName: 'Must not recreate' }), 'PROFILE_NOT_FOUND');
    assert.equal(didInterleave(), true);
    assert.equal(deleteFailure, null);
    assert.equal(first.store.find(current.id), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testProfilePutRechecksRemovedMethodReferencesAfterFence() {
  const root = setupRoot('neo-profile-removed-method-fence-race-');
  try {
    const current = customProfile(root);
    const removable = methodFrom(current, 'remove-value');
    writeJson(path.join(root, 'conf.d', 'profiles', 'custom-plc.json'), { ...current, methods: [...current.methods, removable] });
    writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
      ...jobConfig({ profileId: current.id }), name: 'alpha', revision: 1,
    });
    const runtime = service();
    const first = new ProfileManager({ cgiRoot: root, controller: runtime.direct, runtimeNeoVersion: '8.5.6' });
    const jobs = new JobManager({ cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), runtimeNeoVersion: '8.5.6' });
    let updateFailure = null;
    const didInterleave = interleaveBeforeFence(first, current.id, () => {
      jobs.update('alpha', {
        revision: 1,
        methodCalls: [{ ...jobConfig().methodCalls[0], methodId: removable.id }],
      }, (failure) => { updateFailure = failure; });
    });
    await rejectsCode(call(first, 'updateProfile', {
      ...current, methods: current.methods,
    }), 'METHOD_IN_USE');
    assert.equal(didInterleave(), true);
    assert.equal(updateFailure, null);
    assert.equal(first.store.find(current.id).methods.some((item) => item.id === removable.id), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function testDeleteReleasesFenceAfterReaderConflict() {
  const methodRoot = setupRoot('neo-profile-method-delete-reader-race-');
  try {
    const current = customProfile(methodRoot);
    const manager = new ProfileManager({ cgiRoot: methodRoot, runtimeNeoVersion: '8.5.6' });
    const readers = createJobOperationLock({ directory: path.join(methodRoot, 'conf.d', '.profile-mutation-readers') });
    const reader = readers.acquire(`${expectedProfileLockKey(current.id)}--alpha`);
    await rejectsCode(call(manager, 'deleteMethod', current.id, current.methods[0].id), 'JOB_CONFLICT');
    reader.release();
    await call(manager, 'deleteMethod', current.id, current.methods[0].id);
  } finally { fs.rmSync(methodRoot, { recursive: true, force: true }); }

  const profileRoot = setupRoot('neo-profile-delete-reader-race-');
  try {
    const current = customProfile(profileRoot);
    const manager = new ProfileManager({ cgiRoot: profileRoot, runtimeNeoVersion: '8.5.6' });
    const readers = createJobOperationLock({ directory: path.join(profileRoot, 'conf.d', '.profile-mutation-readers') });
    const reader = readers.acquire(`${expectedProfileLockKey(current.id)}--alpha`);
    await rejectsCode(call(manager, 'deleteProfile', current.id), 'JOB_CONFLICT');
    reader.release();
    await call(manager, 'deleteProfile', current.id);
    assert.equal(manager.store.find(current.id), null);
  } finally { fs.rmSync(profileRoot, { recursive: true, force: true }); }
}

async function testProfileLockKeysAndFreshReadersUsePostLockProfile() {
  const profileRoot = setupRoot('neo-profile-lock-key-');
  try {
    const manager = new ProfileManager({ cgiRoot: profileRoot, runtimeNeoVersion: '8.5.6' });
    const base = createJobOperationLock({ directory: path.join(profileRoot, 'conf.d', '.profile-mutation-locks') });
    const keys = [];
    manager.profileMutationLock = {
      acquire(key) { keys.push(key); return base.acquire(key); },
    };
    await rejectsCode(call(manager, 'deleteProfile', '../escape'), 'PROFILE_NOT_FOUND');
    assert.deepEqual(keys, [expectedProfileLockKey('../escape')]);

    const tooLongProfileId = 'p'.repeat(300);
    await rejectsCode(call(manager, 'deleteProfile', tooLongProfileId), 'PROFILE_NOT_FOUND');
    assert.equal(keys.at(-1), expectedProfileLockKey(tooLongProfileId));

    const jobs = new JobManager({
      cgiRoot: profileRoot,
      profileMutationLock: { assertAvailable(key) { keys.push(key); } },
      runtimeNeoVersion: '8.5.6',
    });
    jobs.assertProfileMutationAvailable('../escape', 'alpha');
    assert.equal(keys.at(-1), expectedProfileLockKey('../escape'));
    jobs.assertProfileMutationAvailable(tooLongProfileId, 'alpha');
    assert.equal(keys.at(-1), expectedProfileLockKey(tooLongProfileId));
    await rejectsCode(call(jobs, 'create', {
      name: 'long-profile-job', config: jobConfig({ profileId: tooLongProfileId }),
    }), 'JOB_INVALID');
  } finally { fs.rmSync(profileRoot, { recursive: true, force: true }); }

  for (const action of ['start', 'update']) {
    const root = setupRoot(`neo-job-${action}-fresh-profile-reader-`);
    try {
      const a = customProfile(root);
      const b = { ...a, id: 'custom-plc-b', displayName: 'Custom PLC B' };
      writeJson(path.join(root, 'conf.d', 'profiles', 'custom-plc-b.json'), b);
      writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
        ...jobConfig({ profileId: a.id }), name: 'alpha', revision: 1,
      });
      const runtime = service();
      const operationBase = createJobOperationLock({ directory: path.join(root, 'conf.d', '.job-operation-locks') });
      let replaced = false;
      const operationLock = {
        acquire(name) {
          const handle = operationBase.acquire(name);
          if (!replaced) {
            replaced = true;
            writeJson(path.join(root, 'conf.d', 'jobs', 'alpha.json'), {
              ...jobConfig({ profileId: b.id }), name: 'alpha', revision: 1,
            });
          }
          return handle;
        },
      };
      const readerBase = createJobOperationLock({ directory: path.join(root, 'conf.d', '.profile-mutation-readers') });
      const readerKeys = [];
      const reader = {
        assertAvailable: (...args) => readerBase.assertAvailable(...args),
        acquire(key) { readerKeys.push(key); return readerBase.acquire(key); },
      };
      const jobs = new JobManager({
        cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), operationLock,
        profileReaderLock: reader, runtimeNeoVersion: '8.5.6',
      });
      if (action === 'start') {
        const started = call(jobs, 'start', 'alpha');
        runtime.finishStart();
        await started;
      } else {
        await call(jobs, 'update', 'alpha', { revision: 1, schedule: { intervalMs: 2000 } });
      }
      assert.equal(readerKeys.includes(`${expectedProfileLockKey('custom-plc-b')}--alpha`), true);
      assert.equal(readerKeys.includes(`${expectedProfileLockKey('custom-plc')}--alpha`), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

async function testBoundedProfileReaderKeySupportsTwoHundredCharacterNames() {
  const root = setupRoot('neo-profile-reader-name-bound-');
  try {
    const profileId = `p${'a'.repeat(99)}`;
    const jobName = `j${'b'.repeat(99)}`;
    const source = customProfile(root);
    writeJson(path.join(root, 'conf.d', 'profiles', `${profileId}.json`), {
      ...source, id: profileId, displayName: 'Long Profile',
    });
    const readerBase = createJobOperationLock({ directory: path.join(root, 'conf.d', '.profile-mutation-readers') });
    const readerKeys = [];
    const reader = {
      assertAvailable: (...args) => readerBase.assertAvailable(...args),
      acquire(key) { readerKeys.push(key); return readerBase.acquire(key); },
    };
    const runtime = service();
    const jobs = new JobManager({
      cgiRoot: root, serviceModule: runtime, databaseAdapter: database(), profileReaderLock: reader, runtimeNeoVersion: '8.5.6',
    });
    await call(jobs, 'create', { name: jobName, config: jobConfig({ profileId }) });
    assert.deepEqual(readerKeys, [`${expectedProfileLockKey(profileId)}--${jobName}`]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function run() {
  await testProfilePutHoldsReferenceJobLockAgainstStart();
  await testStartHoldsReferenceJobLockAgainstProfilePut();
  await testCreateHoldsFreshProfileReaderBeforeValidation();
  await testStartReadsCurrentProfileBeforeTakingReader();
  await testUpdateHoldsBothFreshAndTargetProfileReaders();
  await testCreateProfileChecksExistenceAfterFence();
  await testProfileAndMethodWritersReadLatestProfileAfterFence();
  await testProfileUpdateDoesNotRecreateDeletedProfile();
  await testProfilePutRechecksRemovedMethodReferencesAfterFence();
  await testDeleteReleasesFenceAfterReaderConflict();
  await testProfileLockKeysAndFreshReadersUsePostLockProfile();
  await testBoundedProfileReaderKeySupportsTwoHundredCharacterNames();
}

run().then(() => console.log('Profile/Job mutation race: ok')).catch((failure) => { console.error(failure); process.exitCode = 1; });
