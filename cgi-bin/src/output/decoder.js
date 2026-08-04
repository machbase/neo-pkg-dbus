'use strict';

const { error } = require('../config/errors.js');

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function failure(code, reason, details) {
  throw error(code, reason, details);
}

function parseSimplePath(path) {
  if (typeof path !== 'string' || !path) failure('OUTPUT_DECODE_FAILED', 'output path가 비어 있습니다.');
  const tokens = [];
  let offset = 0;
  while (offset < path.length) {
    const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(offset));
    if (!keyMatch || !SAFE_KEY.test(keyMatch[0]) || BLOCKED_KEYS.has(keyMatch[0])) {
      failure('OUTPUT_DECODE_FAILED', 'output path는 dot과 숫자 bracket만 사용할 수 있습니다.', { path });
    }
    tokens.push(keyMatch[0]);
    offset += keyMatch[0].length;
    while (path[offset] === '[') {
      const indexMatch = /^\[(\d+)\]/.exec(path.slice(offset));
      if (!indexMatch) failure('OUTPUT_DECODE_FAILED', 'output bracket에는 0 이상의 index만 사용할 수 있습니다.', { path });
      tokens.push(Number(indexMatch[1]));
      offset += indexMatch[0].length;
    }
    if (offset === path.length) break;
    if (path[offset] !== '.') failure('OUTPUT_DECODE_FAILED', 'output path 형식이 잘못되었습니다.', { path });
    offset += 1;
    if (offset === path.length) failure('OUTPUT_DECODE_FAILED', 'output path 형식이 잘못되었습니다.', { path });
  }
  return tokens;
}

function readSimplePath(source, path) {
  return parseSimplePath(path).reduce((value, token) => {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(Object(value), token)) {
      failure('OUTPUT_DECODE_FAILED', 'output path에서 값을 찾을 수 없습니다.', { path });
    }
    return value[token];
  }, source);
}

function unwrapBody(body) {
  if (!Array.isArray(body)) failure('OUTPUT_DECODE_FAILED', 'DBus body는 배열이어야 합니다.');
  return body.length === 1 ? body[0] : body;
}

function shapeValues(value, shape) {
  if (shape === 'scalar') {
    if (value !== null && typeof value === 'object') failure('OUTPUT_DECODE_FAILED', 'scalar output이 아닙니다.');
    return [value];
  }
  if (shape === 'array') {
    if (!Array.isArray(value)) failure('OUTPUT_DECODE_FAILED', 'array output이 아닙니다.');
    return value.slice();
  }
  if (shape === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) failure('OUTPUT_DECODE_FAILED', 'object output이 아닙니다.');
    return [value];
  }
  failure('OUTPUT_DECODE_FAILED', '지원하지 않는 output shape입니다.', { shape });
}

function decodeOutput(body, output, inputs, tagCount) {
  const candidate = unwrapBody(body);
  let decoded;
  if (output.decoder === 'raw') decoded = candidate;
  else if (output.decoder === 'json') {
    if (typeof candidate !== 'string') failure('OUTPUT_DECODE_FAILED', 'JSON output body는 문자열이어야 합니다.');
    try { decoded = JSON.parse(candidate); } catch (_) { failure('OUTPUT_DECODE_FAILED', 'DBus output JSON을 해석할 수 없습니다.'); }
  } else failure('OUTPUT_DECODE_FAILED', '지원하지 않는 output decoder입니다.');

  if (output.success) {
    const actual = readSimplePath(decoded, output.success.path);
    if (output.success.operator !== 'equals' || actual !== output.success.value) {
      failure('DBUS_CALL_FAILED', 'DBus Method가 실패 결과를 반환했습니다.', { path: output.success.path });
    }
  }
  const selected = output.path ? readSimplePath(decoded, output.path) : decoded;
  const values = shapeValues(selected, output.shape);
  const returnedCount = output.returnedCountPath === undefined
    ? values.length : readSimplePath(decoded, output.returnedCountPath);
  if (!Number.isInteger(returnedCount) || returnedCount < 0) {
    failure('OUTPUT_COUNT_MISMATCH', '반환 count가 0 이상의 정수가 아닙니다.');
  }
  const expectedCount = output.expectedCount ? inputs[output.expectedCount.inputId] : undefined;
  const expectedInvalid = expectedCount !== undefined
    && (!Number.isInteger(expectedCount) || expectedCount < 0
      || returnedCount !== expectedCount || values.length !== expectedCount);
  const tagCountInvalid = tagCount !== undefined
    && (!Number.isInteger(tagCount) || tagCount < 0 || values.length !== tagCount);
  if (returnedCount !== values.length || expectedInvalid || tagCountInvalid) {
    failure('OUTPUT_COUNT_MISMATCH', '입력, 반환 값, Tag count가 서로 다릅니다.', {
      expectedCount, returnedCount, valueCount: values.length, tagCount,
    });
  }
  return { body: decoded, values, returnedCount, expectedCount };
}

module.exports = { decodeOutput, parseSimplePath, readSimplePath };
