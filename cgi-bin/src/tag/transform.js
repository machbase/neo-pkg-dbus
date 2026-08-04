'use strict';

const { error } = require('../config/errors.js');

function invalid(reason) {
  throw error('TRANSFORM_FAILED', reason);
}

function transformValue(value, tag) {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_) { invalid('객체 output을 JSON 문자열로 바꿀 수 없습니다.'); }
  }
  if (typeof value !== 'number') invalid('숫자 또는 문자열 output만 저장할 수 있습니다.');
  if (!Number.isFinite(value) || !tag || !Number.isFinite(tag.bias) || !Number.isFinite(tag.multiplier)) {
    invalid('Transform 입력은 유한한 숫자여야 합니다.');
  }
  let result;
  if (tag.calcOrder === 'bm') result = (value + tag.bias) * tag.multiplier;
  else if (tag.calcOrder === 'mb') result = value * tag.multiplier + tag.bias;
  else invalid('Transform calcOrder는 bm 또는 mb여야 합니다.');
  if (!Number.isFinite(result)) invalid('Transform 결과가 유한한 숫자가 아닙니다.');
  return result;
}

module.exports = { transformValue };
