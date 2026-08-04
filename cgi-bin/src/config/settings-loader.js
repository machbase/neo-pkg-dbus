'use strict';

const fs = require('fs');
const { error } = require('./errors.js');
const { validateSettings } = require('./settings-validator.js');

function loadSettings(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (readError) {
    throw error('SETTINGS_INVALID', 'settings 파일을 읽을 수 없습니다.', {
      message: readError.message,
    });
  }
  return validateSettings(value);
}

module.exports = { loadSettings };
