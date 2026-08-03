'use strict';

// Minimal helpers shared by generated CGI endpoints.

const process = require('process');

function parseQuery(queryString) {
  const source = queryString === undefined
    ? String((process.env.get && process.env.get('QUERY_STRING')) || '')
    : String(queryString || '');
  const result = {};
  source.split('&').forEach((part) => {
    if (!part) return;
    const pair = part.split('=');
    const key = decodeURIComponent(String(pair.shift() || '').replace(/\+/g, ' '));
    const value = decodeURIComponent(pair.join('=').replace(/\+/g, ' '));
    if (key) result[key] = value;
  });
  return result;
}

function readQuery(queryString) {
  try {
    return { ok: true, value: parseQuery(queryString) };
  } catch (_) {
    return {
      ok: false,
      error: new Error('query string 형식이 잘못되었습니다.'),
    };
  }
}

function readBody(rawBody) {
  try {
    const raw = rawBody === undefined ? process.stdin.read() : rawBody;
    return { ok: true, value: raw ? JSON.parse(raw) : {} };
  } catch (_) {
    return {
      ok: false,
      error: new Error('JSON body 형식이 잘못되었습니다.'),
    };
  }
}

function reply(status, payload) {
  process.stdout.write('Content-Type: application/json\r\n');
  process.stdout.write(`Status: ${status}\r\n`);
  process.stdout.write('\r\n');
  process.stdout.write(JSON.stringify(payload));
}

function fail(error, status, kind) {
  const payload = {
    ok: false,
    error: error && error.message ? error.message : String(error || 'unknown error'),
  };
  if (kind) payload.kind = kind;
  reply(status || 400, payload);
}

function statusForError(error) {
  if (error && error.kind === 'not_found') return 404;
  if (error && error.kind === 'conflict') return 409;
  if (error && error.kind === 'controller') return 503;
  return 500;
}

module.exports = { parseQuery, readQuery, readBody, reply, fail, statusForError };
