'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InterfaceManager } = require('../src/interfaces/manager.js');
const { createJobOperationLock } = require('../src/jobs/operation-lock.js');
const { profileLockKey } = require('../src/config/profile-lock-key.js');

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-interface-'));
  fs.mkdirSync(path.join(value, 'interfaces.d'), { recursive: true });
  fs.mkdirSync(path.join(value, 'conf.d', 'interfaces'), { recursive: true });
  fs.mkdirSync(path.join(value, 'conf.d', 'jobs'), { recursive: true });
  return value;
}

function iface(overrides) {
  return {
    schemaVersion: 1,
    id: 'device-status',
    name: 'Device Status',
    origin: 'manual',
    builtIn: false,
    busType: 'system',
    destination: 'example.device',
    objectPath: '/example/device',
    interface: 'example.device.Status',
    methods: [{
      id: 'read-value', source: 'manual', member: 'ReadValue',
      inputs: [{ name: 'address', type: 'string' }],
      outputs: [{ name: 'value', type: 'uint16' }],
    }],
    ...(overrides || {}),
  };
}

function methodCall(overrides) {
  return {
    id: 'call-a',
    name: 'Read value',
    interfaceId: 'device-status',
    methodId: 'read-value',
    inputs: {},
    tags: [],
    ...(overrides || {}),
  };
}

function call(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (failure, value) => (
    failure ? reject(failure) : resolve(value)
  )));
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (failure) => failure && failure.code === code);
}

async function assertOriginAndReferenceProtection() {
  const cgiRoot = root();
  try {
    const manager = new InterfaceManager({ cgiRoot });
    const discovered = iface({ id: 'legacy-discovered', origin: 'discovered', methods: [{
      id: 'read-value', source: 'discovered', member: 'ReadValue',
      inputs: [{ name: 'address', type: 'string' }], outputs: [{ name: 'value', type: 'uint16' }],
    }] });
    const manual = iface({
      id: 'legacy-manual',
      methods: [{ id: 'manual-read', source: 'manual', member: 'ManualRead', inputs: [], outputs: [] }],
    });
    const mixed = iface({
      id: 'legacy-mixed',
      methods: [
        { id: 'manual-read', source: 'manual', member: 'ManualRead', inputs: [], outputs: [] },
        { id: 'discovered-read', source: 'discovered', member: 'DiscoveredRead', inputs: [], outputs: [] },
      ],
    });
    const { origin: discoveredOrigin, ...legacyDiscovered } = discovered;
    const { origin: manualOrigin, ...legacyManual } = manual;
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'interfaces', 'legacy-discovered.json'), `${JSON.stringify(legacyDiscovered)}\n`);
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'interfaces', 'legacy-manual.json'), `${JSON.stringify(legacyManual)}\n`);
    const { origin: mixedOrigin, ...legacyMixed } = mixed;
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'interfaces', 'legacy-mixed.json'), `${JSON.stringify(legacyMixed)}\n`);
    assert.equal(manager.store.find('legacy-discovered').origin, 'discovered');
    assert.equal(manager.store.find('legacy-manual').origin, 'manual');
    assert.equal(manager.store.find('legacy-mixed').origin, 'manual');
    await rejectsCode(call(manager, 'createInterface', iface({
      id: undefined,
      name: 'New Mixed Interface',
      origin: 'manual',
      methods: mixed.methods,
    })), 'DBUS_INTERFACE_INVALID');

    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'uses-discovered.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'uses-discovered', methodCalls: [methodCall({ interfaceId: 'legacy-discovered' })],
    })}\n`);
    const current = manager.store.find('legacy-discovered');
    const renamed = await call(manager, 'updateInterface', { ...current, name: '새 이름' });
    assert.equal(renamed.name, '새 이름');
    await rejectsCode(call(manager, 'updateInterface', { ...renamed, destination: 'other.device' }), 'DBUS_INTERFACE_IN_USE');
    await rejectsCode(call(manager, 'updateDiscoveredInterface', renamed), 'DBUS_INTERFACE_IN_USE');
    await rejectsCode(call(manager, 'updateMethod', 'legacy-discovered', 'read-value', {
      ...renamed.methods[0], member: 'ChangedDiscoveredMethod',
    }), 'DBUS_INTERFACE_IN_USE');
    const changedManual = await call(manager, 'updateMethod', 'legacy-manual', 'manual-read', {
      ...manual.methods[0], member: 'ManualRead2',
    });
    assert.equal(changedManual.member, 'ManualRead2');
    await rejectsCode(call(manager, 'updateInterface', {
      ...manager.store.find('legacy-mixed'), name: '이름만 바꾼 혼합 레거시',
    }), 'DBUS_INTERFACE_INVALID');
    await rejectsCode(call(manager, 'updateMethod', 'legacy-mixed', 'manual-read', {
      ...mixed.methods[0], member: 'MixedManualRead2',
    }), 'DBUS_INTERFACE_INVALID');
    await rejectsCode(call(manager, 'updateMethod', 'legacy-mixed', 'discovered-read', {
      ...mixed.methods[1], member: 'ChangedDiscoveredRead',
    }), 'DBUS_METHOD_READ_ONLY');
  } finally { fs.rmSync(cgiRoot, { recursive: true, force: true }); }
}

async function assertDiscoverValidatesTemporaryInterfaceAsDiscovered() {
  const cgiRoot = root();
  try {
    const manager = new InterfaceManager({
      cgiRoot,
      dbusFactory: () => ({
        connect() {},
        introspect() { return { interfaces: [{ name: 'example.device.Status', methods: [] }] }; },
        close() {},
      }),
    });
    const discovered = await call(manager, 'discover', {
      busType: 'system', destination: 'example.device', objectPath: '/example/device',
    });
    assert.equal(discovered[0].origin, 'discovered');
    assert.equal(discovered[0].interface, 'example.device.Status');
  } finally { fs.rmSync(cgiRoot, { recursive: true, force: true }); }
}

async function run() {
  const cgiRoot = root();
  try {
    await assertDiscoverValidatesTemporaryInterfaceAsDiscovered();
    const manager = new InterfaceManager({ cgiRoot });
    const created = await call(manager, 'createInterface', iface());
    assert.equal(created.id, 'device-status');
    assert.equal(created.builtIn, false);
    assert.deepEqual(manager.listInterfaces(), [{
      id: 'device-status', name: 'Device Status', busType: 'system', destination: 'example.device',
      objectPath: '/example/device', interface: 'example.device.Status',
      builtIn: false, methodCount: 1,
    }]);
    const generated = await call(manager, 'createInterface', { ...iface(), id: undefined, name: 'Line Device' });
    const generatedAgain = await call(manager, 'createInterface', { ...iface(), id: undefined, name: 'Line Device', interface: 'example.device.Second' });
    assert.equal(generated.id, 'line-device');
    assert.equal(generatedAgain.id, 'line-device-2');
    assert.equal(generated.name, 'Line Device');

    await assertOriginAndReferenceProtection();

    const detail = await call(manager, 'getInterface', 'device-status');
    assert.equal(detail.interface.methods[0].member, 'ReadValue');
    assert.equal('reviewRequired' in detail.interface.methods[0], false);
    assert.equal('reviewRequiredState' in detail, false);
    assert.deepEqual(detail.references, []);

    const builtIn = iface({ id: 'ls-plc-device', builtIn: true });

    const manual = await call(manager, 'createMethod', 'device-status', {
      id: 'reset', source: 'manual', member: 'Reset', inputs: [], outputs: [],
    });
    assert.equal(manual.id, 'reset');
    await rejectsCode(call(manager, 'updateMethod', 'device-status', 'reset', {
      id: 'different-id', source: 'manual', member: 'Changed', inputs: [], outputs: [],
    }), 'DBUS_METHOD_INVALID');
    await rejectsCode(call(manager, 'createMethod', 'device-status', {
      id: 'invalid source', source: 'manual', member: 'Bad', inputs: [], outputs: [],
    }), 'DBUS_METHOD_INVALID');

    fs.writeFileSync(path.join(cgiRoot, 'interfaces.d', 'builtin.json'), `${JSON.stringify(iface({
      id: 'builtin', builtIn: true, methods: [],
    }))}\n`);
    await rejectsCode(call(manager, 'deleteInterface', 'builtin'), 'DBUS_INTERFACE_READ_ONLY');

    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'line-a.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'line-a', methodCalls: [methodCall()],
    })}\n`);
    const referencedDetail = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(referencedDetail.references, [{
      name: 'line-a', documentName: 'line-a', calls: ['call-a'], methodIds: ['read-value'], invalidConfig: false,
    }]);

    // Job validator는 Method Call의 여섯 필드 밖 값을 허용하지 않는다.
    // 참조 분석이 이 문서를 정상 참조로 분류하면, 잘못된 Job이 Method 변경을 피할 수 있다.
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'unknown-call-field.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'unknown-call-field', methodCalls: [methodCall({ unexpected: true })],
    })}\n`);
    const unknownCallField = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(unknownCallField.references.find((reference) => reference.name === 'unknown-call-field'), {
      name: 'unknown-call-field', documentName: 'unknown-call-field', calls: [], methodIds: [], invalidConfig: true,
    });
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'unknown-call-field.json'));

    // Job validator는 한 Job 안에서 Method Call 표시 이름이 중복될 수 없게 한다.
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'duplicate-call-name.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'duplicate-call-name', methodCalls: [
        methodCall({ id: 'call-duplicate-a', name: 'Same call name' }),
        methodCall({ id: 'call-duplicate-b', name: 'Same call name' }),
      ],
    })}\n`);
    const duplicateCallName = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(duplicateCallName.references.find((reference) => reference.name === 'duplicate-call-name'), {
      name: 'duplicate-call-name', documentName: 'duplicate-call-name', calls: [], methodIds: [], invalidConfig: true,
    });
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'duplicate-call-name.json'));

    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'jsh-invalid-call.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'jsh-invalid-call', methodCalls: [{ id: 'call-b', interfaceId: 'device-status' }],
    })}\n`);
    const jshCompatibleDetail = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(jshCompatibleDetail.references, [
      { name: 'jsh-invalid-call', documentName: 'jsh-invalid-call', calls: [], methodIds: [], invalidConfig: true },
      { name: 'line-a', documentName: 'line-a', calls: ['call-a'], methodIds: ['read-value'], invalidConfig: false },
    ]);
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'jsh-invalid-call.json'));

    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'invalid-call.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'invalid-call', methodCalls: [{ id: 'call-b', interfaceId: 'device-status' }],
    })}\n`);
    const detailWithInvalidCall = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(detailWithInvalidCall.references.find((reference) => reference.name === 'invalid-call'), {
      name: 'invalid-call', documentName: 'invalid-call', calls: [], methodIds: [], invalidConfig: true,
    });
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'invalid-call.json'));
    const malformedCalls = [
      methodCall({ id: '' }),
      methodCall({ id: 'call-b', interfaceId: 7 }),
      methodCall({ id: 'call-b', methodId: [] }),
    ];
    for (let index = 0; index < malformedCalls.length; index += 1) {
      const name = `malformed-${index}`;
      fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', `${name}.json`), `${JSON.stringify({
        schemaVersion: 1, name, methodCalls: [malformedCalls[index]],
      })}\n`);
      const malformedDetail = await call(manager, 'getInterface', 'device-status');
      assert.deepEqual(malformedDetail.references.find((reference) => reference.name === name), {
        name, documentName: name, calls: [], methodIds: [], invalidConfig: true,
      });
      fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', `${name}.json`));
    }
    const partialCalls = [
      (() => { const item = methodCall({ id: 'missing-name' }); delete item.name; return item; })(),
      methodCall({ id: 'empty-name', name: ' ' }),
      methodCall({ id: 'wrong-inputs', name: 'Wrong inputs', inputs: [] }),
      methodCall({ id: 'wrong-tags', name: 'Wrong tags', tags: {} }),
    ];
    for (let index = 0; index < partialCalls.length; index += 1) {
      const name = `partial-call-${index}`;
      fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', `${name}.json`), `${JSON.stringify({
        schemaVersion: 1, name, methodCalls: [partialCalls[index]],
      })}\n`);
      const partialDetail = await call(manager, 'getInterface', 'device-status');
      assert.deepEqual(partialDetail.references.find((reference) => reference.name === name), {
        name, documentName: name, calls: [], methodIds: [], invalidConfig: true,
      });
      fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', `${name}.json`));
    }
    const overlongIds = [
      methodCall({ id: 'call-long-interface', interfaceId: 'a'.repeat(101) }),
      methodCall({ id: 'call-long-method', methodId: 'a'.repeat(101) }),
    ];
    for (let index = 0; index < overlongIds.length; index += 1) {
      const name = `overlong-id-${index}`;
      fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', `${name}.json`), `${JSON.stringify({
        schemaVersion: 1, name, methodCalls: [overlongIds[index]],
      })}\n`);
      const overlongDetail = await call(manager, 'getInterface', 'device-status');
      assert.deepEqual(overlongDetail.references.find((reference) => reference.name === name), {
        name, documentName: name, calls: [], methodIds: [], invalidConfig: true,
      });
      fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', `${name}.json`));
    }
    for (const invalidName of ['Bad-Name', 'a'.repeat(101)]) {
      fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', `${invalidName}.json`), `${JSON.stringify({
        schemaVersion: 1, name: invalidName, methodCalls: [methodCall({ id: 'call-name' })],
      })}\n`);
      const invalidNameDetail = await call(manager, 'getInterface', 'device-status');
      assert.deepEqual(invalidNameDetail.references.find((reference) => reference.name === invalidName), {
        name: invalidName, documentName: invalidName, calls: [], methodIds: [], invalidConfig: true,
      });
      fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', `${invalidName}.json`));
    }
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'wrong-document-name.json'), `${JSON.stringify({
      schemaVersion: 1, name: 42, methodCalls: [],
    })}\n`);
    const wrongDocumentName = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(wrongDocumentName.references.find((reference) => reference.name === 'wrong-document-name'), {
      name: 'wrong-document-name', documentName: null, calls: [], methodIds: [], invalidConfig: true,
    });
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'wrong-document-name.json'));
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'empty-calls.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'empty-calls', methodCalls: [],
    })}\n`);
    const emptyCalls = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(emptyCalls.references.find((reference) => reference.name === 'empty-calls'), {
      name: 'empty-calls', documentName: 'empty-calls', calls: [], methodIds: [], invalidConfig: true,
    });
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'empty-calls.json'));
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'wrong-schema.json'), `${JSON.stringify({
      schemaVersion: 2, name: 'wrong-schema', methodCalls: [methodCall({ id: 'call-c' })],
    })}\n`);
    const wrongSchema = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(wrongSchema.references.find((reference) => reference.name === 'wrong-schema'), {
      name: 'wrong-schema', documentName: 'wrong-schema', calls: [], methodIds: [], invalidConfig: true,
    });
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'wrong-schema.json'));

    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'broken.json'), '{not-json}\n');
    const detailWithBrokenReference = await call(manager, 'getInterface', 'device-status');
    assert.deepEqual(detailWithBrokenReference.references.find((reference) => reference.name === 'broken'), {
      name: 'broken', documentName: null, calls: [], methodIds: [], invalidConfig: true,
    });
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'broken.json'));
    await rejectsCode(call(manager, 'updateMethod', 'device-status', 'reset', {
      id: 'reset', source: 'manual', member: 'ResetAgain', inputs: [], outputs: [],
    }), 'DBUS_INTERFACE_IN_USE');
    await rejectsCode(call(manager, 'createMethod', 'device-status', {
      id: 'new-method', source: 'manual', member: 'NewMethod', inputs: [], outputs: [],
    }), 'DBUS_INTERFACE_IN_USE');
    fs.writeFileSync(path.join(cgiRoot, 'conf.d', 'jobs', 'invalid-for-create.json'), `${JSON.stringify({
      schemaVersion: 1, name: 'invalid-for-create', methodCalls: [methodCall({ id: 'missing-tags', tags: {} })],
    })}\n`);
    await rejectsCode(call(manager, 'createMethod', 'device-status', {
      id: 'blocked-method', source: 'manual', member: 'BlockedMethod', inputs: [], outputs: [],
    }), 'DBUS_INTERFACE_IN_USE');
    fs.unlinkSync(path.join(cgiRoot, 'conf.d', 'jobs', 'invalid-for-create.json'));
    await rejectsCode(call(manager, 'deleteMethod', 'device-status', 'read-value'), 'DBUS_INTERFACE_IN_USE');
    await rejectsCode(call(manager, 'updateInterface', iface({ interface: 'example.device.Changed' })), 'DBUS_INTERFACE_IN_USE');

    const readers = createJobOperationLock({ directory: path.join(cgiRoot, 'conf.d', '.interface-mutation-readers') });
    const reader = readers.acquire(`${profileLockKey('device-status')}--line-a`);
    await rejectsCode(call(manager, 'deleteInterface', 'device-status'), 'JOB_CONFLICT');
    reader.release();

    const discovery = iface({ methods: [{
      id: 'read-value', source: 'discovered', member: 'ReadChanged', inputs: [], outputs: [],
    }] });
    await rejectsCode(call(manager, 'updateDiscoveredInterface', discovery), 'DBUS_INTERFACE_INVALID');
    const mutation = manager.mutationLock.acquire(profileLockKey('device-status'));
    await rejectsCode(call(manager, 'updateDiscoveredInterface', discovery), 'JOB_CONFLICT');
    mutation.release();

    const freshRoot = root();
    try {
      const fresh = new InterfaceManager({ cgiRoot: freshRoot });
      await call(fresh, 'createInterface', iface({ methods: [{
        id: 'manual-value', source: 'manual', member: 'Manual', inputs: [], outputs: [],
      }] }));
      await rejectsCode(call(fresh, 'updateDiscoveredInterface', iface({ methods: [{
        id: 'discovered-value', source: 'discovered', member: 'Discovered', inputs: [], outputs: [],
      }] })), 'DBUS_INTERFACE_INVALID');
      assert.deepEqual(fresh.store.find('device-status').methods.map((item) => item.id), ['manual-value']);
    } finally { fs.rmSync(freshRoot, { recursive: true, force: true }); }

    const collisionRoot = root();
    try {
      const collision = new InterfaceManager({ cgiRoot: collisionRoot });
      await call(collision, 'createInterface', iface({ methods: [{
        id: 'same-id', source: 'manual', member: 'ManualWins', inputs: [], outputs: [],
      }] }));
      await rejectsCode(call(collision, 'updateDiscoveredInterface', iface({ methods: [{
        id: 'same-id', source: 'discovered', member: 'DiscoveredLoses', inputs: [], outputs: [],
      }] })), 'DBUS_INTERFACE_INVALID');
      assert.deepEqual(collision.store.find('device-status').methods, [{
        id: 'same-id', source: 'manual', member: 'ManualWins', inputs: [], outputs: [],
      }]);
    } finally { fs.rmSync(collisionRoot, { recursive: true, force: true }); }

    const parsed = manager.parseIntrospection({ interfaces: [{
      name: 'example.device.Status', methods: [{ name: 'Read', args: [
        { name: 'address', type: 's', direction: 'in' }, { name: 'value', type: 'q', direction: 'out' },
      ] }],
    }, {
      name: 'org.freedesktop.DBus.Properties', methods: [{ name: 'GetAll', args: [
        { name: 'interfaceName', type: 's', direction: 'in' }, { name: 'properties', type: 'a{sv}', direction: 'out' },
      ] }],
    }] }, {
      busType: 'system', destination: 'example.device', objectPath: '/example/device',
    });
    assert.deepEqual(parsed[0], {
      schemaVersion: 1, id: 'example-device-status', name: 'example.device.Status', origin: 'discovered', builtIn: false,
      busType: 'system', destination: 'example.device', objectPath: '/example/device', interface: 'example.device.Status',
      methods: [{ id: 'read', source: 'discovered', member: 'Read', inputs: [{ name: 'address', type: 'string' }], outputs: [{ name: 'value', type: 'uint16' }] }],
    });
    assert.deepEqual(parsed[1].methods[0].outputs, [{ name: 'properties', type: { type: 'array', element: { type: 'dict-entry', key: 'string', value: 'variant' } } }]);
    const noArgs = manager.parseIntrospection({ interfaces: [{ name: 'example.device.Empty', methods: [{ name: 'Ping', args: [] }] }] }, {
      busType: 'system', destination: 'example.device', objectPath: '/example/device',
    });
    assert.deepEqual(noArgs[0].methods, [{ id: 'ping', source: 'discovered', member: 'Ping', inputs: [], outputs: [] }]);
    const gojaFields = manager.parseIntrospection({ Interfaces: [{ Name: 'example.device.Goja', Methods: [{ Name: 'Read', Args: [
      { Name: 'value', Type: 'q', Direction: 'out' },
    ] }] }] }, { busType: 'system', destination: 'example.device', objectPath: '/example/device' });
    assert.deepEqual(gojaFields[0].methods[0].outputs, [{ name: 'value', type: 'uint16' }]);
  } finally { fs.rmSync(cgiRoot, { recursive: true, force: true }); }
}

run().then(() => console.log('DBus Interface/Method manager: ok'));
