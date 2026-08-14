'use strict';

const { error } = require('../config/errors.js');

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const NUMERIC_TYPES = new Set(['byte', 'uint16', 'uint32', 'uint64', 'int16', 'int32', 'int64', 'double']);
const STRING_TYPES = new Set(['string', 'object-path', 'signature']);

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

function readPointer(source, pointer) {
  if (pointer === '') return source;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) failure('OUTPUT_DECODE_FAILED', 'output selection path는 JSON Pointer여야 합니다.', { path: pointer });
  return pointer.slice(1).split('/').reduce((value, token) => {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || value === null || value === undefined || !Object.prototype.hasOwnProperty.call(Object(value), key)) {
      failure('OUTPUT_DECODE_FAILED', 'output selection path에서 값을 찾을 수 없습니다.', { path: pointer });
    }
    return value[key];
  }, source);
}

function validateSelectedValue(value, valueType, selection) {
  if (valueType === 'numeric') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      failure('OUTPUT_DECODE_FAILED', '선택한 값은 유한한 숫자여야 합니다.', { valueType, selector: selection.selector });
    }
    return value;
  }
  if (valueType === 'string') {
    if (typeof value !== 'string') failure('OUTPUT_DECODE_FAILED', '선택한 값은 문자열이어야 합니다.', { valueType, selector: selection.selector });
    return value;
  }
  if (valueType === 'json') {
    try {
      if (JSON.stringify(value) === undefined) failure('OUTPUT_DECODE_FAILED', '선택한 값은 JSON으로 저장할 수 있어야 합니다.', { valueType, selector: selection.selector });
    } catch (_) { failure('OUTPUT_DECODE_FAILED', '선택한 값은 JSON으로 저장할 수 있어야 합니다.', { valueType, selector: selection.selector }); }
    return value;
  }
  failure('OUTPUT_DECODE_FAILED', '지원하지 않는 output valueType입니다.', { valueType });
}

function nativeValueType(type) {
  if (NUMERIC_TYPES.has(type)) return 'numeric';
  if (STRING_TYPES.has(type)) return 'string';
  if (type === 'boolean') return 'json';
  return undefined;
}

function decodeSelection(body, selection, outputType) {
  if (!Array.isArray(body) || !selection || !Number.isInteger(selection.sourceIndex) || selection.sourceIndex < 0 || selection.sourceIndex >= body.length) {
    failure('OUTPUT_DECODE_FAILED', 'output selection sourceIndex가 유효하지 않습니다.', { sourceIndex: selection && selection.sourceIndex });
  }
  let source = body[selection.sourceIndex];
  if (selection.interpretation === 'json') {
    if (typeof source !== 'string') failure('OUTPUT_DECODE_FAILED', 'JSON 해석은 string output에만 사용할 수 있습니다.');
    try { source = JSON.parse(source); } catch (_) { failure('OUTPUT_DECODE_FAILED', 'string output을 JSON으로 해석할 수 없습니다.'); }
  } else if (selection.interpretation !== undefined && selection.interpretation !== 'native') {
    failure('OUTPUT_DECODE_FAILED', '지원하지 않는 output interpretation입니다.', { interpretation: selection.interpretation });
  }
  const isLegacy = Object.prototype.hasOwnProperty.call(selection, 'path') || Object.prototype.hasOwnProperty.call(selection, 'mode');
  const valueType = selection.valueType === undefined ? nativeValueType(outputType) : selection.valueType;
  const pointer = isLegacy ? selection.path : selection.selector || '';
  const value = readPointer(source, pointer);
  let values;
  if (isLegacy) {
    values = selection.mode === 'single' ? [value] : selection.mode === 'each' && Array.isArray(value) ? value.slice() : null;
    if (!values) failure('OUTPUT_DECODE_FAILED', 'array가 아닌 output에는 each mode를 사용할 수 없습니다.', { mode: selection.mode });
  } else if (valueType === 'array') {
    if (!Array.isArray(value)) failure('OUTPUT_DECODE_FAILED', 'array valueType은 배열 값을 선택해야 합니다.', { selector: selection.selector });
    values = value.map((item) => validateSelectedValue(item, selection.elementType, selection));
  } else {
    values = [validateSelectedValue(value, valueType, selection)];
  }
  if (!Array.isArray(selection.tags) || values.length !== selection.tags.length) failure('OUTPUT_COUNT_MISMATCH', 'output 값 수와 Tag 수가 다릅니다.', { valueCount: values.length, tagCount: selection.tags && selection.tags.length });
  return values;
}

function unwrapBody(body) {
  if (!Array.isArray(body)) failure('OUTPUT_DECODE_FAILED', 'DBus body는 배열이어야 합니다.');
  return body.length === 1 ? body[0] : body;
}

function shapeValues(value, shape) {
  if (shape === 'auto') return Array.isArray(value) ? value.slice() : [value];
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

module.exports = { decodeOutput, decodeSelection, parseSimplePath, readSimplePath, readPointer };
