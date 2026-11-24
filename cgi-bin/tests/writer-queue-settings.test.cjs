'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultSettings, loadSettings } = require('../src/config/settings-loader.js');
const { validateSettings } = require('../src/config/settings-validator.js');
const { refreshLsPolicy } = require('../src/collector/ls-runtime.js');

const MAX_QUEUE_CAPACITY = 2147483647;

test('writer queue accepts up to INT32_MAX batches and keeps the clean-install default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-writer-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'conf.d'));
  const settings = defaultSettings();
  assert.equal(settings.ls.writer.queueCapacity, 512);
  const file = path.join(root, 'conf.d/settings.json');
  for (const capacity of [1, 512, 1024, 1025, 2048, 4096, 4097, 65536, 1000000, MAX_QUEUE_CAPACITY]) {
    settings.ls.writer.queueCapacity = capacity;
    assert.equal(validateSettings(settings).ls.writer.queueCapacity, capacity);
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.equal(loadSettings(file).ls.writer.queueCapacity, capacity);
    refreshLsPolicy(root);
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'conf.d/go-collector.json')));
    assert.equal(policy.writer.queueCapacity, capacity);
    assert.equal(policy.writer.flushIntervalMs, 1000);
    assert.deepEqual(policy.scheduler, settings.ls.scheduler);
  }
});

test('invalid queue settings fail before replacing a valid INT32_MAX-batch snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-writer-queue-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'conf.d'));
  const settings = defaultSettings();
  settings.ls.writer.queueCapacity = MAX_QUEUE_CAPACITY;
  const file = path.join(root, 'conf.d/settings.json');
  const snapshot = path.join(root, 'conf.d/go-collector.json');
  fs.writeFileSync(file, JSON.stringify(settings));
  refreshLsPolicy(root);
  const previous = fs.readFileSync(snapshot, 'utf8');
  for (const value of [0, -1, MAX_QUEUE_CAPACITY + 1, Number.MAX_SAFE_INTEGER, 1.5, '4096', null, true]) {
    settings.ls.writer.queueCapacity = value;
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.throws(() => refreshLsPolicy(root), { code: 'SETTINGS_INVALID' });
    assert.equal(fs.readFileSync(snapshot, 'utf8'), previous);
  }
});
