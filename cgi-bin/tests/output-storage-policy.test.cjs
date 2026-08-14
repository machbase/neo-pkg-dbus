'use strict';

const assert = require('node:assert/strict');
const {
  jobNeedsStringValueColumn,
  selectionStorageType,
} = require('../src/output/storage-policy.js');

const method = {
  id: 'read',
  outputs: [
    { name: 'count', type: 'uint16' },
    { name: 'text', type: 'string' },
  ],
};

const interfaceStore = {
  find(id) {
    return id === 'device' ? { id, methods: [method] } : null;
  },
};

assert.equal(
  selectionStorageType({ valueType: 'array', elementType: 'numeric' }, 'string'),
  'numeric',
);
assert.equal(
  selectionStorageType({ valueType: 'array', elementType: 'json' }, 'string'),
  'string',
);
assert.equal(selectionStorageType({ interpretation: 'native' }, 'uint16'), 'numeric');
assert.equal(selectionStorageType({ interpretation: 'native' }, 'string'), 'string');
assert.equal(selectionStorageType({ interpretation: 'native' }, 'boolean'), 'string');

assert.equal(jobNeedsStringValueColumn({
  methodCalls: [{
    interfaceId: 'device', methodId: 'read',
    outputSelections: [{ sourceIndex: 0, interpretation: 'native', tags: [{ name: 'N' }] }],
  }],
}, interfaceStore), false);

assert.equal(jobNeedsStringValueColumn({
  methodCalls: [{
    interfaceId: 'device', methodId: 'read',
    outputSelections: [{ sourceIndex: 1, interpretation: 'native', tags: [{ name: 'S' }] }],
  }],
}, interfaceStore), true);

assert.equal(jobNeedsStringValueColumn({
  methodCalls: [{
    interfaceId: 'device', methodId: 'read',
    tags: [{ name: 'LEGACY' }],
  }],
}, interfaceStore), false, 'legacy tags는 첫 번째 output의 타입을 사용합니다.');

console.log('Output storage policy: ok');
