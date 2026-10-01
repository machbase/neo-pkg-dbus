'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JobIndexRepository } = require('../src/jobs/index-repository.js');
const { JobRepository } = require('../src/jobs/repository.js');
const { createTestModeNormalizer } = require('../src/jobs/test-mode-normalizer.js');
const productPolicy = require('../../products/ls/backend/index.js');

function document(name = 'internal-test') {
  return {
    schemaVersion: 1,
    name,
    revision: 1,
    profileId: 'ls-electric-plc',
    schedule: { intervalMs: 10 },
    execution: { savePolicy: 'perMethod', onMethodError: 'stop', test: true },
    methodCalls: [{
      id: 'read-a',
      interfaceId: 'ls-plc-device',
      methodId: 'get-device-data',
      inputs: { DataCount: 1, DeviceString: '%MB0' },
      outputSelections: [{ tags: [{ name: 'test-a' }] }],
    }],
    database: {
      server: 'local-db', table: 'T4_DBUS_TEST_', valueColumn: 'VALUE', stringValueColumn: '',
    },
    log: { level: 'info', maxFiles: 3 },
  };
}

test('database profile mismatch persistently disables TEST and never re-enables it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-test-normalizer-'));
  try {
    const repository = new JobRepository({ cgiRoot: root });
    const indexRepository = new JobIndexRepository({
      cgiRoot: root,
      jobDirectory: repository.directory,
    });
    const original = repository.createAtomic('internal-test', document());
    indexRepository.write(original);
    const normalizer = createTestModeNormalizer({
      cgiRoot: root,
      repository,
      indexRepository,
      productPolicy,
    });

    assert.deepEqual(normalizer.disableForDatabase('local-db', 'PRODUCTION_TAG'), ['internal-test']);
    assert.equal(repository.read('internal-test').execution.test, false);
    assert.equal(repository.read('internal-test').revision, 2);
    assert.equal(indexRepository.read('internal-test').execution.test, false);
    assert.equal(indexRepository.read('internal-test').revision, 2);

    assert.deepEqual(normalizer.disableForDatabase('local-db', 'T4_DBUS_TEST_'), []);
    assert.equal(repository.read('internal-test').execution.test, false);
    assert.equal(repository.read('internal-test').revision, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('normalizer leaves TEST Jobs for a different database profile unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-test-normalizer-other-'));
  try {
    const repository = new JobRepository({ cgiRoot: root });
    const indexRepository = new JobIndexRepository({
      cgiRoot: root,
      jobDirectory: repository.directory,
    });
    const original = repository.createAtomic('internal-test', document());
    indexRepository.write(original);
    const normalizer = createTestModeNormalizer({
      cgiRoot: root,
      repository,
      indexRepository,
      productPolicy,
    });

    assert.deepEqual(normalizer.disableForDatabase('different-db', 'PRODUCTION_TAG'), []);
    assert.equal(repository.read('internal-test').execution.test, true);
    assert.equal(repository.read('internal-test').revision, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
