'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateJobConfig } = require('../src/jobs/validator.js');

function config() {
  return {
    schemaVersion: 1,
    schedule: { intervalMs: 1000 },
    retry: { initialDelayMs: 5000, maximumDelayMs: 30000, multiplier: 2 },
    execution: { savePolicy: 'perMethod', onMethodError: 'stop' },
    methodCalls: [{
      id: 'read-1', name: 'Read 1', interfaceId: 'device-status', methodId: 'read-value',
      inputs: { address: 'A1' },
      tags: [{ outputIndex: 0, sourceAddress: 'A1', name: 'A1', bias: 0, multiplier: 1, calcOrder: 'bm' }],
    }],
    database: { server: 'local-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' },
    log: { level: 'info', maxFiles: 10 },
  };
}

function interfaceStore() {
  return {
    find(id) {
      if (id !== 'device-status') return null;
      return { id, methods: [{
        id: 'read-value', source: 'discovered', member: 'ReadValue',
        inputs: [{ name: 'address', type: 'string', required: true, validation: { pattern: '^[A-Z][0-9]+$' } }], outputs: [],
      }] };
    },
  };
}

function code(operation) {
  assert.throws(operation, (failure) => failure && failure.code === 'JOB_INVALID');
}

const limits = { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 };
assert.deepEqual(
  validateJobConfig(config(), { interfaceStore: interfaceStore(), limits }).methodCalls[0].interfaceId,
  'device-status',
);
code(() => validateJobConfig({ ...config(), profileId: 'legacy' }, { interfaceStore: interfaceStore(), limits }));
code(() => validateJobConfig({ ...config(), dbus: { busType: 'system', destination: 'example.device' } }, { interfaceStore: interfaceStore(), limits }));
code(() => validateJobConfig({ ...config(), methodCalls: [{ ...config().methodCalls[0], interfaceId: 'missing' }] }, { interfaceStore: interfaceStore(), limits }));
code(() => validateJobConfig({ ...config(), methodCalls: [{ ...config().methodCalls[0], inputs: { address: 'bad' } }] }, { interfaceStore: interfaceStore(), limits }));

const lsTagCount = 10001;
const largeLsLikeCall = {
  ...config().methodCalls[0],
  tags: Array.from({ length: lsTagCount }, (_unused, index) => ({ name: `MB${index}`, bias: 0, multiplier: 1 })),
};
assert.equal(validateJobConfig({ ...config(), methodCalls: [largeLsLikeCall] }, {
  interfaceStore: interfaceStore(),
  limits: { maxGeneratedTagsPerCall: 65535, maxBufferedRowsPerCycle: 65535 },
  maxJobJsonBytes: 16 * 1024 * 1024,
}).methodCalls[0].tags.length, lsTagCount);
console.log('Job Interface contract: ok');
