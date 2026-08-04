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
  if (typeof value.defaultProfileId !== 'string' || !value.defaultProfileId) {
    throw error('SETTINGS_INVALID', 'defaultProfileId가 필요합니다.');
  }
  if (!value.limits || !positiveInteger(value.limits.maxGeneratedTagsPerCall)
    || !positiveInteger(value.limits.maxBufferedRowsPerCycle)) {
    throw error('SETTINGS_INVALID', 'limits 값은 0보다 큰 정수여야 합니다.');
  }
  return {
    schemaVersion: 1,
    defaultProfileId: value.defaultProfileId,
    limits: {
      maxGeneratedTagsPerCall: value.limits.maxGeneratedTagsPerCall,
      maxBufferedRowsPerCycle: value.limits.maxBufferedRowsPerCycle,
    },
  };
}

module.exports = { validateSettings };
