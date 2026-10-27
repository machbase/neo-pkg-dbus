'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultSettings, loadSettings } = require('../src/config/settings-loader.js');
const { validateSettings } = require('../src/config/settings-validator.js');
const { refreshLsPolicy } = require('../src/collector/ls-runtime.js');

test('service startup refreshes policy without a Database profile and preserves secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-scheduler-first-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'conf.d'));
  const secret = path.join(root, 'conf.d', 'go-collector-secrets.json');
  fs.writeFileSync(secret, '{"schemaVersion":1,"servers":{}}', { mode: 0o600 });
  refreshLsPolicy(root);
  const snapshot = path.join(root, 'conf.d', 'go-collector.json');
  assert.equal(JSON.parse(fs.readFileSync(snapshot)).scheduler.mode, 'conditional');
  const settings = defaultSettings(); settings.ls.scheduler.mode = 'off';
  fs.writeFileSync(path.join(root, 'conf.d', 'settings.json'), JSON.stringify(settings));
  refreshLsPolicy(root);
  assert.equal(JSON.parse(fs.readFileSync(snapshot)).scheduler.mode, 'off');
  assert.equal(fs.readFileSync(secret, 'utf8'), '{"schemaVersion":1,"servers":{}}');
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
});

test('scheduler defaults, partial merge, invalid types and range audit preservation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const settings = defaultSettings();
  assert.deepEqual(settings.ls.scheduler, { mode: 'conditional', fifoPriority: 50, nice: -10, gomaxprocs: 0 });
  settings.ls.scheduler = { mode: 'off' };
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.deepEqual(loadSettings(file).ls.scheduler, { mode: 'off', fifoPriority: 50, nice: -10, gomaxprocs: 0 });
  for (const invalid of [null, [], 'force', { mode: 'typo' }, { nice: 1.5 }, { nice: '-10' }]) {
    settings.ls.scheduler = invalid;
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.throws(() => loadSettings(file), { code: 'SETTINGS_INVALID' });
  }
  settings.ls.scheduler = { mode: 'force', fifoPriority: 100, nice: -21, gomaxprocs: 65 };
  assert.deepEqual(validateSettings(settings).ls.scheduler, settings.ls.scheduler);
});
