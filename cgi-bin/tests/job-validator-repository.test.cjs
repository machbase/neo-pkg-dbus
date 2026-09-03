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
const { InterfaceStore } = require('../src/interfaces/store.js');

function assertCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function run() {
  const root = setupRoot('neo-job-validator-');
  try {
    const interfaces = new InterfaceStore({ cgiRoot: root });
    const limits = { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 };
    assert.equal(validateJobName('line_a-01'), 'line_a-01');
    assert.equal(validateJobName(`a${'b'.repeat(99)}`), `a${'b'.repeat(99)}`);
    assertCode(() => validateJobName(`a${'b'.repeat(100)}`), 'JOB_INVALID');
    for (const invalid of ['', 'Line_A-01', '../escape', 'a/b', 'a\\b', '-alpha', 'alpha-', '한글']) {
      assertCode(() => validateJobName(invalid), 'JOB_INVALID');
    }

    const valid = validateJobConfig(jobConfig(), { interfaceStore: interfaces, limits });
    assert.equal(valid.methodCalls.length, 1);
    assert.notStrictEqual(valid, jobConfig());
    assert.equal(validateJobConfig(jobConfig({
      database: { ...jobConfig().database, table: 'lower_case_table' },
    }), { interfaceStore: interfaces, limits }).database.table, 'LOWER_CASE_TABLE');
    assert.deepEqual(valid.methodCalls[0].tags[0], {
      name: '%MB3', bias: 0, multiplier: 1, signed: false,
    });
    const legacyMbTag = { ...methodCall().tags[0], calcOrder: 'mb' };
    assert.deepEqual(validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: [legacyMbTag] })],
    }), { interfaceStore: interfaces, limits }).methodCalls[0].tags[0], {
      name: '%MB3', bias: 0, multiplier: 1, signed: false,
    });
    const newSelection = {
      id: 'output-1', sourceIndex: 0, interpretation: 'json', selector: '/data', valueType: 'array', elementType: 'numeric', tags: methodCall().tags,
    };
    const newSelectionConfig = jobConfig({
      methodCalls: [methodCall({ tags: undefined, outputSelections: [newSelection] })],
    });
    assert.equal(validateJobConfig(newSelectionConfig, { interfaceStore: interfaces, limits }).methodCalls[0].outputSelections[0].selector, '/data');
    assert.deepEqual(validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: undefined, outputSelections: [] })],
    }), { interfaceStore: interfaces, limits }).methodCalls[0].outputSelections, []);
    const nativeStringSelection = {
      id: 'output-native', sourceIndex: 0, interpretation: 'native', tags: [methodCall().tags[0]],
    };
    assert.deepEqual(validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: undefined, outputSelections: [nativeStringSelection] })],
    }), { interfaceStore: interfaces, limits }).methodCalls[0].outputSelections[0], {
      ...nativeStringSelection,
      tags: nativeStringSelection.tags.map(({ name, bias, multiplier }) => ({ name, bias, multiplier, signed: false })),
    });
    const nativeScalarMigration = {
      id: 'output-native-migration', sourceIndex: 0, interpretation: 'native',
      selector: '', valueType: 'string', elementType: undefined,
      tags: [methodCall().tags[0]],
    };
    assert.deepEqual(validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: undefined, outputSelections: [nativeScalarMigration] })],
    }), { interfaceStore: interfaces, limits }).methodCalls[0].outputSelections[0], {
      id: 'output-native-migration', sourceIndex: 0, interpretation: 'native',
      tags: [{ name: '%MB3', bias: 0, multiplier: 1, signed: false }],
    });
    const withoutOutputIndex = methodCall().tags.map(({ name, bias, multiplier }) => ({ name, bias, multiplier }));
    assert.equal(validateJobConfig(jobConfig({ methodCalls: [methodCall({ tags: withoutOutputIndex })] }), {
      interfaceStore: interfaces, limits,
    }).methodCalls[0].tags[0].outputIndex, undefined);
    assertCode(() => validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: undefined, outputSelections: [{ ...newSelection, unexpected: true }] })],
    }), { interfaceStore: interfaces, limits }), 'JOB_INVALID');
    const numericOnly = validateJobConfig(jobConfig({
      database: { ...jobConfig().database, stringValueColumn: '' },
    }), { interfaceStore: interfaces, limits });
    assert.equal(numericOnly.database.stringValueColumn, '');
    const hundredCharacterName = 'T'.repeat(100);
    assert.equal(validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: [{ ...methodCall().tags[0], name: hundredCharacterName }, methodCall().tags[1]] })],
    }), { interfaceStore: interfaces, limits }).methodCalls[0].tags[0].name, hundredCharacterName);
    assertCode(() => validateJobConfig(jobConfig({
      methodCalls: [methodCall({ tags: [{ ...methodCall().tags[0], name: 'T'.repeat(101) }, methodCall().tags[1]] })],
    }), { interfaceStore: interfaces, limits }), 'JOB_INVALID');
    assertCode(() => validateJobConfig({ ...jobConfig(), name: 'hidden' }, {
      interfaceStore: interfaces, limits,
    }), 'JOB_INVALID');

    const badConfigs = [
      jobConfig({ schemaVersion: 2 }),
      jobConfig({ methodCalls: [] }),
      jobConfig({ methodCalls: [methodCall(), methodCall({ name: 'Different' })] }),
      jobConfig({ methodCalls: [methodCall(), methodCall({ id: 'call-2' })] }),
      jobConfig({ methodCalls: [methodCall({ inputs: { dataCount: 0, memoryAddress: '%MB3' } })] }),
      jobConfig({ methodCalls: [methodCall({ inputs: { dataCount: 65536, memoryAddress: '%MB3' } })] }),
      jobConfig({ methodCalls: [methodCall({ inputs: { dataCount: 2 } })] }),
      jobConfig({ methodCalls: [methodCall({ tags: methodCall().tags.map((tag) => ({ ...tag, name: 'same' })) })] }),
      jobConfig({ methodCalls: [methodCall({ tags: methodCall().tags.map((tag) => ({ ...tag, bias: Infinity })) })] }),
      jobConfig({ retry: { initialDelayMs: 30000, maximumDelayMs: 5000, multiplier: 2 } }),
      jobConfig({ execution: { savePolicy: 'sometimes', onMethodError: 'stop' } }),
      jobConfig({ execution: { savePolicy: 'perMethod', onMethodError: 'continue' } }),
      jobConfig({ database: { ...jobConfig().database, server: '../secret' } }),
    ];
    badConfigs.forEach((config) => assertCode(
      () => validateJobConfig(config, { interfaceStore: interfaces, limits }),
      'JOB_INVALID',
    ));

    const wideInterface = {
      id: 'wide-interface', methods: [{ id: 'read-wide', inputs: [
        { name: 'maximum', type: 'uint64', required: true }, { name: 'minimum', type: 'int64', required: true }, { name: 'ordinary', type: 'uint32', required: true },
      ], outputs: [] }],
    };
    const wideStore = { find(id) { return id === wideInterface.id ? wideInterface : null; } };
    const wideCall = methodCall({
      methodId: 'read-wide',
      inputs: { maximum: '18446744073709551615', minimum: '-9223372036854775808', ordinary: 4294967295 },
      tags: [methodCall().tags[0]],
    });
    const wideConfig = jobConfig({ methodCalls: [{ ...wideCall, interfaceId: wideInterface.id }] });
    assert.deepEqual(validateJobConfig(wideConfig, { interfaceStore: wideStore, limits }).methodCalls[0].inputs, wideCall.inputs);
    const damagedInterface = {
      ...wideInterface,
      methods: [{
        ...wideInterface.methods[0],
        inputs: wideInterface.methods[0].inputs.map((input) => (
          input.name === 'maximum' ? { ...input, validation: { minimum: 0.5 } } : input
        )),
      }],
    };
    const damagedStore = { find() { return damagedInterface; } };
    assertCode(() => validateJobConfig(wideConfig, { interfaceStore: damagedStore, limits }), 'JOB_INVALID');
    for (const inputs of [
      { ...wideCall.inputs, maximum: '18446744073709551616' },
      { ...wideCall.inputs, minimum: '-9223372036854775809' },
      { ...wideCall.inputs, maximum: 18446744073709552000 },
      { ...wideCall.inputs, ordinary: '4294967295' },
    ]) {
      assertCode(() => validateJobConfig(jobConfig({
        methodCalls: [{ ...wideCall, interfaceId: wideInterface.id, inputs }],
      }), { interfaceStore: wideStore, limits }), 'JOB_INVALID');
    }
    assertCode(() => validateJobConfig(jobConfig({
      methodCalls: [methodCall({
        inputs: { dataCount: 2, memoryAddress: '%MB3' },
        tags: [...methodCall().tags, { ...methodCall().tags[1], outputIndex: 2, name: '%MB5' }],
      })],
    }), { interfaceStore: interfaces, limits: { ...limits, maxGeneratedTagsPerCall: 2 } }), 'JOB_INVALID');

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
