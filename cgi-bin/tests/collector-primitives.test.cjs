'use strict';

const assert = require('node:assert/strict');

const { buildTypedArguments } = require('../src/dbus/arguments.js');
const { decodeOutput, parseSimplePath, readSimplePath } = require('../src/output/decoder.js');
const { generateLsTags } = require('../src/tag/ls.js');
const { transformValue } = require('../src/tag/transform.js');

function throwsCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function testTypedArguments() {
  const inputs = [
    ['byte', 255], ['uint8', 0], ['uint16', 65535], ['uint32', 4294967295],
    ['uint64', '18446744073709551615'], ['int16', -32768], ['int32', 2147483647],
    ['int64', '-9223372036854775808'], ['float32', 1.25], ['float64', -2.5],
    ['double', 3], ['bool', true], ['string', 'hello:world'],
    ['objectpath', '/ls/plc/device'], ['path', '/tmp/plc'], ['signature', 'a{sv}'],
  ].map(([type, value], index) => ({ id: `value${index}`, type, required: true, value }));
  assert.deepEqual(buildTypedArguments(
    inputs.map(({ id, type, required }) => ({ id, type, required })),
    Object.fromEntries(inputs.map(({ id, value }) => [id, value])),
  ), [
    'byte:255', 'uint8:0', 'uint16:65535', 'uint32:4294967295',
    'uint64:18446744073709551615', 'int16:-32768', 'int32:2147483647',
    'int64:-9223372036854775808', 'float32:1.25', 'float64:-2.5',
    'double:3', 'bool:true', 'string:hello:world', 'objectpath:/ls/plc/device',
    'path:/tmp/plc', 'signature:a{sv}',
  ]);

  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'uint16', required: true }], { v: 65536 }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'uint32', required: true }], { v: 1.5 }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'uint64', required: true }], { v: '18446744073709551616' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'bool', required: true }], { v: 'true' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'objectpath', required: true }], { v: '../bad' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'signature', required: true }], { v: 'not a signature!' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'signature', required: true }], { v: 'a{sv' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'unknown', required: true }], { v: 1 }), 'DBUS_ARGUMENT_INVALID');
}

function testSimplePathAndDecoder() {
  assert.deepEqual(parseSimplePath('payload.items[0].value'), ['payload', 'items', 0, 'value']);
  const source = { payload: { items: [{ value: 7 }] }, 'data-count': 1 };
  assert.equal(readSimplePath(source, 'payload.items[0].value'), 7);
  assert.equal(readSimplePath(source, 'data-count'), 1);
  throwsCode(() => parseSimplePath('payload[process.exit()]'), 'OUTPUT_DECODE_FAILED');
  throwsCode(() => parseSimplePath('__proto__.polluted'), 'OUTPUT_DECODE_FAILED');
  throwsCode(() => readSimplePath(source, 'payload.items[1].value'), 'OUTPUT_DECODE_FAILED');

  const decoded = decodeOutput(['{"rtn":1,"data-count":2,"data":[10,20]}'], {
    decoder: 'json', shape: 'array', path: 'data',
    success: { path: 'rtn', operator: 'equals', value: 1 },
    returnedCountPath: 'data-count', expectedCount: { source: 'input', inputId: 'dataCount' },
  }, { dataCount: 2 }, 2);
  assert.deepEqual(decoded.values, [10, 20]);
  assert.equal(decoded.returnedCount, 2);
  assert.equal(decoded.body.rtn, 1);

  assert.deepEqual(decodeOutput([42], { decoder: 'raw', shape: 'scalar' }, {}, 1).values, [42]);
  assert.deepEqual(decodeOutput([[1, 2]], { decoder: 'raw', shape: 'array' }, {}, 2).values, [1, 2]);
  assert.deepEqual(decodeOutput([{ a: 1 }], { decoder: 'raw', shape: 'object' }, {}, 1).values, [{ a: 1 }]);
  assert.deepEqual(decodeOutput([7], { decoder: 'raw', shape: 'scalar' }, {}).values, [7]);
  assert.deepEqual(decodeOutput([[1, 2]], { decoder: 'raw', shape: 'array' }, {}).values, [1, 2]);
  throwsCode(() => decodeOutput([[1, 2]], { decoder: 'raw', shape: 'array' }, {}, 1), 'OUTPUT_COUNT_MISMATCH');
  throwsCode(() => decodeOutput(['not json'], { decoder: 'json', shape: 'array' }, {}, 0), 'OUTPUT_DECODE_FAILED');
  throwsCode(() => decodeOutput(['{"rtn":0,"data-count":1,"data":[1]}'], {
    decoder: 'json', shape: 'array', path: 'data',
    success: { path: 'rtn', operator: 'equals', value: 1 },
  }, {}, 1), 'DBUS_CALL_FAILED');
  throwsCode(() => decodeOutput(['{"rtn":1,"data-count":1,"data":[1]}'], {
    decoder: 'json', shape: 'array', path: 'data', returnedCountPath: 'data-count',
    expectedCount: { source: 'input', inputId: 'dataCount' },
  }, { dataCount: 2 }, 2), 'OUTPUT_COUNT_MISMATCH');
  throwsCode(() => decodeOutput(['{"data":{"a":1}}'], {
    decoder: 'json', shape: 'array', path: 'data',
  }, {}, 1), 'OUTPUT_DECODE_FAILED');
}

function testLsTagsAndTransform() {
  assert.deepEqual(generateLsTags('%MB003', 3, 10), [
    { outputIndex: 0, sourceAddress: '%MB003', name: '%MB003', bias: 0, multiplier: 1, calcOrder: 'bm' },
    { outputIndex: 1, sourceAddress: '%MB004', name: '%MB004', bias: 0, multiplier: 1, calcOrder: 'bm' },
    { outputIndex: 2, sourceAddress: '%MB005', name: '%MB005', bias: 0, multiplier: 1, calcOrder: 'bm' },
  ]);
  throwsCode(() => generateLsTags('%MB', 1, 10), 'TAG_GENERATION_FAILED');
  throwsCode(() => generateLsTags('%MB3', 0, 10), 'TAG_GENERATION_FAILED');
  throwsCode(() => generateLsTags('%MB3', 11, 10), 'TAG_GENERATION_FAILED');

  assert.equal(transformValue(3, { bias: 2, multiplier: 4, calcOrder: 'bm' }), 20);
  assert.equal(transformValue(3, { bias: 2, multiplier: 4, calcOrder: 'mb' }), 14);
  assert.equal(transformValue('PLC READY', { bias: 100, multiplier: 100, calcOrder: 'bm' }), 'PLC READY');
  assert.equal(transformValue('Infinity', { bias: 0, multiplier: 1, calcOrder: 'bm' }), 'Infinity');
  assert.equal(transformValue({ ready: true, count: 2 }, {
    bias: 100, multiplier: 100, calcOrder: 'bm',
  }), '{"ready":true,"count":2}');
  throwsCode(() => transformValue(Infinity, { bias: 0, multiplier: 1, calcOrder: 'bm' }), 'TRANSFORM_FAILED');
}

testTypedArguments();
testSimplePathAndDecoder();
testLsTagsAndTransform();
console.log('Collector primitives: ok');
