'use strict';

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'token', 'authorization', 'cookie', 'secret', 'body', 'rawbody', 'raw_body',
  'config', 'request', 'response',
]);

function sensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key || '').toLowerCase());
}

function sanitizeFields(fields) {
  const result = {};
  Object.keys(fields || {}).forEach((key) => {
    const value = fields[key];
    if (sensitiveKey(key)) result[key] = '[REDACTED]';
    else if (typeof value === 'string') result[key] = sanitizeText(value);
    else if (value && typeof value === 'object') result[key] = '[OBJECT]';
    else result[key] = value;
  });
  return result;
}

function sanitizeText(value) {
  let text = String(value === undefined || value === null ? '' : value);
  text = text.replace(/("(?:password|passwd|token|authorization|cookie|secret|body|rawBody|raw_body)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
  text = text.replace(/("(?:config|request|response)"\s*:\s*)\{.*\}/gi, '$1"[REDACTED]"');
  text = text.replace(/\b(password|passwd|token|authorization|cookie|secret|body|rawBody|raw_body|config)\s*([:=])\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|[^\s,;)]+)/gi, '$1$2[REDACTED]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi, '$1$2:[REDACTED]@');
  return text;
}

module.exports = { sanitizeFields, sanitizeText, sensitiveKey };
