'use strict';

// Minimal helpers shared by generated CGI endpoints.

const process = require('process');
const { sanitizeText, sensitiveKey } = require('../log/sanitize.js');

const MAX_REQUEST_JSON_BYTES = 512 * 1024;
const MAX_QUERY_BYTES = 128 * 1024;

function utf8Bytes(value) {
  if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(value, 'utf8');
  return unescape(encodeURIComponent(value)).length;
}

function parseQuery(queryString, options) {
  const settings = options || {};
  const arrayKeys = new Set(settings.arrayKeys || []);
  const source = queryString === undefined
    ? String((process.env.get && process.env.get('QUERY_STRING')) || '')
    : String(queryString || '');
  if (utf8Bytes(source) > (settings.maxBytes || MAX_QUERY_BYTES)) {
    const failure = requestError('query string이 너무 큽니다.');
    failure.code = 'REQUEST_TOO_LARGE';
    throw failure;
  }
  const result = {};
  source.split('&').forEach((part) => {
    if (!part) return;
    const pair = part.split('=');
    const key = decodeURIComponent(String(pair.shift() || '').replace(/\+/g, ' '));
    const value = decodeURIComponent(pair.join('=').replace(/\+/g, ' '));
    if (!key) return;
    if (arrayKeys.has(key)) {
      if (!Array.isArray(result[key])) result[key] = [];
      result[key].push(value);
    } else result[key] = value;
  });
  return result;
}

function readQuery(queryString, options) {
  try {
    return { ok: true, value: parseQuery(queryString, options) };
  } catch (failure) {
    return {
      ok: false,
      error: failure && failure.code === 'REQUEST_TOO_LARGE'
        ? failure : requestError('query string 형식이 잘못되었습니다.'),
    };
  }
}

function readBody(rawBody, options) {
  try {
    const raw = rawBody === undefined ? process.stdin.read() : rawBody;
    const maximum = options && options.maxBytes ? options.maxBytes : MAX_REQUEST_JSON_BYTES;
    if (utf8Bytes(String(raw || '')) > maximum) {
      const failure = requestError('JSON body가 너무 큽니다.', { maximum });
      failure.code = 'REQUEST_TOO_LARGE';
      throw failure;
    }
    return { ok: true, value: raw ? JSON.parse(raw) : {} };
  } catch (failure) {
    return {
      ok: false,
      error: failure && failure.code === 'REQUEST_TOO_LARGE'
        ? failure : requestError('JSON body 형식이 잘못되었습니다.'),
    };
  }
}

function requestError(reason, details) {
  const error = new Error(reason);
  error.code = 'REQUEST_INVALID';
  error.details = details || {};
  return error;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError(`${label || 'request'}는 JSON 객체여야 합니다.`);
  }
  return value;
}

function requireStringFields(value, fields) {
  const object = requireObject(value, 'request');
  const missing = fields.filter((field) => typeof object[field] !== 'string' || !object[field]);
  if (missing.length) throw requestError('필수 문자열 값이 없습니다.', { fields: missing });
  return object;
}

function createFactory(factory) {
  try {
    return { ok: true, value: factory() };
  } catch (factoryError) {
    return { ok: false, error: factoryError };
  }
}

function reply(status, payload) {
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write(`Status: ${status}\r\n`);
  process.stdout.write('\r\n');
  process.stdout.write(JSON.stringify(payload));
}

function fail(error, status) {
  const payload = {
    ok: false,
    code: (error && error.code) || 'INTERNAL_ERROR',
    reason: sanitizeText(error && error.message ? error.message : String(error || 'unknown error')),
    details: sanitizeDetails((error && error.details) || {}),
  };
  reply(status || statusForError(error), payload);
}

function statusForError(error) {
  const code = String((error && error.code) || '');
  if (code === 'REQUEST_TOO_LARGE' || code === 'LOG_TOO_LARGE') return 413;
  if (code === 'DB_SERVER_CREATE_LOCKED') return 409;
  if (code === 'JOB_REVISION_REQUIRED' || code === 'TIMEZONE_UNSUPPORTED'
    || code === 'JOB_DATA_SOURCE_MISMATCH') return 400;
  if (code === 'RUNTIME_VERSION_INVALID') return 503;
  if (/_INVALID$/.test(code) || code === 'SETTINGS_INVALID') return 400;
  if (/_NOT_FOUND$/.test(code)) return 404;
  if (/_ALREADY_EXISTS$/.test(code) || /_IN_USE/.test(code) || /_READ_ONLY$/.test(code) || /_DEFAULT$/.test(code)
    || /_NOT_AVAILABLE$/.test(code) || code === 'JOB_INVALID_CONFIG'
    || code === 'DBUS_ARGUMENT_UNSUPPORTED'
    || code === 'JOB_NAME_IMMUTABLE' || code === 'JOB_CONFLICT' || code === 'JOB_RUNNING' || code === 'LOG_HOT_APPLY_NOT_AVAILABLE'
    || code === 'SERVICE_NOT_INSTALLED' || code === 'SERVICE_ALREADY_INSTALLED'
    || code === 'SERVICE_NOT_RUNNING') return 409;
  if (/CONTROLLER|UNAVAILABLE|UNKNOWN/.test(code)) return 503;
  if (error && error.kind === 'not_found') return 404;
  if (error && error.kind === 'conflict') return 409;
  if (error && error.kind === 'controller') return 503;
  return 500;
}

function sanitizeDetails(value, key) {
  if (sensitiveKey(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDetails(item));
  if (value && typeof value === 'object') {
    const result = {};
    Object.keys(value).slice(0, 100).forEach((name) => { result[name] = sanitizeDetails(value[name], name); });
    return result;
  }
  return typeof value === 'string' ? sanitizeText(value) : value;
}

module.exports = {
  parseQuery,
  readQuery,
  readBody,
  reply,
  fail,
  statusForError,
  requestError,
  requireObject,
  requireStringFields,
  createFactory,
  MAX_QUERY_BYTES,
  MAX_REQUEST_JSON_BYTES,
};
