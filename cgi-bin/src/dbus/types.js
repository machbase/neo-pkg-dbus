'use strict';

const OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;
const INTEGER_LIMITS = {
  byte: [0n, 255n], uint16: [0n, 65535n], uint32: [0n, 4294967295n], uint64: [0n, 18446744073709551615n],
  int16: [-32768n, 32767n], int32: [-2147483648n, 2147483647n], int64: [-9223372036854775808n, 9223372036854775807n],
};
const BASIC_TYPES = new Set(['byte', 'boolean', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'double', 'unix-fd', 'string', 'object-path', 'signature', 'variant']);
const DICT_KEY_TYPES = new Set(['byte', 'boolean', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'double', 'unix-fd', 'string', 'object-path', 'signature']);
const BASIC_SIGNATURE_TYPES = new Set('ybnqiuxthdsoghv'.split(''));
const SIGNATURE_TYPE_MAP = { y: 'byte', b: 'boolean', n: 'int16', q: 'uint16', i: 'int32', u: 'uint32', x: 'int64', t: 'uint64', d: 'double', h: 'unix-fd', s: 'string', o: 'object-path', g: 'signature', v: 'variant' };
const TYPE_SIGNATURE_MAP = Object.fromEntries(Object.entries(SIGNATURE_TYPE_MAP).map(([signature, type]) => [type, signature]));

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function sameFields(value, fields) { return Object.keys(value).length === fields.length && fields.every((field) => own(value, field)); }

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

function parseType(value, offset, depth, allowDictEntry) {
  if (depth > 32 || offset >= value.length) return null;
  const token = value[offset];
  if (own(SIGNATURE_TYPE_MAP, token)) return { value: SIGNATURE_TYPE_MAP[token], offset: offset + 1 };
  if (token === 'a') {
    if (value[offset + 1] === '{') {
      const keyToken = value[offset + 2];
      if (!own(SIGNATURE_TYPE_MAP, keyToken) || keyToken === 'v') return null;
      const nested = parseType(value, offset + 3, depth + 1, false);
      if (!nested || value[nested.offset] !== '}') return null;
      return { value: { type: 'array', element: { type: 'dict-entry', key: SIGNATURE_TYPE_MAP[keyToken], value: nested.value } }, offset: nested.offset + 1 };
    }
    const element = parseType(value, offset + 1, depth + 1, true);
    return element ? { value: { type: 'array', element: element.value }, offset: element.offset } : null;
  }
  if (token === '(') {
    const fields = [];
    let cursor = offset + 1;
    while (cursor < value.length && value[cursor] !== ')') {
      const field = parseType(value, cursor, depth + 1, false);
      if (!field) return null;
      fields.push(field.value);
      cursor = field.offset;
    }
    return fields.length && value[cursor] === ')' ? { value: { type: 'struct', fields }, offset: cursor + 1 } : null;
  }
  if (allowDictEntry && token === '{') return null;
  return null;
}

function typeFromSignature(value) {
  if (typeof value !== 'string' || !value || value.length > 255) return null;
  const parsed = parseType(value, 0, 0, false);
  return parsed && parsed.offset === value.length ? parsed.value : null;
}

function signatureFromType(type) {
  const normalized = normalizeType(type, 0, true);
  if (normalized === null) return null;
  if (typeof normalized === 'string') return TYPE_SIGNATURE_MAP[normalized] || null;
  if (normalized.type === 'array') {
    const element = signatureFromType(normalized.element);
    return element ? `a${element}` : null;
  }
  if (normalized.type === 'dict-entry') {
    const key = TYPE_SIGNATURE_MAP[normalized.key];
    const value = signatureFromType(normalized.value);
    return key && value ? `{${key}${value}}` : null;
  }
  const fields = normalized.fields.map(signatureFromType);
  return fields.every(Boolean) ? `(${fields.join('')})` : null;
}

function normalizeType(value, depth, allowDictEntry) {
  if ((depth || 0) > 32) return null;
  if (typeof value === 'string') return BASIC_TYPES.has(value) ? value : null;
  if (!object(value) || typeof value.type !== 'string') return null;
  if (value.type === 'array' && sameFields(value, ['type', 'element'])) {
    const element = normalizeType(value.element, (depth || 0) + 1, true);
    return element === null ? null : { type: 'array', element };
  }
  if (allowDictEntry && value.type === 'dict-entry' && sameFields(value, ['type', 'key', 'value'])) {
    const nested = normalizeType(value.value, (depth || 0) + 1, false);
    return typeof value.key === 'string' && DICT_KEY_TYPES.has(value.key) && nested !== null ? { type: 'dict-entry', key: value.key, value: nested } : null;
  }
  if (value.type === 'struct' && sameFields(value, ['type', 'fields']) && Array.isArray(value.fields) && value.fields.length) {
    const fields = value.fields.map((field) => normalizeType(field, (depth || 0) + 1, false));
    return fields.some((field) => field === null) ? null : { type: 'struct', fields };
  }
  return null;
}

function typeName(type) { return typeof type === 'string' ? type : type && type.type ? type.type : 'unknown'; }

function integerValue(type, value) {
  try {
    const integer = typeof value === 'bigint' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
    const range = INTEGER_LIMITS[type];
    return integer !== null && integer >= range[0] && integer <= range[1];
  } catch (_) { return false; }
}

function isValueValid(type, value) {
  const normalized = normalizeType(type, 0, true);
  if (normalized === null || value === undefined || value === null) return false;
  if (typeof normalized === 'object') {
    if (normalized.type === 'array') return Array.isArray(value) && value.every((item) => isValueValid(normalized.element, item));
    if (normalized.type === 'dict-entry') return object(value) && sameFields(value, ['key', 'value']) && isValueValid(normalized.key, value.key) && isValueValid(normalized.value, value.value);
    return Array.isArray(value) && value.length === normalized.fields.length && normalized.fields.every((field, index) => isValueValid(field, value[index]));
  }
  if (own(INTEGER_LIMITS, normalized)) return integerValue(normalized, value);
  if (normalized === 'double') return typeof value === 'number' && Number.isFinite(value);
  if (normalized === 'boolean') return typeof value === 'boolean';
  if (normalized === 'string') return typeof value === 'string';
  if (normalized === 'object-path') return typeof value === 'string' && OBJECT_PATH.test(value);
  if (normalized === 'signature') return validSignature(value);
  if (normalized === 'unix-fd') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return object(value) && sameFields(value, ['type', 'value']) && normalizeType(value.type) !== null && isValueValid(value.type, value.value);
}

function neoArgument(type, value) {
  const normalized = normalizeType(type);
  if (normalized === null || !isValueValid(normalized, value)) return null;
  if (typeof normalized === 'object' || normalized === 'variant' || normalized === 'unix-fd') return { unsupported: typeName(normalized) };
  const neoType = normalized === 'boolean' ? 'bool' : normalized === 'object-path' ? 'objectpath' : normalized;
  const text = own(INTEGER_LIMITS, normalized) ? BigInt(value).toString() : String(value);
  return { value: `${neoType}:${text}` };
}

module.exports = { normalizeType, typeName, isValueValid, neoArgument, validSignature, typeFromSignature, signatureFromType };
