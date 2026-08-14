'use strict';

const { error } = require('../config/errors.js');

function invalid(reason) {
  throw error('TRANSFORM_FAILED', reason);
}

function transformValue(value, tag) {
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value) || !tag || !Number.isFinite(tag.bias) || !Number.isFinite(tag.multiplier)) {
    invalid('Transform 입력은 유한한 숫자여야 합니다.');
  }
  const order = tag.transformOrder || ['bias', 'multiplier'];
  if (!Array.isArray(order) || order.length !== 2 || new Set(order).size !== 2
    || !order.includes('bias') || !order.includes('multiplier')) {
    invalid('Transform 순서가 잘못되었습니다.');
  }
  const result = order.reduce((current, operation) => (operation === 'bias'
    ? current + tag.bias
    : current * tag.multiplier), value);
  if (!Number.isFinite(result)) invalid('Transform 결과가 유한한 숫자가 아닙니다.');
  return result;
}

module.exports = { transformValue };
