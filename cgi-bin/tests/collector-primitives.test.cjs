'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildTypedArguments } = require('../src/dbus/arguments.js');
const { signatureFromType, typeFromSignature } = require('../src/dbus/types.js');
const { validateInterface } = require('../src/interfaces/validator.js');
const { decodeOutput, decodeSelection, parseSimplePath, readSimplePath } = require('../src/output/decoder.js');
const { transformValue } = require('../src/tag/transform.js');

function throwsCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error && error.code, code);
    return true;
  });
}

function throwsCodeAndType(operation, code, type) {
  assert.throws(operation, (failure) => {
    assert.equal(failure && failure.code, code);
    assert.equal(failure && failure.details && failure.details.type, type);
    return true;
  });
}

function testTypedArguments() {
  const inputs = [
    ['byte', 255], ['uint16', 65535], ['uint32', 4294967295],
    ['uint64', '18446744073709551615'], ['int16', -32768], ['int32', 2147483647],
    ['int64', '-9223372036854775808'], ['double', 3], ['boolean', true], ['string', 'uint16:7'],
    ['object-path', '/ls/plc/device'], ['signature', 'a{sv}'],
  ].map(([type, value], index) => ({ id: `value${index}`, type, required: true, value }));
  assert.deepEqual(buildTypedArguments(
    inputs.map(({ id, type, required }) => ({ id, type, required })),
    Object.fromEntries(inputs.map(({ id, value }) => [id, value])),
  ), [
    'byte:255', 'uint16:65535', 'uint32:4294967295',
    'uint64:18446744073709551615', 'int16:-32768', 'int32:2147483647',
    'int64:-9223372036854775808', 'double:3', 'bool:true', 'string:uint16:7',
    'objectpath:/ls/plc/device', 'signature:a{sv}',
  ]);

  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'uint16', required: true }], { v: 65536 }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'uint32', required: true }], { v: 1.5 }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'uint64', required: true }], { v: '18446744073709551616' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'boolean', required: true }], { v: 'true' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'object-path', required: true }], { v: '../bad' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'signature', required: true }], { v: 'not a signature!' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'signature', required: true }], { v: 'a{sv' }), 'DBUS_ARGUMENT_INVALID');
  throwsCode(() => buildTypedArguments([{ id: 'v', type: 'unknown', required: true }], { v: 1 }), 'DBUS_ARGUMENT_INVALID');
  throwsCodeAndType(() => buildTypedArguments([{ id: 'v', type: { type: 'array', element: 'string' }, required: true }], { v: ['one'] }), 'DBUS_ARGUMENT_UNSUPPORTED', 'array');
  throwsCodeAndType(() => buildTypedArguments([{ id: 'v', type: 'variant', required: true }], { v: { type: 'string', value: 'one' } }), 'DBUS_ARGUMENT_UNSUPPORTED', 'variant');
  throwsCodeAndType(() => buildTypedArguments([{ id: 'v', type: 'unix-fd', required: true }], { v: 3 }), 'DBUS_ARGUMENT_UNSUPPORTED', 'unix-fd');
}

function testTypedArgumentPattern() {
  const input = { name: 'DeviceString', type: 'string', validation: { pattern: '^%[^%]+[0-9]+$' } };
  assert.deepEqual(buildTypedArguments([input], { DeviceString: '%MB3' }), ['string:%MB3']);
  assert.deepEqual(buildTypedArguments([input], { DeviceString: '%AREA.X09' }), ['string:%AREA.X09']);
  ['%3', 'MB3', '%MB', '%%MB3'].forEach((DeviceString) => {
    throwsCode(() => buildTypedArguments([input], { DeviceString }), 'DBUS_ARGUMENT_INVALID');
  });
}

function testTransformOrder() {
  assert.equal(transformValue(3, { bias: 2, multiplier: 4, transformOrder: ['bias', 'multiplier'] }), 20);
  assert.equal(transformValue(3, { bias: 2, multiplier: 4, transformOrder: ['multiplier', 'bias'] }), 14);
}

function testStandardComplexTypeCanBeStored() {
  const item = validateInterface({
    schemaVersion: 1, id: 'standard-types', origin: 'manual', builtIn: false, busType: 'system',
    destination: 'example.device', objectPath: '/example/device', interface: 'example.device.Standard',
    methods: [{
      id: 'set-properties', source: 'manual', member: 'SetProperties',
      inputs: [{ name: 'properties', type: { type: 'array', element: { type: 'dict-entry', key: 'string', value: 'variant' } } }],
      outputs: [{ name: 'result', type: { type: 'struct', fields: ['boolean', 'string'] } }],
    }],
  });
  assert.deepEqual(item.methods[0].inputs[0].type, { type: 'array', element: { type: 'dict-entry', key: 'string', value: 'variant' } });
  throwsCode(() => validateInterface({
    ...item,
    methods: [{ ...item.methods[0], inputs: [{ name: 'invalidEntry', type: { type: 'dict-entry', key: 'string', value: 'variant' } }] }],
  }), 'DBUS_METHOD_INVALID');
}

function testLsGetDeviceDataAssetSignature() {
  const file = path.resolve(__dirname, '..', '..', 'products', 'ls', 'interfaces', 'ls-plc-device.json');
  const asset = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(asset.origin, 'discovered');
  const validated = validateInterface(asset);
  assert.equal(validated.id, 'ls-plc-device');
  assert.deepEqual(validated.methods, [{
    id: 'get-device-data',
    source: 'discovered',
    member: 'GetDeviceData',
    inputs: [
      { name: 'DataCount', type: 'uint16', validation: { minimum: 1 } },
      { name: 'DeviceString', type: 'string', validation: { pattern: '^%[^%]+[0-9]+$' } },
    ],
    outputs: [{ name: 'Return', type: 'string' }],
  }]);
  assert.deepEqual(buildTypedArguments(validated.methods[0].inputs, {
    DataCount: 3,
    DeviceString: '%MB10',
  }), ['uint16:3', 'string:%MB10']);
}

function testDbusSignatureRoundTrip() {
  const type = typeFromSignature('a{sa(ib)}');
  assert.deepEqual(type, {
    type: 'array', element: {
      type: 'dict-entry', key: 'string', value: {
        type: 'array', element: { type: 'struct', fields: ['int32', 'boolean'] },
      },
    },
  });
  assert.equal(signatureFromType(type), 'a{sa(ib)}');
  assert.equal(typeFromSignature('a{sv'), null);
  assert.equal(typeFromSignature('(is'), null);
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

  assert.deepEqual(decodeSelection([[7, 8]], {
    sourceIndex: 0, path: '', mode: 'each', tags: [{}, {}],
  }), [7, 8]);
  assert.deepEqual(decodeSelection([[7, 8]], {
    sourceIndex: 0, path: '/0', mode: 'single', tags: [{}],
  }), [7]);
  assert.deepEqual(decodeSelection(['{"data":[7,8,9],"rtn":1}'], {
    sourceIndex: 0, interpretation: 'json', path: '/data', mode: 'each', tags: [{}, {}, {}],
  }), [7, 8, 9]);
  assert.deepEqual(decodeSelection(['{"data":[7,8,9],"rtn":1}'], {
    sourceIndex: 0,
    interpretation: 'json',
    selector: '/data',
    valueType: 'array',
    elementType: 'numeric',
    tags: [{}, {}, {}],
  }), [7, 8, 9]);
  assert.deepEqual(decodeSelection(['native string'], {
    sourceIndex: 0, interpretation: 'native', tags: [{}],
  }, 'string'), ['native string']);
  throwsCode(() => decodeSelection(['{"data":["seven"]}'], {
    sourceIndex: 0,
    interpretation: 'json',
    selector: '/data',
    valueType: 'array',
    elementType: 'numeric',
    tags: [{}],
  }), 'OUTPUT_DECODE_FAILED');
  throwsCode(() => decodeSelection([[7]], {
    sourceIndex: 0, path: '', mode: 'each', tags: [{} , {}],
  }), 'OUTPUT_COUNT_MISMATCH');
}

function testTransform() {
  assert.equal(transformValue(3, { bias: 2, multiplier: 4, calcOrder: 'bm' }), 20);
  assert.equal(transformValue(3, { bias: 2, multiplier: 4, calcOrder: 'mb' }), 20);
  assert.equal(transformValue('PLC READY', { bias: 100, multiplier: 100, calcOrder: 'bm' }), 'PLC READY');
  assert.equal(transformValue('Infinity', { bias: 0, multiplier: 1, calcOrder: 'bm' }), 'Infinity');
  const objectValue = { ready: true, count: 2 };
  assert.strictEqual(transformValue(objectValue, {
    bias: 100, multiplier: 100, calcOrder: 'bm',
  }), objectValue);
  assert.equal(transformValue(true, { bias: 100, multiplier: 100, calcOrder: 'bm' }), true);
  assert.equal(transformValue(null, { bias: 100, multiplier: 100, calcOrder: 'bm' }), null);
  throwsCode(() => transformValue(Infinity, { bias: 0, multiplier: 1, calcOrder: 'bm' }), 'TRANSFORM_FAILED');
}

testTypedArguments();
testTypedArgumentPattern();
testTransformOrder();
testLsGetDeviceDataAssetSignature();
  testStandardComplexTypeCanBeStored();
  testDbusSignatureRoundTrip();
testSimplePathAndDecoder();
testTransform();
console.log('Collector primitives: ok');
