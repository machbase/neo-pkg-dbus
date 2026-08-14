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
  });
}

module.exports = { loadSettings, defaultSettings };
