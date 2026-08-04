'use strict';

const { error } = require('../config/errors.js');

const INTEGER_LIMITS = {
  byte: [0n, 255n],
  uint8: [0n, 255n],
  uint16: [0n, 65535n],
  uint32: [0n, 4294967295n],
  uint64: [0n, 18446744073709551615n],
  int16: [-32768n, 32767n],
  int32: [-2147483648n, 2147483647n],
  int64: [-9223372036854775808n, 9223372036854775807n],
};
const FLOAT_TYPES = new Set(['float32', 'float64', 'double']);
const STRING_TYPES = new Set(['string', 'objectpath', 'path', 'signature']);
const OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;
const BASIC_SIGNATURE_TYPES = new Set('ybnqiuxthdsoghv'.split(''));

function invalid(input, reason) {
  throw error('DBUS_ARGUMENT_INVALID', reason, { inputId: input && input.id, type: input && input.type });
}

function integerText(input, value) {
  let integer;
  try {
    if (typeof value === 'bigint') integer = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) integer = BigInt(value);
    else if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value)) integer = BigInt(value);
    else invalid(input, `input ${input.id} 값은 정확한 정수여야 합니다.`);
  } catch (_) {
    invalid(input, `input ${input.id} 값은 정확한 정수여야 합니다.`);
  }
  const limits = INTEGER_LIMITS[input.type];
  if (integer < limits[0] || integer > limits[1]) {
    invalid(input, `input ${input.id} 값이 ${input.type} 범위를 벗어났습니다.`);
  }
  return integer.toString();
}

function parseSignatureType(value, offset, depth) {
  if (depth > 32 || offset >= value.length) return -1;
  const type = value[offset];
  if (BASIC_SIGNATURE_TYPES.has(type)) return offset + 1;
  if (type === 'a') {
    if (value[offset + 1] === '{') {
      const key = value[offset + 2];
      if (!BASIC_SIGNATURE_TYPES.has(key) || key === 'v') return -1;
      const afterValue = parseSignatureType(value, offset + 3, depth + 1);
      return afterValue >= 0 && value[afterValue] === '}' ? afterValue + 1 : -1;
    }
    return parseSignatureType(value, offset + 1, depth + 1);
  }
  if (type === '(') {
    let cursor = offset + 1;
    const first = cursor;
    while (cursor < value.length && value[cursor] !== ')') {
      cursor = parseSignatureType(value, cursor, depth + 1);
      if (cursor < 0) return -1;
    }
    return cursor > first && value[cursor] === ')' ? cursor + 1 : -1;
  }
  return -1;
}

function validSignature(value) {
  if (typeof value !== 'string' || value.length > 255) return false;
  let offset = 0;
  while (offset < value.length) {
    offset = parseSignatureType(value, offset, 0);
    if (offset < 0) return false;
  }
  return true;
}

function typedValue(input, value) {
  if (!input || typeof input.id !== 'string' || typeof input.type !== 'string') {
    invalid(input, 'DBus input 정의가 잘못되었습니다.');
  }
  if (Object.prototype.hasOwnProperty.call(INTEGER_LIMITS, input.type)) return integerText(input, value);
  if (FLOAT_TYPES.has(input.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(input, `input ${input.id} 값은 유한한 숫자여야 합니다.`);
    return String(value);
  }
  if (input.type === 'bool') {
    if (typeof value !== 'boolean') invalid(input, `input ${input.id} 값은 boolean이어야 합니다.`);
    return value ? 'true' : 'false';
  }
  if (STRING_TYPES.has(input.type)) {
    if (typeof value !== 'string') invalid(input, `input ${input.id} 값은 문자열이어야 합니다.`);
    if (input.type === 'objectpath' && !OBJECT_PATH.test(value)) invalid(input, 'DBus object path 형식이 잘못되었습니다.');
    if (input.type === 'path' && (value[0] !== '/' || value.includes('\0'))) invalid(input, 'path는 NUL이 없는 절대 경로여야 합니다.');
    if (input.type === 'signature' && !validSignature(value)) {
      invalid(input, 'DBus signature 형식이 잘못되었습니다.');
    }
    return value;
  }
  invalid(input, `지원하지 않는 DBus type입니다: ${input.type}`);
}

function buildTypedArguments(inputs, values) {
  if (!Array.isArray(inputs) || !values || typeof values !== 'object' || Array.isArray(values)) {
    invalid(null, 'DBus inputs와 values 형식이 잘못되었습니다.');
  }
  return inputs.map((input) => {
    if (!Object.prototype.hasOwnProperty.call(values, input.id) || values[input.id] === null || values[input.id] === undefined) {
      invalid(input, `input ${input.id} 값이 없습니다.`);
    }
    return `${input.type}:${typedValue(input, values[input.id])}`;
  });
}

module.exports = { buildTypedArguments, typedValue, validSignature };
