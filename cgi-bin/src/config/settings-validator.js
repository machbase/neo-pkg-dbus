'use strict';

const { error } = require('./errors.js');

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error('SETTINGS_INVALID', 'settings는 JSON 객체여야 합니다.');
  }
  if (value.schemaVersion !== 1) {
    throw error('SETTINGS_INVALID', 'settings schemaVersion은 1이어야 합니다.');
  }
  if (!value.limits || !positiveInteger(value.limits.maxGeneratedTagsPerCall)
    || !positiveInteger(value.limits.maxBufferedRowsPerCycle)) {
    throw error('SETTINGS_INVALID', 'limits 값은 0보다 큰 정수여야 합니다.');
  }
  const defaults = value.defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
    || !defaults.database || typeof defaults.database !== 'object' || Array.isArray(defaults.database)
    || typeof defaults.database.server !== 'string' || !defaults.database.server) {
    throw error('SETTINGS_INVALID', '기본 Database 설정이 잘못되었습니다.');
  }
  return {
    schemaVersion: 1,
    limits: {
      maxGeneratedTagsPerCall: value.limits.maxGeneratedTagsPerCall,
      maxBufferedRowsPerCycle: value.limits.maxBufferedRowsPerCycle,
    },
    defaults: {
      database: { server: defaults.database.server },
    },
  };
}

module.exports = { validateSettings };
