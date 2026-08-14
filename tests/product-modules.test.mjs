import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDefaultJobConfig, serializeJobConfig } from '../frontend/src/model.js';
import * as generic from '../products/generic/frontend/model.mjs';
import * as ls from '../products/ls/frontend/model.mjs';

const require = createRequire(import.meta.url);
const { JobManager } = require('../cgi-bin/src/jobs/manager.js');
const genericBackend = require('../products/generic/backend/index.js');
const lsBackend = require('../products/ls/backend/index.js');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const provider = {
  jobMode: 'fixed', interfaceId: 'ls-plc-device', methodId: 'get-device-data',
  outputSelections: [{ id: 'return-data', sourceIndex: 0, interpretation: 'json', selector: '/data', valueType: 'array', elementType: 'numeric', tags: [] }],
  tagGenerator: { kind: 'ls-memory-address-v1' },
};

function lsJobManager() {
  const cgiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-dbus-ls-validation-'));
  fs.mkdirSync(path.join(cgiRoot, 'interfaces.d'), { recursive: true });
  fs.mkdirSync(path.join(cgiRoot, 'product'), { recursive: true });
  fs.copyFileSync(
    path.join(packageRoot, 'products', 'ls', 'interfaces', 'ls-plc-device.json'),
    path.join(cgiRoot, 'interfaces.d', 'ls-plc-device.json'),
  );
  fs.copyFileSync(
    path.join(packageRoot, 'products', 'ls', 'backend', 'index.js'),
    path.join(cgiRoot, 'product', 'index.js'),
  );
  return {
    cgiRoot,
    manager: new JobManager({ cgiRoot, controller: {}, databaseAdapter: {} }),
  };
}

function frontendLsJobConfig() {
  let methodCalls = ls.createInitialMethodCalls(provider);
  methodCalls = ls.appendProductMethodCall(methodCalls, provider);
  const inputRows = [
    { DeviceString: '%MB3', DataCount: 2 },
    { DeviceString: '%MW10', DataCount: 1 },
  ];
  methodCalls = methodCalls.map((call, index) => ({
    ...call,
    inputs: inputRows[index],
    outputSelections: call.outputSelections.map((selection) => ({
      ...selection,
      tags: ls.reconcileProductTags(inputRows[index], [], provider),
    })),
  }));
  return serializeJobConfig(createDefaultJobConfig(provider, {
    name: 'localhost',
    defaultTable: 'TAG',
    defaultValueColumn: 'VALUE',
    defaultStringValueColumn: 'STR_VALUE',
  }, methodCalls));
}

test('generic 제품은 자유 Job과 Interface 관리를 유지한다', () => {
  assert.equal(generic.productTarget, 'generic');
  assert.equal(generic.resolveJobFormMode({ settings: { provider: null } }), 'generic');
  assert.equal(generic.showsInterfaceManagement(), true);
  assert.deepEqual(generic.createInitialMethodCalls(provider), []);
  const fixedCalls = ls.createInitialMethodCalls(provider);
  assert.deepEqual(generic.appendProductMethodCall(fixedCalls, provider), fixedCalls);
  assert.equal(generic.inputLabel('InputValue'), 'InputValue');
  assert.equal(genericBackend.target, 'generic');
});

test('LS 제품은 고정 Call을 깊은 복사하고 새 Call도 독립적으로 추가한다', () => {
  assert.equal(ls.productTarget, 'ls');
  assert.equal(ls.resolveJobFormMode({ settings: { provider }, editing: false }), 'fixed');
  assert.equal(ls.showsInterfaceManagement(), false);
  const first = ls.createInitialMethodCalls(provider);
  first[0].outputSelections[0].tags.push({ name: 'changed' });
  assert.deepEqual(provider.outputSelections[0].tags, []);
  const initial = ls.createInitialMethodCalls(provider);
  const twoCalls = ls.appendProductMethodCall(initial, provider);
  assert.equal(twoCalls.length, 2);
  assert.equal(twoCalls[0], initial[0]);
  assert.notEqual(twoCalls[1].id, twoCalls[0].id);
  assert.deepEqual(twoCalls.map((call) => call.name), ['get-device-data-1', 'get-device-data-2']);
  assert.notEqual(twoCalls[1].outputSelections, twoCalls[0].outputSelections);
  twoCalls[1].outputSelections[0].tags.push({ name: 'MW10' });
  assert.deepEqual(twoCalls[0].outputSelections[0].tags.map((tag) => tag.name), ['MB0']);
  assert.deepEqual(twoCalls[1].outputSelections[0].tags.map((tag) => tag.name), ['MB0', 'MW10']);
  assert.deepEqual(ls.reconcileProductTags({ DataCount: 3, DeviceString: '%MB3' }, [], provider).map((tag) => tag.name), ['MB3', 'MB4', 'MB5']);
  assert.deepEqual(ls.reconcileProductTags({ DataCount: 2, DeviceString: '%AREA.X09' }, [], provider).map((tag) => tag.name), ['AREA.X09', 'AREA.X10']);
  assert.deepEqual(ls.reconcileProductTags({ DataCount: 2, DeviceString: 'MB3' }, [], provider), []);
  assert.equal(ls.inputLabel('data-count'), 'DataCount');
  assert.equal(ls.inputLabel('memory_address'), 'DeviceString');
  assert.equal(lsBackend.target, 'ls');
});

test('LS 새 Call은 기존 ID와 name 양쪽을 피해 읽기 쉬운 suffix를 만든다', () => {
  const calls = [
    { id: 'get-device-data-1', name: 'legacy-call' },
    { id: 'legacy-id', name: 'get-device-data-2' },
  ];
  const appended = ls.appendProductMethodCall(calls, provider);
  assert.equal(appended[2].id, 'get-device-data-3');
  assert.equal(appended[2].name, 'get-device-data-3');
});

test('LS Frontend 다중 Call payload는 실제 InterfaceStore와 product policy 검증을 통과한다', (context) => {
  const { cgiRoot, manager } = lsJobManager();
  context.after(() => fs.rmSync(cgiRoot, { recursive: true, force: true }));

  const config = frontendLsJobConfig();
  const validated = manager.validateConfig(config);

  assert.deepEqual(validated.methodCalls.map((call) => call.name), ['get-device-data-1', 'get-device-data-2']);
  assert.deepEqual(validated.methodCalls.map((call) => call.inputs.DeviceString), ['%MB3', '%MW10']);
});

test('LS JobManager는 두 번째 Call의 고정 규칙 위반을 실제 검증 단계에서 거부한다', (context) => {
  const { cgiRoot, manager } = lsJobManager();
  context.after(() => fs.rmSync(cgiRoot, { recursive: true, force: true }));
  const cases = [
    {
      label: 'Interface',
      reason: /DBus Interface를 찾을 수 없습니다/,
      mutate(call) { call.interfaceId = 'other-interface'; },
    },
    {
      label: 'Method',
      reason: /DBus Interface에서 Method를 찾을 수 없습니다/,
      mutate(call) { call.methodId = 'other-method'; },
    },
    {
      label: 'Output',
      reason: /fixed output mapping/,
      mutate(call) { call.outputSelections[0].selector = '/other'; },
    },
    {
      label: 'DataCount-Tag count',
      reason: /Tag count must match DataCount/,
      mutate(call) { call.inputs.DataCount = 2; },
    },
  ];

  cases.forEach(({ label, reason, mutate }) => {
    const config = frontendLsJobConfig();
    mutate(config.methodCalls[1]);
    assert.throws(() => manager.validateConfig(config), (failure) => {
      assert.equal(failure?.code, 'JOB_INVALID', `${label} 오류 코드는 JOB_INVALID여야 합니다.`);
      assert.match(failure.message, reason, `${label}의 실제 거부 이유를 확인해야 합니다.`);
      return true;
    });
  });
});

test('LS Backend는 모든 Call의 고정 Method와 출력 구조를 검증한다', () => {
  const config = {
    methodCalls: [{
      id: 'get-device-data-1', name: 'GetDeviceData', interfaceId: 'ls-plc-device', methodId: 'get-device-data',
      inputs: { DataCount: 2, DeviceString: '%MB3' },
      outputSelections: [{ id: 'return-data', sourceIndex: 0, interpretation: 'json', selector: '/data', valueType: 'array', elementType: 'numeric', tags: [
        { name: 'MB3', bias: 0, multiplier: 1 }, { name: 'MB4', bias: 0, multiplier: 1 },
      ] }],
    }],
  };
  assert.equal(lsBackend.validateProductConfig(config), config);
  const second = structuredClone(config.methodCalls[0]);
  second.id = 'get-device-data-2';
  second.inputs = { DataCount: 1, DeviceString: '%MW10' };
  second.outputSelections[0].tags = [{ name: 'MW10', bias: 0, multiplier: 1 }];
  const multiple = { ...config, methodCalls: [config.methodCalls[0], second] };
  assert.equal(lsBackend.validateProductConfig(multiple), multiple);
  assert.throws(() => lsBackend.validateProductConfig({ ...config, methodCalls: [] }), /at least one Method Call/);

  const invalidSecond = structuredClone(multiple);
  invalidSecond.methodCalls[1].outputSelections[0].selector = '/other';
  assert.throws(() => lsBackend.validateProductConfig(invalidSecond), /fixed output/);
});
