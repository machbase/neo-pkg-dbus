'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE_ROOT = path.resolve(__dirname, '..');

function methodCall(overrides) {
  return {
    id: 'read-plc-data-1',
    name: 'Read PLC Data - Call 1',
    methodId: 'get-device-data',
    inputs: { dataCount: 2, memoryAddress: '%MB3' },
    tags: [
      { outputIndex: 0, sourceAddress: '%MB3', name: '%MB3', bias: 0, multiplier: 1, calcOrder: 'bm' },
      { outputIndex: 1, sourceAddress: '%MB4', name: '%MB4', bias: 0, multiplier: 1, calcOrder: 'bm' },
    ],
    ...(overrides || {}),
  };
}

function jobConfig(overrides) {
  const base = {
    schemaVersion: 1,
    profileId: 'ls-electric-plc',
    dbus: { busType: 'system', destination: 'ls.plc' },
    schedule: { intervalMs: 1000 },
    retry: { initialDelayMs: 5000, maximumDelayMs: 30000, multiplier: 2 },
    execution: { savePolicy: 'perMethod', onMethodError: 'stop' },
    methodCalls: [methodCall()],
    database: {
      server: 'local-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE',
    },
    log: { level: 'info', maxFiles: 10 },
  };
  return { ...base, ...(overrides || {}) };
}

function setupRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'neo-dbus-job-'));
  fs.mkdirSync(path.join(root, 'profiles.d'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conf.d', 'jobs'), { recursive: true });
  fs.copyFileSync(
    path.join(SOURCE_ROOT, 'profiles.d', 'ls-electric-plc.json'),
    path.join(root, 'profiles.d', 'ls-electric-plc.json'),
  );
  fs.copyFileSync(
    path.join(SOURCE_ROOT, 'conf.d', 'settings.json'),
    path.join(root, 'conf.d', 'settings.json'),
  );
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function call(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

async function rejectsCode(operation, code) {
  await require('node:assert/strict').rejects(operation, (error) => {
    require('node:assert/strict').equal(error && error.code, code);
    return true;
  });
}

module.exports = { SOURCE_ROOT, call, jobConfig, methodCall, rejectsCode, setupRoot, writeJson };
