'use strict';

const fs = require('fs');
const { error } = require('./errors.js');
const { validateSettings } = require('./settings-validator.js');

function defaultSettings() {
  return {
    schemaVersion: 1,
    limits: {
      maxGeneratedTagsPerCall: 1000,
      maxBufferedRowsPerCycle: 10000,
    },
    defaults: {
      database: { server: 'localhost' },
    },
    logging: {
      maxFileBytes: 1024 * 1024,
      maxFiles: 3,
      summaryIntervalMs: 60 * 60 * 1000,
    },
    // LS writer tuning is intentionally an internal deployment setting. It
    // is copied into the Go collector policy file but is not exposed in the UI.
    ls: {
      interval: { useTaskCycle: true },
      writer: { queueCapacity: 64, flushMaxRows: 1024, flushIntervalMs: 1000 },
      performance: { enabled: true, jobSampleCount: 1000, writerSummaryIntervalMs: 30000 },
    },
  };
}

function loadSettings(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (readError) {
    if (readError && readError.code === 'ENOENT') return defaultSettings();
    throw error('SETTINGS_INVALID', 'settings 파일을 읽을 수 없습니다.', {
      message: readError.message,
    });
  }
  // 이전 설치본에는 기본값이 없었다. 기존 제한값은 유지하고 Database 기본값만 보충한다.
  const base = defaultSettings();
  const defaults = value.defaults && typeof value.defaults === 'object' && !Array.isArray(value.defaults)
    ? value.defaults : {};
  return validateSettings({
    ...base,
    ...value,
    limits: value.limits || base.limits,
    defaults: {
      ...base.defaults,
      ...defaults,
      database: { ...base.defaults.database, ...(defaults.database || {}) },
    },
    logging: { ...base.logging, ...((value.logging && typeof value.logging === 'object' && !Array.isArray(value.logging)) ? value.logging : {}) },
    ls: {
      ...base.ls,
      ...((value.ls && typeof value.ls === 'object' && !Array.isArray(value.ls)) ? value.ls : {}),
      interval: { ...base.ls.interval, ...((value.ls?.interval && typeof value.ls.interval === 'object' && !Array.isArray(value.ls.interval)) ? value.ls.interval : {}) },
      writer: { ...base.ls.writer, ...((value.ls?.writer && typeof value.ls.writer === 'object' && !Array.isArray(value.ls.writer)) ? value.ls.writer : {}) },
      performance: { ...base.ls.performance, ...((value.ls?.performance && typeof value.ls.performance === 'object' && !Array.isArray(value.ls.performance)) ? value.ls.performance : {}) },
    },
  });
}

module.exports = { loadSettings, defaultSettings };
