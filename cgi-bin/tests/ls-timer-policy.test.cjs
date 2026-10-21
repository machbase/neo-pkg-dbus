'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { jobConfig, setupRoot } = require('./job-fixture.cjs');
const { validateJobConfig } = require('../src/jobs/validator.js');
const { InterfaceStore } = require('../src/interfaces/store.js');
const { SettingsManager } = require('../src/config/settings-manager.js');
const { loadSettings, defaultSettings } = require('../src/config/settings-loader.js');
const { JobIndexRepository, fromDocument } = require('../src/jobs/index-repository.js');
const { JobManager } = require('../src/jobs/manager.js');

test('LS timer policy is read-only and public projection excludes writer/performance settings', () => {
  const root = setupRoot('neo-timer-policy-');
  try {
    fs.mkdirSync(path.join(root, 'product'), { recursive: true });
    fs.writeFileSync(path.join(root, 'product', 'index.js'), "module.exports={target:'ls',minimumIntervalMs:1,validateProductConfig(value){return value;}};");
    const file = path.join(root, 'conf.d', 'settings.json');
    const settings = defaultSettings();
    delete settings.ls.timer;
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.deepEqual(loadSettings(file).ls.timer, { showAbsoluteTimerOption: true, defaultUseAbsoluteTimer: false });
    settings.ls.timer = { showAbsoluteTimerOption: false, defaultUseAbsoluteTimer: true };
    fs.writeFileSync(file, JSON.stringify(settings));
    const manager = new SettingsManager({ cgiRoot: root });
    manager.get((err, result) => {
      assert.ifError(err);
      assert.deepEqual(result.timerPolicy, settings.ls.timer);
      for (const key of ['ls', 'writer', 'performance']) assert.equal(Object.hasOwn(result, key), false);
    });
    manager.update({ timerPolicy: settings.ls.timer }, (err) => assert.equal(err.code, 'SETTINGS_INVALID'));
    settings.ls.timer.defaultUseAbsoluteTimer = 'true';
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.throws(() => loadSettings(file), { code: 'SETTINGS_INVALID' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('LS timer choice survives validation, index and lightweight status; absent legacy field stays false', () => {
  const root = setupRoot('neo-timer-job-');
  try {
    const options = { interfaceStore: new InterfaceStore({ cgiRoot: root }), limits: defaultSettings().limits, allowAbsoluteTimer: true };
    const indexes = new JobIndexRepository({ cgiRoot: root });
    for (const value of [undefined, false, true]) {
      const config = jobConfig();
      if (value !== undefined) config.schedule.useAbsoluteTimer = value;
      const normalized = validateJobConfig(config, options);
      assert.equal(normalized.schedule.useAbsoluteTimer, value === true);
      const index = fromDocument({ ...normalized, name: 'timer-job', revision: 1 });
      indexes.write({ ...normalized, name: 'timer-job', revision: 1 });
      assert.equal(indexes.read('timer-job').useAbsoluteTimer, value === true);
      const restored = JobManager.prototype.configFromIndex.call({}, index, { [index.database.server]: index.database });
      assert.equal(restored.schedule.useAbsoluteTimer, value === true);
    }
    const invalid = jobConfig(); invalid.schedule.useAbsoluteTimer = 1;
    assert.throws(() => validateJobConfig(invalid, options), { code: 'JOB_INVALID' });
    invalid.schedule.useAbsoluteTimer = true;
    assert.throws(() => validateJobConfig(invalid, { ...options, allowAbsoluteTimer: false }), { code: 'JOB_INVALID' });
    const settings=defaultSettings();settings.ls.interval.useTaskCycle=false;settings.ls.timer.defaultUseAbsoluteTimer=true;
    fs.writeFileSync(path.join(root,'conf.d','settings.json'),JSON.stringify(settings));
    const manager=new JobManager({cgiRoot:root,productPolicy:{target:'ls',minimumIntervalMs:1,validationLimits:{},validateProductConfig(value){return value;}}});
    const readOptions={enforceInterval:false,enforceDatabaseProfile:false};
    assert.equal(manager.validateConfig(jobConfig(),readOptions).schedule.useAbsoluteTimer,false);
    assert.equal(manager.validateConfig(jobConfig(),{...readOptions,creating:true}).schedule.useAbsoluteTimer,true);
    assert.equal(manager.validateConfig(jobConfig({schedule:{intervalMs:20,useAbsoluteTimer:false}}),{...readOptions,creating:true}).schedule.useAbsoluteTimer,false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
