'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  jobConfig, methodCall, setupRoot, writeJson,
} = require('./job-fixture.cjs');
const {
  deepMerge, validateJobConfig, validateJobName,
} = require('../src/jobs/validator.js');
const { JobRepository } = require('../src/jobs/repository.js');
const { ProfileStore } = require('../src/profiles/store.js');

function assertCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function run() {
  const root = setupRoot('neo-job-validator-');
  try {
    const profiles = new ProfileStore({ cgiRoot: root, runtimeNeoVersion: '8.5.6' });
    const limits = { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 };
    assert.equal(validateJobName('line_a-01'), 'line_a-01');
    assert.equal(validateJobName(`a${'b'.repeat(99)}`), `a${'b'.repeat(99)}`);
    assertCode(() => validateJobName(`a${'b'.repeat(100)}`), 'JOB_INVALID');
    for (const invalid of ['', 'Line_A-01', '../escape', 'a/b', 'a\\b', '-alpha', 'alpha-', '한글']) {
      assertCode(() => validateJobName(invalid), 'JOB_INVALID');
    }

    const valid = validateJobConfig(jobConfig(), { profileStore: profiles, limits });
    assert.equal(valid.methodCalls.length, 1);
    assert.notStrictEqual(valid, jobConfig());
    const numericOnly = validateJobConfig(jobConfig({
      database: { ...jobConfig().database, stringValueColumn: '' },
    }), { profileStore: profiles, limits });
    assert.equal(numericOnly.database.stringValueColumn, '');
    const hundredCharacterName = 'T'.repeat(100);
    assert.equal(validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: [{ ...methodCall().tags[0], name: hundredCharacterName }, methodCall().tags[1]] })],
    }), { profileStore: profiles, limits }).methodCalls[0].tags[0].name, hundredCharacterName);
    assertCode(() => validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: [{ ...methodCall().tags[0], name: 'T'.repeat(101) }, methodCall().tags[1]] })],
    }), { profileStore: profiles, limits }), 'JOB_INVALID');
    assertCode(() => validateJobConfig({ ...jobConfig(), name: 'hidden' }, {
      profileStore: profiles, limits,
    }), 'JOB_INVALID');

    const badConfigs = [
      jobConfig({ schemaVersion: 2 }),
      jobConfig({ methodCalls: [] }),
      jobConfig({ methodCalls: [methodCall(), methodCall({ name: 'Different' })] }),
      jobConfig({ methodCalls: [methodCall(), methodCall({ id: 'call-2' })] }),
      jobConfig({ methodCalls: [methodCall({ inputs: { dataCount: 0, memoryAddress: '%MB3' } })] }),
      jobConfig({ methodCalls: [methodCall({ inputs: { dataCount: 65536, memoryAddress: '%MB3' } })] }),
      jobConfig({ methodCalls: [methodCall({ inputs: { dataCount: 2 } })] }),
      jobConfig({ methodCalls: [methodCall({ tags: [methodCall().tags[1], methodCall().tags[0]] })] }),
      jobConfig({ methodCalls: [methodCall({ tags: [methodCall().tags[0]] })] }),
      jobConfig({ methodCalls: [methodCall({ tags: methodCall().tags.map((tag) => ({ ...tag, name: 'same' })) })] }),
      jobConfig({ methodCalls: [methodCall({ tags: methodCall().tags.map((tag) => ({ ...tag, bias: Infinity })) })] }),
      jobConfig({ methodCalls: [methodCall({ tags: methodCall().tags.map((tag) => ({ ...tag, calcOrder: 'eval' })) })] }),
      jobConfig({ retry: { initialDelayMs: 30000, maximumDelayMs: 5000, multiplier: 2 } }),
      jobConfig({ execution: { savePolicy: 'sometimes', onMethodError: 'stop' } }),
      jobConfig({ execution: { savePolicy: 'perMethod', onMethodError: 'continue' } }),
      jobConfig({ database: { ...jobConfig().database, server: '../secret' } }),
    ];
    badConfigs.forEach((config) => assertCode(
      () => validateJobConfig(config, { profileStore: profiles, limits }),
      'JOB_INVALID',
    ));

    const wideProfile = {
      id: 'wide-profile',
      methods: [{
        id: 'read-wide',
        inputs: [
          { id: 'maximum', type: 'uint64', required: true },
          { id: 'minimum', type: 'int64', required: true },
          { id: 'ordinary', type: 'uint32', required: true },
        ],
        output: { decoder: 'raw', shape: 'scalar' },
      }],
    };
    const wideStore = { find(id) { return id === wideProfile.id ? wideProfile : null; }, isCompatible() { return true; } };
    const wideCall = methodCall({
      methodId: 'read-wide',
      inputs: { maximum: '18446744073709551615', minimum: '-9223372036854775808', ordinary: 4294967295 },
      tags: [methodCall().tags[0]],
    });
    const wideConfig = jobConfig({ profileId: wideProfile.id, methodCalls: [wideCall] });
    assert.deepEqual(validateJobConfig(wideConfig, { profileStore: wideStore, limits }).methodCalls[0].inputs, wideCall.inputs);
    const damagedProfile = {
      ...wideProfile,
      methods: [{
        ...wideProfile.methods[0],
        inputs: wideProfile.methods[0].inputs.map((input) => (
          input.id === 'maximum' ? { ...input, validation: { minimum: 0.5 } } : input
        )),
      }],
    };
    const damagedStore = { find() { return damagedProfile; }, isCompatible() { return true; } };
    assertCode(() => validateJobConfig(wideConfig, { profileStore: damagedStore, limits }), 'JOB_INVALID');
    for (const inputs of [
      { ...wideCall.inputs, maximum: '18446744073709551616' },
      { ...wideCall.inputs, minimum: '-9223372036854775809' },
      { ...wideCall.inputs, maximum: 18446744073709552000 },
      { ...wideCall.inputs, ordinary: '4294967295' },
    ]) {
      assertCode(() => validateJobConfig(jobConfig({
        profileId: wideProfile.id, methodCalls: [methodCall({ ...wideCall, inputs })],
      }), { profileStore: wideStore, limits }), 'JOB_INVALID');
    }
    assertCode(() => validateJobConfig(jobConfig({
      methodCalls: [methodCall({
        inputs: { dataCount: 2, memoryAddress: '%MB3' },
        tags: [...methodCall().tags, { ...methodCall().tags[1], outputIndex: 2, name: '%MB5' }],
      })],
    }), { profileStore: profiles, limits: { ...limits, maxGeneratedTagsPerCall: 2 } }), 'JOB_INVALID');

    assert.deepEqual(deepMerge(
      { nested: { first: 1, second: 2 }, values: [1, 2] },
      { nested: { second: 3 }, values: [9] },
    ), { nested: { first: 1, second: 3 }, values: [9] });

    const repository = new JobRepository({ cgiRoot: root });
    repository.create('line_a-01', valid);
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'conf.d', 'jobs', 'line_a-01.json'), 'utf8'));
    assert.equal(stored.name, 'line_a-01');
    assert.deepEqual(repository.read('line_a-01'), stored);
    assertCode(() => repository.create('line_a-01', valid), 'JOB_ALREADY_EXISTS');

    const replacement = { ...stored, schedule: { intervalMs: 2000 }, revision: 2 };
    repository.save('line_a-01', replacement, stored.revision);
    assert.deepEqual(repository.read('line_a-01').schedule, { intervalMs: 2000 });
    assert.equal(repository.read('line_a-01').revision, 2);
    assert.equal(fs.readdirSync(repository.directory).some((entry) => entry.includes('.tmp-')), false);

    assert.throws(() => repository.save('line_a-01', {
      ...replacement, schedule: { intervalMs: 3000 }, revision: 2,
    }, stored.revision), (failure) => {
      assert.equal(failure.code, 'JOB_CONFLICT');
      assert.deepEqual(failure.details, {
        name: 'line_a-01', expectedRevision: stored.revision, currentRevision: 2,
      });
      return true;
    });
    assert.equal(repository.read('line_a-01').schedule.intervalMs, 2000);

    writeJson(path.join(repository.directory, 'damaged.json'), { ...stored, name: 'other' });
    assertCode(() => repository.read('damaged'), 'JOB_INVALID_CONFIG');
    const damaged = repository.list().find((record) => record.name === 'damaged');
    assert.equal(damaged.error.code, 'JOB_INVALID_CONFIG');
    assert.equal(damaged.documentName, 'other');
    assertCode(() => repository.remove('damaged'), 'JOB_INVALID_CONFIG');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
console.log('Job validator/repository: ok');
