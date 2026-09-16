'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings } = require('../src/config/settings-loader.js');
const { SettingsManager } = require('../src/config/settings-manager.js');

function update(manager, patch) {
  return new Promise((resolve, reject) => manager.update(patch, (failure, value) => {
    if (failure) reject(failure); else resolve(value);
  }));
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-settings-default-'));
  const file = path.join(root, 'conf.d', 'settings.json');
  try {
    const initial = loadSettings(file);
    assert.equal(initial.defaults.database.server, 'localhost');
    assert.deepEqual(initial.logging, { maxFileBytes: 1024 * 1024, maxFiles: 3, summaryIntervalMs: 60 * 60 * 1000 });
    assert.deepEqual(initial.ls.performance, { enabled: true, jobSampleCount: 1000, writerSummaryIntervalMs: 30000 });
    assert.equal(fs.existsSync(file), false);

    const manager = new SettingsManager({ cgiRoot: root });
    const saved = await update(manager, {
      limits: { maxGeneratedTagsPerCall: 250, maxBufferedRowsPerCycle: 2000 },
    });
    assert.deepEqual(saved.limits, { maxGeneratedTagsPerCall: 250, maxBufferedRowsPerCycle: 2000 });
    assert.equal(saved.defaults.database.server, 'localhost');
    assert.deepEqual(saved.logging, initial.logging);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved);

    fs.writeFileSync(file, '{"schemaVersion":1,"limits":{"maxGeneratedTagsPerCall":0}}', 'utf8');
    assert.throws(() => loadSettings(file), (failure) => failure.code === 'SETTINGS_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().then(() => console.log('Settings clean-install defaults: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
