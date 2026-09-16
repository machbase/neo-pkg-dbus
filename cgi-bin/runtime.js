"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// cgi-bin/src/log/sanitize.js
var require_sanitize = __commonJS({
  "cgi-bin/src/log/sanitize.js"(exports2, module2) {
    "use strict";
    var SENSITIVE_KEYS = /* @__PURE__ */ new Set([
      "password",
      "passwd",
      "token",
      "authorization",
      "cookie",
      "secret",
      "body",
      "rawbody",
      "raw_body",
      "config",
      "request",
      "response"
    ]);
    function sensitiveKey(key) {
      return SENSITIVE_KEYS.has(String(key || "").toLowerCase());
    }
    function sanitizeFields(fields) {
      const result = {};
      Object.keys(fields || {}).forEach((key) => {
        const value = fields[key];
        if (sensitiveKey(key)) result[key] = "[REDACTED]";
        else if (typeof value === "string") result[key] = sanitizeText(value);
        else if (value && typeof value === "object") result[key] = "[OBJECT]";
        else result[key] = value;
      });
      return result;
    }
    function sanitizeText(value) {
      let text = String(value === void 0 || value === null ? "" : value);
      text = text.replace(/("(?:password|passwd|token|authorization|cookie|secret|body|rawBody|raw_body)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"');
      text = text.replace(/("(?:config|request|response)"\s*:\s*)\{.*\}/gi, '$1"[REDACTED]"');
      text = text.replace(/\b(password|passwd|token|authorization|cookie|secret|body|rawBody|raw_body|config)\s*([:=])\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|[^\s,;)]+)/gi, "$1$2[REDACTED]");
      text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
      text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi, "$1$2:[REDACTED]@");
      return text;
    }
    module2.exports = { sanitizeFields, sanitizeText, sensitiveKey };
  }
});

// cgi-bin/src/cgi/http.js
var require_http = __commonJS({
  "cgi-bin/src/cgi/http.js"(exports2, module2) {
    "use strict";
    var process = require("process");
    var { sanitizeText, sensitiveKey } = require_sanitize();
    var MAX_REQUEST_JSON_BYTES = 512 * 1024;
    var MAX_QUERY_BYTES = 128 * 1024;
    function utf8Bytes(value) {
      if (typeof Buffer !== "undefined" && Buffer.byteLength) return Buffer.byteLength(value, "utf8");
      return unescape(encodeURIComponent(value)).length;
    }
    function parseQuery(queryString, options) {
      const settings = options || {};
      const arrayKeys = new Set(settings.arrayKeys || []);
      const source = queryString === void 0 ? String(process.env.get && process.env.get("QUERY_STRING") || "") : String(queryString || "");
      if (utf8Bytes(source) > (settings.maxBytes || MAX_QUERY_BYTES)) {
        const failure = requestError("query string\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4.");
        failure.code = "REQUEST_TOO_LARGE";
        throw failure;
      }
      const result = {};
      source.split("&").forEach((part) => {
        if (!part) return;
        const pair = part.split("=");
        const key = decodeURIComponent(String(pair.shift() || "").replace(/\+/g, " "));
        const value = decodeURIComponent(pair.join("=").replace(/\+/g, " "));
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
          error: failure && failure.code === "REQUEST_TOO_LARGE" ? failure : requestError("query string \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.")
        };
      }
    }
    function readBody(rawBody, options) {
      try {
        const raw = rawBody === void 0 ? process.stdin.read() : rawBody;
        const maximum = options && options.maxBytes ? options.maxBytes : MAX_REQUEST_JSON_BYTES;
        if (utf8Bytes(String(raw || "")) > maximum) {
          const failure = requestError("JSON body\uAC00 \uB108\uBB34 \uD07D\uB2C8\uB2E4.", { maximum });
          failure.code = "REQUEST_TOO_LARGE";
          throw failure;
        }
        return { ok: true, value: raw ? JSON.parse(raw) : {} };
      } catch (failure) {
        return {
          ok: false,
          error: failure && failure.code === "REQUEST_TOO_LARGE" ? failure : requestError("JSON body \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.")
        };
      }
    }
    function requestError(reason, details) {
      const error = new Error(reason);
      error.code = "REQUEST_INVALID";
      error.details = details || {};
      return error;
    }
    function requireObject(value, label) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw requestError(`${label || "request"}\uB294 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      }
      return value;
    }
    function requireStringFields(value, fields) {
      const object = requireObject(value, "request");
      const missing = fields.filter((field) => typeof object[field] !== "string" || !object[field]);
      if (missing.length) throw requestError("\uD544\uC218 \uBB38\uC790\uC5F4 \uAC12\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", { fields: missing });
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
      process.stdout.write("Content-Type: application/json\r\n");
      process.stdout.write(`Status: ${status}\r
`);
      process.stdout.write("\r\n");
      process.stdout.write(JSON.stringify(payload));
    }
    function fail(error, status) {
      const payload = {
        ok: false,
        code: error && error.code || "INTERNAL_ERROR",
        reason: sanitizeText(error && error.message ? error.message : String(error || "unknown error")),
        details: sanitizeDetails(error && error.details || {})
      };
      reply(status || statusForError(error), payload);
    }
    function statusForError(error) {
      const code = String(error && error.code || "");
      if (code === "REQUEST_TOO_LARGE" || code === "LOG_TOO_LARGE") return 413;
      if (code === "DB_SERVER_CREATE_LOCKED") return 409;
      if (code === "JOB_REVISION_REQUIRED" || code === "TIMEZONE_UNSUPPORTED" || code === "JOB_DATA_SOURCE_MISMATCH") return 400;
      if (code === "RUNTIME_VERSION_INVALID") return 503;
      if (/_INVALID$/.test(code) || code === "SETTINGS_INVALID") return 400;
      if (/_NOT_FOUND$/.test(code)) return 404;
      if (/_ALREADY_EXISTS$/.test(code) || /_IN_USE/.test(code) || /_READ_ONLY$/.test(code) || /_DEFAULT$/.test(code) || /_NOT_AVAILABLE$/.test(code) || code === "JOB_INVALID_CONFIG" || code === "DBUS_ARGUMENT_UNSUPPORTED" || code === "JOB_NAME_IMMUTABLE" || code === "JOB_CONFLICT" || code === "JOB_RUNNING" || code === "LOG_HOT_APPLY_NOT_AVAILABLE" || code === "SERVICE_NOT_INSTALLED" || code === "SERVICE_ALREADY_INSTALLED" || code === "SERVICE_NOT_RUNNING") return 409;
      if (/CONTROLLER|UNAVAILABLE|UNKNOWN/.test(code)) return 503;
      if (error && error.kind === "not_found") return 404;
      if (error && error.kind === "conflict") return 409;
      if (error && error.kind === "controller") return 503;
      return 500;
    }
    function sanitizeDetails(value, key) {
      if (sensitiveKey(key)) return "[REDACTED]";
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeDetails(item));
      if (value && typeof value === "object") {
        const result = {};
        Object.keys(value).slice(0, 100).forEach((name) => {
          result[name] = sanitizeDetails(value[name], name);
        });
        return result;
      }
      return typeof value === "string" ? sanitizeText(value) : value;
    }
    module2.exports = {
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
      MAX_REQUEST_JSON_BYTES
    };
  }
});

// cgi-bin/src/config/errors.js
var require_errors = __commonJS({
  "cgi-bin/src/config/errors.js"(exports2, module2) {
    "use strict";
    var ConfigError = class extends Error {
      constructor(code, reason, details) {
        super(reason);
        this.name = "ConfigError";
        this.code = code;
        this.details = details || {};
      }
    };
    function error(code, reason, details) {
      return new ConfigError(code, reason, details);
    }
    module2.exports = { ConfigError, error };
  }
});

// cgi-bin/src/config/atomic-json.js
var require_atomic_json = __commonJS({
  "cgi-bin/src/config/atomic-json.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    function randomNonce() {
      let result = "";
      for (let index = 0; index < 4; index += 1) {
        result += Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0");
      }
      return result;
    }
    function openTemporary(directory, basename) {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const file = path.join(directory, `.${basename}.tmp-${randomNonce()}`);
        try {
          return { file, descriptor: fs.openSync(file, "wx") };
        } catch (openError) {
          if (openError && openError.code === "EEXIST") continue;
          throw openError;
        }
      }
      throw new Error("atomic JSON \uC784\uC2DC \uD30C\uC77C \uC774\uB984\uC744 \uB9CC\uB4E4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
    function writeJsonAtomic(file, value) {
      const directory = path.dirname(file);
      fs.mkdirSync(directory, { recursive: true });
      const temporary = openTemporary(directory, path.basename(file));
      let descriptorOpen = true;
      try {
        fs.writeSync(temporary.descriptor, `${JSON.stringify(value, null, 2)}
`);
        fs.closeSync(temporary.descriptor);
        descriptorOpen = false;
        fs.renameSync(temporary.file, file);
      } catch (writeError) {
        if (descriptorOpen) {
          try {
            fs.closeSync(temporary.descriptor);
          } catch (_) {
          }
        }
        try {
          if (fs.existsSync(temporary.file)) fs.unlinkSync(temporary.file);
        } catch (_) {
        }
        throw writeError;
      }
    }
    module2.exports = { writeJsonAtomic };
  }
});

// cgi-bin/src/dbus/types.js
var require_types = __commonJS({
  "cgi-bin/src/dbus/types.js"(exports2, module2) {
    "use strict";
    var OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;
    var INTEGER_LIMITS = {
      byte: [0n, 255n],
      uint16: [0n, 65535n],
      uint32: [0n, 4294967295n],
      uint64: [0n, 18446744073709551615n],
      int16: [-32768n, 32767n],
      int32: [-2147483648n, 2147483647n],
      int64: [-9223372036854775808n, 9223372036854775807n]
    };
    var BASIC_TYPES = /* @__PURE__ */ new Set(["byte", "boolean", "int16", "uint16", "int32", "uint32", "int64", "uint64", "double", "unix-fd", "string", "object-path", "signature", "variant"]);
    var DICT_KEY_TYPES = /* @__PURE__ */ new Set(["byte", "boolean", "int16", "uint16", "int32", "uint32", "int64", "uint64", "double", "unix-fd", "string", "object-path", "signature"]);
    var BASIC_SIGNATURE_TYPES = new Set("ybnqiuxthdsoghv".split(""));
    var SIGNATURE_TYPE_MAP = { y: "byte", b: "boolean", n: "int16", q: "uint16", i: "int32", u: "uint32", x: "int64", t: "uint64", d: "double", h: "unix-fd", s: "string", o: "object-path", g: "signature", v: "variant" };
    var TYPE_SIGNATURE_MAP = Object.fromEntries(Object.entries(SIGNATURE_TYPE_MAP).map(([signature, type]) => [type, signature]));
    function own(value, key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    }
    function object(value) {
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }
    function sameFields(value, fields) {
      return Object.keys(value).length === fields.length && fields.every((field) => own(value, field));
    }
    function parseSignatureType(value, offset, depth) {
      if (depth > 32 || offset >= value.length) return -1;
      const type = value[offset];
      if (BASIC_SIGNATURE_TYPES.has(type)) return offset + 1;
      if (type === "a") {
        if (value[offset + 1] === "{") {
          const key = value[offset + 2];
          if (!BASIC_SIGNATURE_TYPES.has(key) || key === "v") return -1;
          const afterValue = parseSignatureType(value, offset + 3, depth + 1);
          return afterValue >= 0 && value[afterValue] === "}" ? afterValue + 1 : -1;
        }
        return parseSignatureType(value, offset + 1, depth + 1);
      }
      if (type === "(") {
        let cursor = offset + 1;
        const first = cursor;
        while (cursor < value.length && value[cursor] !== ")") {
          cursor = parseSignatureType(value, cursor, depth + 1);
          if (cursor < 0) return -1;
        }
        return cursor > first && value[cursor] === ")" ? cursor + 1 : -1;
      }
      return -1;
    }
    function validSignature(value) {
      if (typeof value !== "string" || value.length > 255) return false;
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
      if (token === "a") {
        if (value[offset + 1] === "{") {
          const keyToken = value[offset + 2];
          if (!own(SIGNATURE_TYPE_MAP, keyToken) || keyToken === "v") return null;
          const nested = parseType(value, offset + 3, depth + 1, false);
          if (!nested || value[nested.offset] !== "}") return null;
          return { value: { type: "array", element: { type: "dict-entry", key: SIGNATURE_TYPE_MAP[keyToken], value: nested.value } }, offset: nested.offset + 1 };
        }
        const element = parseType(value, offset + 1, depth + 1, true);
        return element ? { value: { type: "array", element: element.value }, offset: element.offset } : null;
      }
      if (token === "(") {
        const fields = [];
        let cursor = offset + 1;
        while (cursor < value.length && value[cursor] !== ")") {
          const field = parseType(value, cursor, depth + 1, false);
          if (!field) return null;
          fields.push(field.value);
          cursor = field.offset;
        }
        return fields.length && value[cursor] === ")" ? { value: { type: "struct", fields }, offset: cursor + 1 } : null;
      }
      if (allowDictEntry && token === "{") return null;
      return null;
    }
    function typeFromSignature(value) {
      if (typeof value !== "string" || !value || value.length > 255) return null;
      const parsed = parseType(value, 0, 0, false);
      return parsed && parsed.offset === value.length ? parsed.value : null;
    }
    function signatureFromType(type) {
      const normalized = normalizeType(type, 0, true);
      if (normalized === null) return null;
      if (typeof normalized === "string") return TYPE_SIGNATURE_MAP[normalized] || null;
      if (normalized.type === "array") {
        const element = signatureFromType(normalized.element);
        return element ? `a${element}` : null;
      }
      if (normalized.type === "dict-entry") {
        const key = TYPE_SIGNATURE_MAP[normalized.key];
        const value = signatureFromType(normalized.value);
        return key && value ? `{${key}${value}}` : null;
      }
      const fields = normalized.fields.map(signatureFromType);
      return fields.every(Boolean) ? `(${fields.join("")})` : null;
    }
    function normalizeType(value, depth, allowDictEntry) {
      if ((depth || 0) > 32) return null;
      if (typeof value === "string") return BASIC_TYPES.has(value) ? value : null;
      if (!object(value) || typeof value.type !== "string") return null;
      if (value.type === "array" && sameFields(value, ["type", "element"])) {
        const element = normalizeType(value.element, (depth || 0) + 1, true);
        return element === null ? null : { type: "array", element };
      }
      if (allowDictEntry && value.type === "dict-entry" && sameFields(value, ["type", "key", "value"])) {
        const nested = normalizeType(value.value, (depth || 0) + 1, false);
        return typeof value.key === "string" && DICT_KEY_TYPES.has(value.key) && nested !== null ? { type: "dict-entry", key: value.key, value: nested } : null;
      }
      if (value.type === "struct" && sameFields(value, ["type", "fields"]) && Array.isArray(value.fields) && value.fields.length) {
        const fields = value.fields.map((field) => normalizeType(field, (depth || 0) + 1, false));
        return fields.some((field) => field === null) ? null : { type: "struct", fields };
      }
      return null;
    }
    function typeName(type) {
      return typeof type === "string" ? type : type && type.type ? type.type : "unknown";
    }
    function integerValue(type, value) {
      try {
        const integer = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value) ? BigInt(value) : null;
        const range = INTEGER_LIMITS[type];
        return integer !== null && integer >= range[0] && integer <= range[1];
      } catch (_) {
        return false;
      }
    }
    function isValueValid(type, value) {
      const normalized = normalizeType(type, 0, true);
      if (normalized === null || value === void 0 || value === null) return false;
      if (typeof normalized === "object") {
        if (normalized.type === "array") return Array.isArray(value) && value.every((item) => isValueValid(normalized.element, item));
        if (normalized.type === "dict-entry") return object(value) && sameFields(value, ["key", "value"]) && isValueValid(normalized.key, value.key) && isValueValid(normalized.value, value.value);
        return Array.isArray(value) && value.length === normalized.fields.length && normalized.fields.every((field, index) => isValueValid(field, value[index]));
      }
      if (own(INTEGER_LIMITS, normalized)) return integerValue(normalized, value);
      if (normalized === "double") return typeof value === "number" && Number.isFinite(value);
      if (normalized === "boolean") return typeof value === "boolean";
      if (normalized === "string") return typeof value === "string";
      if (normalized === "object-path") return typeof value === "string" && OBJECT_PATH.test(value);
      if (normalized === "signature") return validSignature(value);
      if (normalized === "unix-fd") return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      return object(value) && sameFields(value, ["type", "value"]) && normalizeType(value.type) !== null && isValueValid(value.type, value.value);
    }
    function neoArgument(type, value) {
      const normalized = normalizeType(type);
      if (normalized === null || !isValueValid(normalized, value)) return null;
      if (typeof normalized === "object" || normalized === "variant" || normalized === "unix-fd") return { unsupported: typeName(normalized) };
      const neoType = normalized === "boolean" ? "bool" : normalized === "object-path" ? "objectpath" : normalized;
      const text = own(INTEGER_LIMITS, normalized) ? BigInt(value).toString() : String(value);
      return { value: `${neoType}:${text}` };
    }
    module2.exports = { normalizeType, typeName, isValueValid, neoArgument, validSignature, typeFromSignature, signatureFromType };
  }
});

// cgi-bin/src/jobs/validator.js
var require_validator = __commonJS({
  "cgi-bin/src/jobs/validator.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var { isValueValid, normalizeType } = require_types();
    var MAX_JOB_JSON_BYTES = 512 * 1024;
    var MAX_METHOD_CALLS = 128;
    var MAX_JOB_NAME_LENGTH = 100;
    var MAX_TAG_NAME_LENGTH = 100;
    var JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
    var CALL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
    var SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
    var SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
    var INTEGER_TYPES = /* @__PURE__ */ new Set(["byte", "uint16", "uint32", "uint64", "int16", "int32", "int64"]);
    var WIDE_INTEGER_TYPES = /* @__PURE__ */ new Set(["uint64", "int64"]);
    var NUMBER_TYPES = /* @__PURE__ */ new Set([...INTEGER_TYPES, "double"]);
    var NATIVE_SCALAR_OUTPUT_TYPES = /* @__PURE__ */ new Set([
      "byte",
      "uint16",
      "uint32",
      "uint64",
      "int16",
      "int32",
      "int64",
      "double",
      "boolean",
      "string",
      "object-path",
      "signature"
    ]);
    var INTEGER_RANGES = {
      byte: [0, 255],
      uint8: [0, 255],
      uint16: [0, 65535],
      uint32: [0, 4294967295],
      int16: [-32768, 32767],
      int32: [-2147483648, 2147483647]
    };
    var WIDE_INTEGER_RANGES = {
      uint64: [0n, 18446744073709551615n],
      int64: [-9223372036854775808n, 9223372036854775807n]
    };
    var SAVE_POLICIES = /* @__PURE__ */ new Set(["perMethod", "afterAllMethods"]);
    var METHOD_ERROR_POLICIES = /* @__PURE__ */ new Set(["stop"]);
    var LOG_LEVELS = /* @__PURE__ */ new Set(["trace", "debug", "info", "warn", "error"]);
    function invalid(reason, details) {
      throw error("JOB_INVALID", reason, details);
    }
    function isObject(value) {
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }
    function assertObject(value, label) {
      if (!isObject(value)) invalid(`${label}\uC740(\uB294) JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
    }
    function assertFields(value, fields, label) {
      const unknown = Object.keys(value).filter((key) => !fields.includes(key));
      if (unknown.length) invalid(`${label}\uC5D0 \uC54C \uC218 \uC5C6\uB294 \uD544\uB4DC\uAC00 \uC788\uC2B5\uB2C8\uB2E4.`, { fields: unknown });
    }
    function utf8Bytes(value) {
      return unescape(encodeURIComponent(value)).length;
    }
    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }
    function isValidJobName(name) {
      return typeof name === "string" && name.length <= MAX_JOB_NAME_LENGTH && JOB_NAME.test(name) && !/[\\/]/.test(name);
    }
    function validateJobName(name) {
      if (!isValidJobName(name)) {
        invalid(`Job name\uC740 \uCD5C\uB300 ${MAX_JOB_NAME_LENGTH}\uC790\uC758 \uC601\uBB38 \uC18C\uBB38\uC790, \uC22B\uC790, _, -\uB9CC \uC0AC\uC6A9\uD558\uACE0 \uCC98\uC74C\uACFC \uB05D\uC740 \uC601\uBB38 \uC18C\uBB38\uC790 \uB610\uB294 \uC22B\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      }
      return name;
    }
    function deepMerge(base, patch) {
      if (!isObject(base) || !isObject(patch)) return clone(patch);
      const result = clone(base);
      Object.keys(patch).forEach((key) => {
        const next = patch[key];
        result[key] = isObject(next) && isObject(result[key]) ? deepMerge(result[key], next) : clone(next);
      });
      return result;
    }
    function inputName(input) {
      return input.id || input.name;
    }
    function validateInputValue(input, value) {
      const name = inputName(input);
      if (value === void 0 || value === null) {
        if (input.required !== false) invalid(`\uD544\uC218 input ${name} \uAC12\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.`, { inputId: name });
        return;
      }
      const type = normalizeType(input.type);
      if (type === null || !isValueValid(type, value)) {
        invalid(`input ${name} \uAC12\uC758 type\uC774 ${typeof type === "string" ? type : "DBusType"}\uC774 \uC544\uB2D9\uB2C8\uB2E4.`, { inputId: name });
      }
      if (typeof type !== "string") return;
      function wideBound(source, label) {
        let result;
        try {
          if (typeof source === "number" && Number.isSafeInteger(source)) result = BigInt(source);
          else if (typeof source === "string" && /^-?(?:0|[1-9]\d*)$/.test(source)) result = BigInt(source);
          else invalid(`input ${input.id} ${label}\uC758 ${input.type} \uC815\uC218 \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
        } catch (_) {
          invalid(`input ${input.id} ${label}\uC758 ${input.type} \uC815\uC218 \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
        }
        const range = WIDE_INTEGER_RANGES[type];
        if (result < range[0] || result > range[1]) {
          invalid(`input ${input.id} ${label}\uC774 ${input.type} \uBC94\uC704\uB97C \uBC97\uC5B4\uB0AC\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
        }
        return result;
      }
      let wideInteger = null;
      if (WIDE_INTEGER_TYPES.has(type)) {
        wideInteger = wideBound(value, "\uAC12");
      } else if (NUMBER_TYPES.has(type)) {
        if (typeof value !== "number" || !Number.isFinite(value) || INTEGER_TYPES.has(type) && !Number.isInteger(value)) {
          invalid(`input ${input.id} \uAC12\uC758 type\uC774 ${input.type}\uC774 \uC544\uB2D9\uB2C8\uB2E4.`, { inputId: input.id });
        }
        const range = INTEGER_RANGES[type];
        if (range && (value < range[0] || value > range[1])) {
          invalid(`input ${input.id} \uAC12\uC774 ${input.type} \uBC94\uC704\uB97C \uBC97\uC5B4\uB0AC\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
        }
      }
      const rules = input.validation || {};
      if (wideInteger !== null) {
        const minimum = rules.minimum === void 0 ? null : wideBound(rules.minimum, "minimum");
        const maximum = rules.maximum === void 0 ? null : wideBound(rules.maximum, "maximum");
        if (minimum !== null && maximum !== null && minimum > maximum) invalid(`input ${input.id} minimum\uC740 maximum\uBCF4\uB2E4 \uD074 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
        if (minimum !== null && wideInteger < minimum) invalid(`input ${input.id} \uAC12\uC774 minimum\uBCF4\uB2E4 \uC791\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
        if (maximum !== null && wideInteger > maximum) invalid(`input ${input.id} \uAC12\uC774 maximum\uBCF4\uB2E4 \uD07D\uB2C8\uB2E4.`, { inputId: input.id });
      } else {
        if (rules.minimum !== void 0 && value < rules.minimum) invalid(`input ${input.id} \uAC12\uC774 minimum\uBCF4\uB2E4 \uC791\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
        if (rules.maximum !== void 0 && value > rules.maximum) invalid(`input ${input.id} \uAC12\uC774 maximum\uBCF4\uB2E4 \uD07D\uB2C8\uB2E4.`, { inputId: input.id });
      }
      if (rules.pattern !== void 0 && !new RegExp(rules.pattern).test(value)) {
        invalid(`input ${input.id} \uAC12\uC774 pattern\uACFC \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`, { inputId: input.id });
      }
    }
    function validateTag(tag, names) {
      assertObject(tag, "Tag");
      assertFields(tag, ["outputIndex", "sourceAddress", "name", "bias", "multiplier", "calcOrder", "transformOrder", "signed"], "Tag");
      if (typeof tag.name !== "string" || !tag.name.trim()) {
        invalid("Tag name\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
      }
      if (tag.name.length > MAX_TAG_NAME_LENGTH) invalid(`Tag name\uC740 ${MAX_TAG_NAME_LENGTH}\uC790 \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.`, { name: tag.name });
      if (names.has(tag.name)) invalid("Job \uC548\uC5D0\uC11C Tag name\uC740 \uC911\uBCF5\uB420 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name: tag.name });
      names.add(tag.name);
      if (typeof tag.bias !== "number" || !Number.isFinite(tag.bias) || typeof tag.multiplier !== "number" || !Number.isFinite(tag.multiplier)) {
        invalid("Tag bias\uC640 multiplier\uB294 \uC720\uD55C\uD55C \uC22B\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
      }
      if (tag.transformOrder !== void 0 && (!Array.isArray(tag.transformOrder) || tag.transformOrder.length !== 2 || new Set(tag.transformOrder).size !== 2 || !tag.transformOrder.includes("bias") || !tag.transformOrder.includes("multiplier"))) {
        invalid("Tag transformOrder\uB294 bias\uC640 multiplier\uB97C \uAC01\uAC01 \uD55C \uBC88\uC529 \uAC00\uC838\uC57C \uD569\uB2C8\uB2E4.");
      }
      if (tag.signed !== void 0 && typeof tag.signed !== "boolean") invalid("Tag signed\uB294 boolean\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      return { name: tag.name, bias: tag.bias, multiplier: tag.multiplier, signed: tag.signed === true, ...tag.transformOrder ? { transformOrder: tag.transformOrder.slice() } : {} };
    }
    function validateMethodCall(call, interfaceStore, options, callIds, callNames, tagNames) {
      assertObject(call, "Method Call");
      assertFields(call, ["id", "name", "interfaceId", "methodId", "inputs", "tags", "outputSelections"], "Method Call");
      if (!CALL_ID.test(call.id || "") || callIds.has(call.id)) invalid("Method Call ID\uB294 \uC720\uD6A8\uD558\uACE0 \uC720\uC77C\uD574\uC57C \uD569\uB2C8\uB2E4.", { id: call.id });
      callIds.add(call.id);
      if (typeof call.name !== "string" || !call.name.trim() || callNames.has(call.name)) {
        invalid("Method Call name\uC740 \uBE44\uC5B4 \uC788\uC9C0 \uC54A\uACE0 \uC720\uC77C\uD574\uC57C \uD569\uB2C8\uB2E4.", { name: call.name });
      }
      callNames.add(call.name);
      const dbusInterface = interfaceStore && interfaceStore.find(call.interfaceId);
      if (!dbusInterface) invalid("DBus Interface\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: call.interfaceId });
      const method = dbusInterface.methods.find((item) => item.id === call.methodId);
      if (!method) invalid("DBus Interface\uC5D0\uC11C Method\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: call.interfaceId, methodId: call.methodId });
      assertObject(call.inputs, "Method Call inputs");
      const allowedInputs = new Set(method.inputs.map(inputName));
      const unknownInputs = Object.keys(call.inputs).filter((id) => !allowedInputs.has(id));
      if (unknownInputs.length) invalid("\uC815\uC758\uB418\uC9C0 \uC54A\uC740 Method input\uC774 \uC788\uC2B5\uB2C8\uB2E4.", { inputs: unknownInputs });
      method.inputs.forEach((input) => validateInputValue(input, call.inputs[inputName(input)]));
      const legacyTags = Array.isArray(call.tags) ? call.tags : null;
      const selections = Array.isArray(call.outputSelections) ? call.outputSelections : null;
      if (!legacyTags && !selections) invalid("Method Call\uC740 tags \uB610\uB294 outputSelections\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
      if (legacyTags && selections) invalid("Method Call\uC740 tags\uC640 outputSelections\uB97C \uD568\uAED8 \uAC00\uC9C8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const tagGroups = selections ? selections.map((selection) => ({ ...selection, tags: Array.isArray(selection.tags) ? selection.tags.slice() : selection.tags })) : [{ id: "legacy", sourceIndex: 0, path: "", mode: "each", tags: legacyTags.slice() }];
      const selectionIds = /* @__PURE__ */ new Set();
      tagGroups.forEach((selection) => {
        assertObject(selection, "Output selection");
        const legacySelection = Object.prototype.hasOwnProperty.call(selection, "path") || Object.prototype.hasOwnProperty.call(selection, "mode");
        assertFields(selection, legacySelection ? ["id", "sourceIndex", "interpretation", "path", "mode", "tags"] : ["id", "sourceIndex", "interpretation", "selector", "valueType", "elementType", "tags"], "Output selection");
        const basicInvalid = !CALL_ID.test(selection.id || "") || selectionIds.has(selection.id) || !Number.isInteger(selection.sourceIndex) || selection.sourceIndex < 0 || !["native", "json"].includes(selection.interpretation || "native") || !Array.isArray(selection.tags);
        const nativeScalar = !legacySelection && selection.interpretation !== "json" && NATIVE_SCALAR_OUTPUT_TYPES.has(method.outputs[selection.sourceIndex]?.type);
        const selectionInvalid = legacySelection ? typeof selection.path !== "string" || !["single", "each"].includes(selection.mode) : nativeScalar ? selection.selector !== void 0 && typeof selection.selector !== "string" || selection.valueType !== void 0 && !["numeric", "string", "json", "array"].includes(selection.valueType) || selection.valueType === "array" && !["numeric", "string", "json"].includes(selection.elementType) || selection.valueType !== "array" && selection.elementType !== void 0 : typeof selection.selector !== "string" || !["numeric", "string", "json", "array"].includes(selection.valueType) || selection.valueType === "array" && !["numeric", "string", "json"].includes(selection.elementType) || selection.valueType !== "array" && selection.elementType !== void 0;
        if (basicInvalid || selectionInvalid) invalid("Output selection \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        if (nativeScalar) {
          delete selection.selector;
          delete selection.valueType;
          delete selection.elementType;
        }
        selectionIds.add(selection.id);
        if (selections && selection.sourceIndex >= method.outputs.length) invalid("Output selection sourceIndex\uAC00 Method output \uBC94\uC704\uB97C \uBC97\uC5B4\uB0AC\uC2B5\uB2C8\uB2E4.", { sourceIndex: selection.sourceIndex, methodId: method.id });
        if (selection.interpretation === "json" && method.outputs[selection.sourceIndex]?.type !== "string") invalid("JSON \uD574\uC11D\uC740 string output\uC5D0\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.", { sourceIndex: selection.sourceIndex, methodId: method.id });
        if (legacySelection && selection.mode === "single" || !legacySelection && (nativeScalar || selection.valueType !== "array")) {
          if (selection.tags.length !== 1) invalid("\uB2E8\uC77C output selection\uC740 Tag \uD558\uB098\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
        }
      });
      const tags = tagGroups.flatMap((selection) => selection.tags);
      if (tags.length > options.limits.maxGeneratedTagsPerCall) {
        invalid("Method Call Tag \uAC1C\uC218\uAC00 maxGeneratedTagsPerCall\uC744 \uB118\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      tagGroups.forEach((selection) => {
        selection.tags = selection.tags.map((tag) => validateTag(tag, tagNames));
      });
      return {
        id: call.id,
        name: call.name,
        interfaceId: call.interfaceId,
        methodId: call.methodId,
        inputs: clone(call.inputs),
        ...selections ? { outputSelections: clone(tagGroups) } : { tags: clone(tagGroups[0].tags) }
      };
    }
    function validateJobConfig(value, options) {
      const settings = options || {};
      assertObject(value, "Job config");
      if (Object.prototype.hasOwnProperty.call(value, "name")) invalid("config\uC5D0\uB294 name\uC744 \uB123\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const maxJobJsonBytes = Number.isInteger(settings.maxJobJsonBytes) && settings.maxJobJsonBytes >= MAX_JOB_JSON_BYTES ? settings.maxJobJsonBytes : MAX_JOB_JSON_BYTES;
      if (utf8Bytes(JSON.stringify(value)) > maxJobJsonBytes) invalid(`Job JSON\uC740 ${maxJobJsonBytes} bytes \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      assertFields(value, [
        "schemaVersion",
        "schedule",
        "retry",
        "execution",
        "methodCalls",
        "database",
        "log"
      ], "Job config");
      if (value.schemaVersion !== 1) invalid("Job schemaVersion\uC740 1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      if (!settings.interfaceStore || typeof settings.interfaceStore.find !== "function") {
        invalid("DBus Interface \uC800\uC7A5\uC18C\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
      }
      const limits = settings.limits || {};
      if (!Number.isInteger(limits.maxGeneratedTagsPerCall) || limits.maxGeneratedTagsPerCall < 1 || !Number.isInteger(limits.maxBufferedRowsPerCycle) || limits.maxBufferedRowsPerCycle < 1) {
        invalid("Job validation limits\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      assertObject(value.schedule, "schedule");
      assertFields(value.schedule, ["intervalMs"], "schedule");
      const minimumIntervalMs = Number.isInteger(settings.minimumIntervalMs) ? settings.minimumIntervalMs : 1e3;
      if (!Number.isInteger(value.schedule.intervalMs) || value.schedule.intervalMs < minimumIntervalMs || value.schedule.intervalMs > 864e5) invalid(`schedule.intervalMs\uB294 ${minimumIntervalMs}~86400000 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      const intervalCycleMs = Number.isInteger(settings.intervalCycleMs) && settings.intervalCycleMs > 0 ? settings.intervalCycleMs : 1;
      if (value.schedule.intervalMs < intervalCycleMs || value.schedule.intervalMs % intervalCycleMs !== 0) invalid(`schedule.intervalMs\uB294 ${intervalCycleMs}ms\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      assertObject(value.retry, "retry");
      assertFields(value.retry, ["initialDelayMs", "maximumDelayMs", "multiplier"], "retry");
      if (!Number.isInteger(value.retry.initialDelayMs) || value.retry.initialDelayMs < 1 || !Number.isInteger(value.retry.maximumDelayMs) || value.retry.maximumDelayMs < value.retry.initialDelayMs || value.retry.maximumDelayMs > 864e5 || typeof value.retry.multiplier !== "number" || !Number.isFinite(value.retry.multiplier) || value.retry.multiplier < 1 || value.retry.multiplier > 100) {
        invalid("retry \uC124\uC815 \uBC94\uC704\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      assertObject(value.execution, "execution");
      assertFields(value.execution, ["savePolicy", "onMethodError"], "execution");
      if (!SAVE_POLICIES.has(value.execution.savePolicy) || !METHOD_ERROR_POLICIES.has(value.execution.onMethodError)) invalid("execution policy\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (!Array.isArray(value.methodCalls) || value.methodCalls.length < 1 || value.methodCalls.length > MAX_METHOD_CALLS) {
        invalid(`methodCalls\uB294 1~${MAX_METHOD_CALLS}\uAC1C\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      }
      const callIds = /* @__PURE__ */ new Set();
      const callNames = /* @__PURE__ */ new Set();
      const tagNames = /* @__PURE__ */ new Set();
      const methodCalls = value.methodCalls.map((call) => validateMethodCall(
        call,
        settings.interfaceStore,
        { limits },
        callIds,
        callNames,
        tagNames
      ));
      const rowCount = methodCalls.reduce((sum, call) => sum + (call.outputSelections ? call.outputSelections.reduce((count, selection) => count + selection.tags.length, 0) : call.tags.length), 0);
      if (rowCount > limits.maxBufferedRowsPerCycle) invalid("Job Tag \uC804\uCCB4 \uAC1C\uC218\uAC00 maxBufferedRowsPerCycle\uC744 \uB118\uC5C8\uC2B5\uB2C8\uB2E4.");
      assertObject(value.database, "database");
      assertFields(value.database, ["server", "table", "valueColumn", "stringValueColumn"], "database");
      if (!SAFE_NAME.test(value.database.server || "") || !SQL_IDENTIFIER.test(value.database.table || "") || !SQL_IDENTIFIER.test(value.database.valueColumn || "") || value.database.stringValueColumn !== "" && !SQL_IDENTIFIER.test(value.database.stringValueColumn || "")) invalid("database \uC774\uB984 \uB610\uB294 column \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      assertObject(value.log, "log");
      assertFields(value.log, ["level", "maxFiles"], "log");
      if (!LOG_LEVELS.has(value.log.level) || !Number.isInteger(value.log.maxFiles) || value.log.maxFiles < 1 || value.log.maxFiles > 1e3) invalid("log \uC124\uC815\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      const normalized = clone(value);
      normalized.database.table = normalized.database.table.toUpperCase();
      normalized.methodCalls = methodCalls;
      return normalized;
    }
    module2.exports = {
      CALL_ID,
      JOB_NAME,
      MAX_JOB_JSON_BYTES,
      MAX_JOB_NAME_LENGTH,
      MAX_METHOD_CALLS,
      MAX_TAG_NAME_LENGTH,
      deepMerge,
      isValidJobName,
      validateJobConfig,
      validateJobName
    };
  }
});

// cgi-bin/src/jobs/repository.js
var require_repository = __commonJS({
  "cgi-bin/src/jobs/repository.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { writeJsonAtomic } = require_atomic_json();
    var { error } = require_errors();
    var { validateJobName } = require_validator();
    function invalidConfig(name, documentName, reason) {
      return error("JOB_INVALID_CONFIG", reason || "Job \uD30C\uC77C\uBA85\uACFC document name\uC774 \uB2E4\uB985\uB2C8\uB2E4.", {
        name,
        documentName
      });
    }
    function revisionOf(document) {
      return Number.isSafeInteger(document && document.revision) && document.revision >= 1 ? document.revision : 1;
    }
    var JobRepository = class {
      constructor(options) {
        this.directory = options && options.jobDir || path.join(options.cgiRoot, "conf.d", "jobs");
        fs.mkdirSync(this.directory, { recursive: true });
      }
      file(name) {
        return path.join(this.directory, `${validateJobName(name)}.json`);
      }
      exists(name) {
        return fs.existsSync(this.file(name));
      }
      parse(name) {
        let document;
        try {
          document = JSON.parse(fs.readFileSync(this.file(name), "utf8"));
        } catch (readError) {
          if (readError && readError.code === "ENOENT") {
            throw error("JOB_NOT_FOUND", "Job\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
          }
          throw invalidConfig(name, null, `Job JSON\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${readError.message}`);
        }
        if (!document || typeof document !== "object" || Array.isArray(document)) {
          throw invalidConfig(name, null, "Job document\uB294 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
        }
        if (document.name !== name) throw invalidConfig(name, document.name);
        return document;
      }
      read(name) {
        validateJobName(name);
        return this.parse(name);
      }
      create(name, config) {
        validateJobName(name);
        const file = this.file(name);
        const document = { ...config, name, revision: 1 };
        let descriptor = null;
        try {
          descriptor = fs.openSync(file, "wx");
          fs.writeSync(descriptor, `${JSON.stringify(document, null, 2)}
`);
          if (typeof fs.fsyncSync === "function") fs.fsyncSync(descriptor);
          fs.closeSync(descriptor);
          descriptor = null;
        } catch (writeError) {
          if (descriptor !== null) {
            try {
              fs.closeSync(descriptor);
            } catch (_) {
            }
            try {
              fs.unlinkSync(file);
            } catch (_) {
            }
          }
          if (writeError && writeError.code === "EEXIST") {
            throw error("JOB_ALREADY_EXISTS", "\uAC19\uC740 \uC774\uB984\uC758 Job\uC774 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { name });
          }
          throw writeError;
        }
        return document;
      }
      // LS holds the per-Job mutation lock before calling this method, so the
      // canonical document can be committed with the same atomic file replacement
      // used by Update. This avoids leaving a partially written 1MB Job after an
      // interrupted CGI process.
      createAtomic(name, config) {
        validateJobName(name);
        if (this.exists(name)) throw error("JOB_ALREADY_EXISTS", "\uAC19\uC740 \uC774\uB984\uC758 Job\uC774 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { name });
        const document = { ...config, name, revision: 1 };
        writeJsonAtomic(this.file(name), document);
        return document;
      }
      save(name, document, expectedRevision) {
        validateJobName(name);
        const file = this.file(name);
        const current = this.read(name);
        if (!document || document.name !== name) throw invalidConfig(name, document && document.name);
        const currentRevision = revisionOf(current);
        if (expectedRevision !== currentRevision) {
          throw error("JOB_CONFLICT", "\uB2E4\uB978 \uAD00\uB9AC\uC790\uAC00 Job\uC744 \uC218\uC815\uD588\uC2B5\uB2C8\uB2E4. \uCD5C\uC2E0 \uC124\uC815\uC744 \uB2E4\uC2DC \uC77D\uC740 \uB4A4 \uC218\uC815\uD558\uC138\uC694.", {
            name,
            expectedRevision,
            currentRevision
          });
        }
        writeJsonAtomic(file, document);
        return document;
      }
      remove(name) {
        this.read(name);
        fs.unlinkSync(this.file(name));
        return { name };
      }
      discard(name) {
        const file = this.file(name);
        try {
          fs.unlinkSync(file);
        } catch (failure) {
          if (!failure || failure.code !== "ENOENT") throw failure;
        }
        return { name };
      }
      list() {
        if (!fs.existsSync(this.directory)) return [];
        return fs.readdirSync(this.directory).filter((entry) => entry.endsWith(".json")).sort().map((entry) => {
          const name = entry.slice(0, -5);
          try {
            validateJobName(name);
            const document = this.read(name);
            return { name, document, documentName: document.name, error: null };
          } catch (readError) {
            let documentName = null;
            try {
              documentName = JSON.parse(fs.readFileSync(path.join(this.directory, entry), "utf8")).name;
            } catch (_) {
            }
            return { name, document: null, documentName, error: readError };
          }
        });
      }
    };
    module2.exports = { JobRepository, revisionOf };
  }
});

// cgi-bin/src/jobs/operation-lock.js
var require_operation_lock = __commonJS({
  "cgi-bin/src/jobs/operation-lock.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var process = require("process");
    var { error } = require_errors();
    var DEFAULT_LEASE_MS = 30 * 1e3;
    var DEFAULT_HEARTBEAT_MS = 5 * 1e3;
    var MAX_ACQUIRE_ATTEMPTS = 8;
    function defaultToken() {
      return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    function jobConflict(name) {
      return error("JOB_CONFLICT", "\uB2E4\uB978 \uC694\uCCAD\uC774 \uAC19\uC740 Job\uC744 \uBCC0\uACBD\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.", { name });
    }
    function defaultIsProcessAlive(pid) {
      try {
        const result = process.kill(pid, 0);
        return !isConfirmedMissingProcess(result);
      } catch (failure) {
        return !isConfirmedMissingProcess(failure);
      }
    }
    function isConfirmedMissingProcess(result) {
      if (result === false || Boolean(result && result.code === "ESRCH")) return true;
      let message = "";
      try {
        message = String(result && result.message ? result.message : result || "");
      } catch (_) {
      }
      return /\b(?:no such process|process already finished)\b/i.test(message);
    }
    function createJobOperationLock(options) {
      const settings = options || {};
      const fileSystem = settings.fs || fs;
      const directory = settings.directory || path.join(settings.cgiRoot, "conf.d", ".job-operation-locks");
      const now = settings.now || Date.now;
      const randomToken = settings.randomToken || defaultToken;
      const randomReclaimToken = settings.randomReclaimToken || defaultToken;
      const startTimer = settings.setInterval || setInterval;
      const stopTimer = settings.clearInterval || clearInterval;
      const isProcessAlive = settings.isProcessAlive || defaultIsProcessAlive;
      const leaseMs = settings.leaseMs === void 0 ? DEFAULT_LEASE_MS : settings.leaseMs;
      const heartbeatMs = settings.heartbeatMs === void 0 ? DEFAULT_HEARTBEAT_MS : settings.heartbeatMs;
      fileSystem.mkdirSync(directory, { recursive: true });
      function isMissing(failure) {
        return Boolean(failure && failure.code === "ENOENT");
      }
      function isAlreadyPresent(failure, target) {
        if (failure && failure.code === "EEXIST") return true;
        try {
          return fileSystem.existsSync(target);
        } catch (_) {
          return false;
        }
      }
      function modifiedAt(target) {
        const stat = fileSystem.statSync(target);
        if (stat.mtime && typeof stat.mtime.unixMilli === "function") {
          const value = stat.mtime.unixMilli();
          if (Number.isFinite(value)) return value;
        }
        if (stat.mtime && typeof stat.mtime.getTime === "function") {
          const value = stat.mtime.getTime();
          if (Number.isFinite(value)) return value;
        }
        return null;
      }
      function isDirectory(target) {
        const stat = fileSystem.statSync(target);
        return typeof stat.isDirectory === "function" ? stat.isDirectory() : Boolean(stat.isDirectory);
      }
      function isValidOwner(owner) {
        return Boolean(owner) && typeof owner.token === "string" && owner.token.length > 0 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isFinite(owner.acquiredAt) && Number.isFinite(owner.heartbeatAt) && owner.heartbeatAt >= owner.acquiredAt;
      }
      function writeAll(descriptor, content) {
        let remaining = content;
        while (remaining.length > 0) {
          const count = fileSystem.writeSync(descriptor, remaining);
          if (!Number.isInteger(count) || count <= 0 || count > remaining.length) {
            const failure = new Error("lock \uBB38\uC11C\uB97C \uB05D\uAE4C\uC9C0 \uAE30\uB85D\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
            failure.code = "EIO";
            throw failure;
          }
          remaining = remaining.slice(count);
        }
      }
      function unlinkIfPresent(target) {
        try {
          fileSystem.unlinkSync(target);
          return true;
        } catch (failure) {
          if (isMissing(failure)) return false;
          throw failure;
        }
      }
      function writeExclusive(target, document) {
        let descriptor;
        let created = false;
        try {
          descriptor = fileSystem.openSync(target, "wx", 384);
          created = true;
          writeAll(descriptor, `${JSON.stringify(document)}
`);
          if (typeof fileSystem.fsyncSync === "function") fileSystem.fsyncSync(descriptor);
          fileSystem.closeSync(descriptor);
          descriptor = void 0;
        } catch (failure) {
          if (descriptor !== void 0) {
            try {
              fileSystem.closeSync(descriptor);
            } catch (closeFailure) {
              failure.closeError = closeFailure;
            }
          }
          if (created) {
            try {
              unlinkIfPresent(target);
            } catch (cleanupFailure) {
              failure.cleanupError = cleanupFailure;
            }
          }
          throw failure;
        }
      }
      function ownerDocument(token, timestamp) {
        return {
          token,
          pid: process.pid,
          acquiredAt: timestamp,
          heartbeatAt: timestamp
        };
      }
      function readJsonOwner(target) {
        try {
          const owner = JSON.parse(fileSystem.readFileSync(target, "utf8"));
          return isValidOwner(owner) ? owner : null;
        } catch (_) {
          return null;
        }
      }
      function normalizedEntries(target) {
        return fileSystem.readdirSync(target).filter((entry) => entry !== "." && entry !== "..");
      }
      function newestModifiedAt(target, entries) {
        let newest = modifiedAt(target);
        for (const entry of entries || []) {
          try {
            const value = modifiedAt(path.join(target, entry));
            if (Number.isFinite(value) && (!Number.isFinite(newest) || value > newest)) newest = value;
          } catch (_) {
          }
        }
        return newest;
      }
      function inspectLegacyLock(lockPath) {
        let entries;
        try {
          entries = normalizedEntries(lockPath);
        } catch (failure) {
          if (isMissing(failure)) return { missing: true };
          throw failure;
        }
        const ownerFiles = entries.filter((entry) => /^owner.*\.json$/.test(entry));
        const temporaryFiles = entries.filter((entry) => /^owner\.json\.tmp-/.test(entry));
        const heartbeatFiles = entries.filter((entry) => /^heartbeat-/.test(entry));
        const unexpected = entries.filter((entry) => !ownerFiles.includes(entry) && !temporaryFiles.includes(entry) && !heartbeatFiles.includes(entry));
        const lastModified = newestModifiedAt(lockPath, entries);
        if (!entries.includes("owner.json")) {
          return ownerFiles.length === 0 && unexpected.length === 0 ? { missing: false, type: "legacy-directory", incomplete: true, entries, lastActivity: lastModified } : { missing: false, type: "legacy-directory", ambiguous: true, entries, lastActivity: lastModified };
        }
        if (ownerFiles.length !== 1 || temporaryFiles.length !== 0 || unexpected.length !== 0) {
          return { missing: false, type: "legacy-directory", ambiguous: true, entries, lastActivity: lastModified };
        }
        const owner = readJsonOwner(path.join(lockPath, "owner.json"));
        if (!owner) return { missing: false, type: "legacy-directory", incomplete: true, entries, lastActivity: lastModified };
        let heartbeat = owner.heartbeatAt;
        try {
          const value = Number(String(fileSystem.readFileSync(
            path.join(lockPath, `heartbeat-${encodeURIComponent(owner.token)}`),
            "utf8"
          )).trim());
          if (Number.isFinite(value) && value >= owner.acquiredAt) heartbeat = value;
        } catch (_) {
        }
        return { missing: false, type: "legacy-directory", owner, entries, lastActivity: heartbeat };
      }
      function inspectLock(lockPath) {
        try {
          if (isDirectory(lockPath)) return inspectLegacyLock(lockPath);
        } catch (failure) {
          if (isMissing(failure)) return { missing: true };
          throw failure;
        }
        let lastActivity;
        try {
          lastActivity = modifiedAt(lockPath);
        } catch (failure) {
          if (isMissing(failure)) return { missing: true };
          throw failure;
        }
        const owner = readJsonOwner(lockPath);
        if (!owner) return { missing: false, type: "file", incomplete: true, lastActivity };
        return { missing: false, type: "file", owner, lastActivity: owner.heartbeatAt };
      }
      function requireReclaimable(state, name) {
        if (!state || state.missing) return;
        if (state.ambiguous) throw jobConflict(name);
        if (!Number.isFinite(state.lastActivity) || now() - state.lastActivity < leaseMs) throw jobConflict(name);
        if (state.incomplete) return;
        let alive = true;
        try {
          alive = isProcessAlive(state.owner.pid);
        } catch (_) {
          alive = true;
        }
        if (!isConfirmedMissingProcess(alive)) throw jobConflict(name);
      }
      function guardOwnerFile(guardPath) {
        return path.join(guardPath, "owner.json");
      }
      function guardClaimFile(guardPath, token) {
        return path.join(guardPath, `claim-${encodeURIComponent(token)}.json`);
      }
      function writeExisting(target, document) {
        let descriptor;
        try {
          descriptor = fileSystem.openSync(target, "w", 384);
          if (typeof fileSystem.fchmodSync === "function") fileSystem.fchmodSync(descriptor, 384);
          writeAll(descriptor, `${JSON.stringify(document)}
`);
          if (typeof fileSystem.fsyncSync === "function") fileSystem.fsyncSync(descriptor);
          fileSystem.closeSync(descriptor);
          descriptor = void 0;
        } catch (failure) {
          if (descriptor !== void 0) {
            try {
              fileSystem.closeSync(descriptor);
            } catch (closeFailure) {
              failure.closeError = closeFailure;
            }
          }
          throw failure;
        }
      }
      function inspectGuard(guardPath) {
        let entries;
        try {
          entries = normalizedEntries(guardPath);
        } catch (failure) {
          if (isMissing(failure)) return { missing: true };
          throw failure;
        }
        const lastActivity = newestModifiedAt(guardPath, entries);
        if (entries.length === 0) return { missing: false, empty: true, entries, lastActivity };
        if (entries.length !== 1) {
          return { missing: false, ambiguous: true, entries, lastActivity };
        }
        const entry = entries[0];
        const isOwner = entry === "owner.json";
        const isClaim = /^claim-.*\.json$/.test(entry);
        if (!isOwner && !isClaim) return { missing: false, ambiguous: true, entries, lastActivity };
        const owner = readJsonOwner(path.join(guardPath, entry));
        if (!owner || isClaim && entry !== path.basename(guardClaimFile(guardPath, owner.token))) {
          return { missing: false, incomplete: true, entry, entries, lastActivity };
        }
        return { missing: false, owner, entry, entries, lastActivity: owner.heartbeatAt };
      }
      function releaseGuard(guardPath, ownerPath, token) {
        const current = readJsonOwner(ownerPath);
        if (!current || current.token !== token) return;
        try {
          if (!unlinkIfPresent(ownerPath)) return;
        } catch (_) {
          return;
        }
        try {
          fileSystem.rmdirSync(guardPath);
        } catch (_) {
        }
      }
      function acquireGuard(guardPath, name) {
        for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
          try {
            fileSystem.mkdirSync(guardPath);
          } catch (failure) {
            if (!isAlreadyPresent(failure, guardPath)) throw failure;
          }
          const state = inspectGuard(guardPath);
          if (state.missing) continue;
          if (state.empty) {
            const token2 = randomReclaimToken();
            const ownerPath = guardOwnerFile(guardPath);
            try {
              writeExclusive(ownerPath, ownerDocument(token2, now()));
              return { token: token2, release() {
                releaseGuard(guardPath, ownerPath, token2);
              } };
            } catch (failure) {
              if (isAlreadyPresent(failure, ownerPath) || isMissing(failure)) continue;
              throw failure;
            }
          }
          requireReclaimable(state, name);
          const current = inspectGuard(guardPath);
          if (current.missing || current.empty) continue;
          requireReclaimable(current, name);
          if (state.entry !== current.entry) throw jobConflict(name);
          if (state.owner && (!current.owner || current.owner.token !== state.owner.token)) throw jobConflict(name);
          const currentPath = path.join(guardPath, current.entry);
          if (current.entry !== "owner.json") {
            if (!unlinkIfPresent(currentPath)) continue;
            continue;
          }
          const token = randomReclaimToken();
          const claimPath = guardClaimFile(guardPath, token);
          try {
            fileSystem.renameSync(currentPath, claimPath);
          } catch (failure) {
            if (isMissing(failure)) continue;
            throw failure;
          }
          try {
            writeExisting(claimPath, ownerDocument(token, now()));
          } catch (failure) {
            throw failure;
          }
          return { token, release() {
            releaseGuard(guardPath, claimPath, token);
          } };
        }
        throw jobConflict(name);
      }
      function removeLegacyLock(lockPath, expected, name) {
        const current = inspectLegacyLock(lockPath);
        requireReclaimable(current, name);
        if (expected.owner && (!current.owner || current.owner.token !== expected.owner.token)) throw jobConflict(name);
        if (current.ambiguous) throw jobConflict(name);
        for (const entry of current.entries || []) {
          const target = path.join(lockPath, entry);
          try {
            if (isDirectory(target)) throw jobConflict(name);
          } catch (failure) {
            if (failure && failure.code === "JOB_CONFLICT") throw failure;
            if (!isMissing(failure)) throw failure;
            continue;
          }
          unlinkIfPresent(target);
        }
        try {
          fileSystem.rmdirSync(lockPath);
        } catch (failure) {
          if (!isMissing(failure)) throw failure;
        }
      }
      function removeStaleLock(lockPath, state, name) {
        const current = inspectLock(lockPath);
        if (current.missing) return;
        requireReclaimable(current, name);
        if (state.owner && (!current.owner || current.owner.token !== state.owner.token)) throw jobConflict(name);
        if (current.type === "legacy-directory") removeLegacyLock(lockPath, current, name);
        else unlinkIfPresent(lockPath);
      }
      function readOwnedFile(lockPath, name, token) {
        const state = inspectLock(lockPath);
        if (state.missing || state.type !== "file" || !state.owner || state.owner.token !== token) throw jobConflict(name);
        return state.owner;
      }
      function replaceOwner(lockPath, name, token, owner) {
        const temporaryPath = `${lockPath}.tmp-${defaultToken()}`;
        try {
          writeExclusive(temporaryPath, owner);
          readOwnedFile(lockPath, name, token);
          fileSystem.renameSync(temporaryPath, lockPath);
        } catch (failure) {
          try {
            unlinkIfPresent(temporaryPath);
          } catch (cleanupFailure) {
            failure.cleanupError = cleanupFailure;
          }
          throw failure;
        }
      }
      function removeOwnedFile(lockPath, name, token) {
        let owner;
        try {
          owner = readOwnedFile(lockPath, name, token);
        } catch (_) {
          return false;
        }
        if (owner.token !== token) return false;
        return unlinkIfPresent(lockPath);
      }
      function createHandle(name, lockPath, token) {
        function assertOwned() {
          readOwnedFile(lockPath, name, token);
        }
        let timer;
        try {
          timer = startTimer(() => {
            try {
              const owner = readOwnedFile(lockPath, name, token);
              replaceOwner(lockPath, name, token, { ...owner, heartbeatAt: now() });
            } catch (_) {
            }
          }, heartbeatMs);
        } catch (failure) {
          try {
            removeOwnedFile(lockPath, name, token);
          } catch (cleanupFailure) {
            failure.cleanupError = cleanupFailure;
          }
          throw failure;
        }
        function release() {
          let timerFailure = null;
          try {
            stopTimer(timer);
          } catch (failure) {
            timerFailure = failure;
          }
          removeOwnedFile(lockPath, name, token);
          if (timerFailure) throw timerFailure;
        }
        return { token, assertOwned, release };
      }
      function acquire(name) {
        const lockPath = path.join(directory, `${name}.lock`);
        const guardPath = `${lockPath}.reclaim`;
        const guard = acquireGuard(guardPath, name);
        let handle;
        try {
          const state = inspectLock(lockPath);
          if (!state.missing) {
            requireReclaimable(state, name);
            removeStaleLock(lockPath, state, name);
          }
          const token = randomToken();
          const timestamp = now();
          try {
            writeExclusive(lockPath, ownerDocument(token, timestamp));
          } catch (failure) {
            if (isAlreadyPresent(failure, lockPath)) throw jobConflict(name);
            throw failure;
          }
          handle = createHandle(name, lockPath, token);
        } finally {
          guard.release();
        }
        return handle;
      }
      function assertAvailable(name) {
        const state = inspectLock(path.join(directory, `${name}.lock`));
        if (!state.missing) requireReclaimable(state, name);
      }
      return { acquire, assertAvailable };
    }
    module2.exports = { createJobOperationLock };
  }
});

// cgi-bin/src/db/server-store.js
var require_server_store = __commonJS({
  "cgi-bin/src/db/server-store.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { writeJsonAtomic } = require_atomic_json();
    var { error } = require_errors();
    var { createJobOperationLock } = require_operation_lock();
    var SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
    var JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
    var SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
    var MAX_SERVER_JSON_BYTES = 64 * 1024;
    function validateName(name) {
      if (typeof name !== "string" || !SERVER_NAME.test(name) || /[\\/]/.test(name)) {
        throw error("DB_SERVER_INVALID", "DB server name \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      return name;
    }
    function validateDocument(name, value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw error("DB_SERVER_INVALID", "\uB4F1\uB85D DB server \uC124\uC815\uC740 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.", { name });
      }
      if (value.schemaVersion !== 1 || value.name !== name) {
        throw error("DB_SERVER_INVALID", "\uB4F1\uB85D DB server\uC758 schemaVersion \uB610\uB294 name\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { name });
      }
      if (typeof value.host !== "string" || !value.host.trim() || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.user !== "string" || !value.user || typeof value.password !== "string" || !value.password || typeof value.defaultTable !== "string" || typeof value.valueColumn !== "string" || typeof value.stringValueColumn !== "string") {
        throw error("DB_SERVER_INVALID", "\uB4F1\uB85D DB server \uC5F0\uACB0 \uC124\uC815\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { name });
      }
      return value;
    }
    function createServerStore(options) {
      const settings = options || {};
      const directory = settings.directory || path.join(settings.cgiRoot, "conf.d", "db-servers");
      const jobDirectory = settings.jobDir || (settings.cgiRoot ? path.join(settings.cgiRoot, "conf.d", "jobs") : path.join(path.dirname(directory), "jobs"));
      const atomicWriter = settings.atomicWriter || writeJsonAtomic;
      const operationLock = settings.operationLock || createJobOperationLock({
        directory: settings.lockDirectory || path.join(directory, ".operation-locks")
      });
      function file(name) {
        return path.join(directory, `${validateName(name)}.json`);
      }
      function read(name) {
        const validName = validateName(name);
        let source;
        try {
          source = fs.readFileSync(file(validName), "utf8");
        } catch (readError) {
          if (readError && readError.code === "ENOENT") return null;
          throw readError;
        }
        if (source.length > MAX_SERVER_JSON_BYTES) {
          throw error("DB_SERVER_INVALID", `\uB4F1\uB85D DB server JSON\uC740 ${MAX_SERVER_JSON_BYTES} bytes \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.`, {
            name: validName
          });
        }
        try {
          const document = validateDocument(validName, {
            defaultTable: "",
            valueColumn: "",
            stringValueColumn: "",
            ...JSON.parse(source)
          });
          if (document.defaultTable && !document.valueColumn) document.valueColumn = "VALUE";
          return document;
        } catch (parseError) {
          if (parseError && parseError.code) throw parseError;
          throw error("DB_SERVER_INVALID", "\uB4F1\uB85D DB server JSON\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name: validName });
        }
      }
      function publicValue(value) {
        if (!value) return null;
        return {
          schemaVersion: value.schemaVersion,
          name: value.name,
          host: value.host,
          port: value.port,
          user: value.user,
          hasPassword: Boolean(value.password),
          defaultTable: value.defaultTable,
          valueColumn: value.valueColumn,
          stringValueColumn: value.stringValueColumn
        };
      }
      function documentFrom(payload, current) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw error("DB_SERVER_INVALID", "DB server \uC694\uCCAD\uC740 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
        }
        const name = validateName(current ? current.name : payload.name);
        const defaultTable = typeof payload.defaultTable === "string" ? payload.defaultTable.toUpperCase() : "";
        return validateDocument(name, {
          schemaVersion: 1,
          name,
          host: payload.host,
          port: Number(payload.port),
          user: payload.user,
          password: payload.password,
          defaultTable,
          valueColumn: typeof payload.valueColumn === "string" && payload.valueColumn.trim() ? payload.valueColumn.toUpperCase() : defaultTable ? "VALUE" : "",
          stringValueColumn: typeof payload.stringValueColumn === "string" ? payload.stringValueColumn.toUpperCase() : ""
        });
      }
      function ensureLocalhost() {
        const name = "localhost";
        if (read(name)) return;
        fs.mkdirSync(directory, { recursive: true });
        atomicWriter(file(name), validateDocument(name, {
          schemaVersion: 1,
          name,
          host: "127.0.0.1",
          port: 5656,
          user: "sys",
          password: "manager",
          defaultTable: "DEFAULT_DBUS",
          valueColumn: "VALUE",
          stringValueColumn: ""
        }));
      }
      function referencedJobs(name) {
        let entries;
        try {
          entries = fs.readdirSync(jobDirectory);
        } catch (readError) {
          if (readError && readError.code === "ENOENT") return [];
          throw error("DB_SERVER_REFERENCE_UNKNOWN", "Job \uCC38\uC870 \uBAA9\uB85D\uC744 \uC77D\uC744 \uC218 \uC5C6\uC5B4 DB server \uC0AD\uC81C\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.", {
            problem: "directory-read-failed"
          });
        }
        return entries.filter((entry) => entry.endsWith(".json")).sort().reduce((result, entry) => {
          const stem = entry.slice(0, -5);
          if (!JOB_NAME.test(stem)) {
            throw error("DB_SERVER_REFERENCE_UNKNOWN", "Job \uCC38\uC870 \uC0C1\uD0DC\uB97C \uC548\uC804\uD558\uAC8C \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
              file: entry,
              problem: "invalid-file-name"
            });
          }
          let source;
          try {
            source = fs.readFileSync(path.join(jobDirectory, entry), "utf8");
          } catch (_) {
            throw error("DB_SERVER_REFERENCE_UNKNOWN", "Job \uCC38\uC870 \uD30C\uC77C\uC744 \uC77D\uC744 \uC218 \uC5C6\uC5B4 DB server \uC0AD\uC81C\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.", {
              file: entry,
              problem: "read-failed"
            });
          }
          let document;
          try {
            document = JSON.parse(source);
          } catch (_) {
            throw error("DB_SERVER_REFERENCE_UNKNOWN", "Job \uCC38\uC870 JSON\uC744 \uD574\uC11D\uD560 \uC218 \uC5C6\uC5B4 DB server \uC0AD\uC81C\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.", {
              file: entry,
              problem: "invalid-json"
            });
          }
          if (!document || typeof document !== "object" || Array.isArray(document) || document.schemaVersion !== 1 || document.name !== stem || !document.database || typeof document.database !== "object" || Array.isArray(document.database) || typeof document.database.server !== "string" || !document.database.server) {
            throw error("DB_SERVER_REFERENCE_UNKNOWN", "Job \uCC38\uC870 schema\uB97C \uD655\uC778\uD560 \uC218 \uC5C6\uC5B4 DB server \uC0AD\uC81C\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.", {
              file: entry,
              problem: document && document.name !== stem ? "name-mismatch" : "invalid-schema"
            });
          }
          if (document.database.server === name) result.push(stem);
          return result;
        }, []);
      }
      function complete(callback, operation) {
        try {
          callback(null, operation());
        } catch (failure) {
          callback(failure);
        }
      }
      function withLock(name, callback, operation) {
        let handle;
        try {
          handle = operationLock.acquire(`db-server-${validateName(name)}`);
          const value = operation(handle);
          handle.release();
          handle = null;
          callback(null, value);
        } catch (failure) {
          if (handle) {
            try {
              handle.release();
            } catch (cleanupError) {
              failure.cleanupError = cleanupError;
            }
          }
          callback(failure);
        }
      }
      return {
        get(name, callback) {
          complete(callback, () => read(name));
        },
        getPublic(name, callback) {
          complete(callback, () => {
            const value = read(name);
            if (!value) throw error("DB_SERVER_NOT_FOUND", "\uB4F1\uB85D DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
            return publicValue(value);
          });
        },
        list(callback) {
          complete(callback, () => {
            ensureLocalhost();
            let entries;
            try {
              entries = fs.readdirSync(directory);
            } catch (readError) {
              if (readError && readError.code === "ENOENT") return [];
              throw readError;
            }
            return entries.filter((entry) => entry.endsWith(".json")).sort().map((entry) => publicValue(read(entry.slice(0, -5))));
          });
        },
        create(payload, callback) {
          let document;
          try {
            document = documentFrom(payload, null);
          } catch (failure) {
            callback(failure);
            return;
          }
          withLock(document.name, (failure, value) => {
            if (failure && failure.code === "JOB_CONFLICT") {
              callback(error("DB_SERVER_CREATE_LOCKED", "\uAC19\uC740 \uC774\uB984\uC758 DB server \uC0DD\uC131\uC774 \uC774\uBBF8 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4.", {
                name: document.name
              }));
              return;
            }
            callback(failure, value);
          }, (handle) => {
            if (fs.existsSync(file(document.name))) {
              throw error("DB_SERVER_ALREADY_EXISTS", "\uAC19\uC740 \uC774\uB984\uC758 DB server\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { name: document.name });
            }
            handle.assertOwned();
            atomicWriter(file(document.name), document);
            return publicValue(document);
          });
        },
        update(name, payload, callback) {
          withLock(name, callback, (handle) => {
            const current = read(name);
            if (!current) throw error("DB_SERVER_NOT_FOUND", "\uB4F1\uB85D DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
            const document = documentFrom(payload, current);
            handle.assertOwned();
            writeJsonAtomic(file(name), document);
            return publicValue(document);
          });
        },
        setDefaultTableColumns(name, table, valueColumn, stringValueColumn, callback) {
          withLock(name, callback, (handle) => {
            const current = read(name);
            if (!current) throw error("DB_SERVER_NOT_FOUND", "\uB4F1\uB85D DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
            const normalizedTable = String(table || "").trim().toUpperCase();
            const normalizedValue = String(valueColumn || "").trim().toUpperCase();
            const normalizedStringValue = String(stringValueColumn || "").trim().toUpperCase();
            if (!SQL_IDENTIFIER.test(normalizedTable) || !SQL_IDENTIFIER.test(normalizedValue) || normalizedStringValue && !SQL_IDENTIFIER.test(normalizedStringValue)) {
              throw error("DB_SERVER_INVALID", "\uAE30\uBCF8 Table column \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { name });
            }
            if (String(current.defaultTable || "").toUpperCase() !== normalizedTable) return publicValue(current);
            const document = validateDocument(current.name, {
              ...current,
              valueColumn: normalizedValue,
              stringValueColumn: normalizedStringValue
            });
            handle.assertOwned();
            writeJsonAtomic(file(current.name), document);
            return publicValue(document);
          });
        },
        remove(name, callback) {
          withLock(name, callback, (handle) => {
            const current = read(name);
            if (!current) throw error("DB_SERVER_NOT_FOUND", "\uB4F1\uB85D DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
            const jobs = referencedJobs(current.name);
            if (jobs.length) {
              throw error("DB_SERVER_IN_USE", "Job\uC774 \uC0AC\uC6A9\uD558\uB294 DB server\uB294 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
                name: current.name,
                jobs
              });
            }
            handle.assertOwned();
            fs.unlinkSync(file(current.name));
            return { name: current.name };
          });
        }
      };
    }
    module2.exports = { MAX_SERVER_JSON_BYTES, createServerStore };
  }
});

// cgi-bin/src/db/data-viewer.js
var require_data_viewer = __commonJS({
  "cgi-bin/src/db/data-viewer.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var { JobRepository } = require_repository();
    var { createServerStore } = require_server_store();
    var IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
    var JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
    var MAX_NAMES = 100;
    var MAX_ROWS_PER_TAG = 1e3;
    var MAX_TOTAL_ROWS = 1e6;
    var MAX_TAGS = 1e3;
    var FLAG_BASETIME = 16777216;
    var FLAG_SUMMARIZED = 33554432;
    var FLAG_METADATA = 67108864;
    var FLAG_PRIMARY = 134217728;
    var TYPE_NAMES = {
      4: "short",
      104: "ushort",
      8: "integer",
      108: "uinteger",
      12: "long",
      112: "ulong",
      6: "datetime",
      16: "float",
      20: "double",
      5: "varchar",
      49: "text",
      53: "clob",
      57: "blob",
      97: "binary",
      32: "ipv4",
      36: "ipv6",
      61: "json"
    };
    var NUMERIC_TYPES = /* @__PURE__ */ new Set([4, 104, 8, 108, 12, 112, 16, 20]);
    var STRING_TYPES = /* @__PURE__ */ new Set([5, 49, 53]);
    var HIERARCHY_TAG_NAME = "__machbase_hierarchy__";
    function invalid(reason, details) {
      return error("DB_REQUEST_INVALID", reason, details);
    }
    function tableInvalid(reason, details) {
      return error("TABLE_INVALID", reason, details);
    }
    function identifier(value, label) {
      const result = String(value === void 0 || value === null ? "" : value).trim().toUpperCase();
      if (!IDENTIFIER.test(result)) throw invalid(`${label} \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`);
      return result;
    }
    function qualifiedTable(value) {
      const parts = String(value || "").trim().split(".");
      if (parts.length < 1 || parts.length > 2 || parts.some((part) => !IDENTIFIER.test(part))) {
        throw invalid("table\uC740 TABLE \uB610\uB294 USER.TABLE \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      }
      const normalized = parts.map((part) => part.toUpperCase());
      return {
        table: normalized.join("."),
        tableName: normalized[normalized.length - 1],
        tableUser: normalized.length === 2 ? normalized[0] : null
      };
    }
    function positiveInteger(value, fallback, maximum, label) {
      const number = value === void 0 || value === null || value === "" ? fallback : Number(value);
      if (!Number.isInteger(number) || number < 1 || number > maximum) {
        throw invalid(`${label}\uC740 1~${maximum} \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      }
      return number;
    }
    function optionalDate(value, label) {
      if (value === void 0 || value === null || value === "") return null;
      const source = String(value);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(source)) {
        throw invalid(`${label} \uC2DC\uAC04\uC740 UTC ISO-8601 \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.`);
      }
      const result = new Date(source);
      if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 19) !== source.slice(0, 19)) {
        throw invalid(`${label} \uC2DC\uAC04 \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`);
      }
      return result;
    }
    function timezone(params) {
      if (Object.prototype.hasOwnProperty.call(params, "timezone")) {
        throw error("TIMEZONE_UNSUPPORTED", "v1 DataViewer\uB294 UTC\uB9CC \uC0AC\uC6A9\uD558\uBA70 timezone \uD30C\uB77C\uBBF8\uD130\uB97C \uBC1B\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", { timezone: String(params.timezone) });
      }
      return "UTC";
    }
    function escapeSqlString(value) {
      return String(value === void 0 || value === null ? "" : value).replace(/'/g, "''");
    }
    function formatSqlDateLiteral(value) {
      if (!(value instanceof Date)) return "";
      const iso = value.toISOString().replace("T", " ").replace("Z", "");
      return `to_date('${escapeSqlString(iso)}')`;
    }
    function namesOf(value) {
      const source = Array.isArray(value) ? value : String(value || "").split(",");
      const names = [];
      source.forEach((item) => {
        const name = String(item || "").trim();
        if (name && !names.includes(name)) names.push(name);
      });
      if (!names.length) throw invalid("Tag name\uC774 \uD558\uB098 \uC774\uC0C1 \uD544\uC694\uD569\uB2C8\uB2E4.");
      if (names.length > MAX_NAMES) throw invalid(`Tag name\uC740 \uCD5C\uB300 ${MAX_NAMES}\uAC1C\uAE4C\uC9C0 \uC694\uCCAD\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`);
      return names;
    }
    function jobName(value) {
      const name = String(value || "");
      if (!JOB_NAME.test(name) || /[\\/]/.test(name)) throw invalid("job name \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      return name;
    }
    function typeName(row) {
      const code = Number(row.TYPE === void 0 ? row.type : row.TYPE);
      const base = TYPE_NAMES[code] || `type-${code}`;
      const length = Number(row.LENGTH === void 0 ? row.length : row.LENGTH) || 0;
      return code === 5 ? `${base}(${length})` : base;
    }
    function mapColumn(row) {
      const code = Number(row.TYPE === void 0 ? row.type : row.TYPE);
      const flag = Number(row.FLAG === void 0 ? row.flag : row.FLAG) || 0;
      return {
        name: identifier(row.NAME === void 0 ? row.name : row.NAME, "metadata column"),
        type: typeName(row),
        primaryKey: Boolean(flag & FLAG_PRIMARY),
        basetime: Boolean(flag & FLAG_BASETIME),
        summarized: Boolean(flag & FLAG_SUMMARIZED),
        metadata: Boolean(flag & FLAG_METADATA),
        numeric: NUMERIC_TYPES.has(code),
        string: STRING_TYPES.has(code)
      };
    }
    function serverConnectionConfig(server) {
      return { host: server.host, port: server.port, user: server.user, password: server.password };
    }
    function defaultConnectionFactory(config) {
      const machcli = require("machcli");
      if (!machcli || typeof machcli.Client !== "function") throw new Error("machcli.Client\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const client = new machcli.Client(config);
      let connection;
      try {
        connection = client.connect();
      } catch (failure) {
        try {
          if (client && typeof client.close === "function") client.close();
        } catch (_) {
        }
        throw failure;
      }
      return {
        query(sql, ...values) {
          return connection.query(sql, ...values);
        },
        exec(sql, ...values) {
          return connection.exec(sql, ...values);
        },
        close() {
          try {
            if (connection && typeof connection.close === "function") connection.close();
          } catch (_) {
          }
          try {
            if (client && typeof client.close === "function") client.close();
          } catch (_) {
          }
        }
      };
    }
    function rowsOf(source) {
      try {
        if (Array.isArray(source)) return source;
        const rows = [];
        if (source) for (const row of source) rows.push(row);
        return rows;
      } finally {
        if (source && typeof source.close === "function") source.close();
      }
    }
    function rowValue(row, name) {
      if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
      const lower = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(row, lower)) return row[lower];
      return null;
    }
    function pickRowValue(row, names) {
      for (const name of names || []) {
        if (Object.prototype.hasOwnProperty.call(row || {}, name)) return row[name];
        const match = Object.keys(row || {}).find((key) => key.toUpperCase() === String(name).toUpperCase());
        if (match) return row[match];
      }
      return void 0;
    }
    function parseJsonObject(value) {
      if (value === void 0 || value === null || value === "") return null;
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      if (typeof value !== "string") return null;
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch (_) {
        return null;
      }
    }
    function normalizeAssetHierarchy(value) {
      const parsed = parseJsonObject(value);
      if (!parsed || !Array.isArray(parsed.schema) || !Array.isArray(parsed.tree)) return null;
      const column = String(parsed.column || "asset").trim() || "asset";
      const schema = parsed.schema.map((item) => String(item || "").trim()).filter(Boolean);
      if (!schema.length || schema.length !== parsed.schema.length || new Set(schema).size !== schema.length) return null;
      return { column, schema, tree: parsed.tree };
    }
    function findAssetHierarchy(row) {
      for (const value of Object.values(row || {})) {
        const hierarchy = normalizeAssetHierarchy(value);
        if (hierarchy) return hierarchy;
      }
      return null;
    }
    function mapTagMetaRows(rows, assetHierarchy, primaryColumn) {
      const assetColumn = assetHierarchy ? assetHierarchy.column : "";
      const tags = [];
      for (const row of rows || []) {
        const name = pickRowValue(row, [primaryColumn]);
        if (name === void 0 || name === null || name === "" || String(name) === HIERARCHY_TAG_NAME) continue;
        const id = pickRowValue(row, ["_ID", "ID"]);
        const tag = { id: id === void 0 || id === null ? null : String(id), name: String(name) };
        const asset = parseJsonObject(pickRowValue(row, [assetColumn]));
        if (asset) tag.asset = asset;
        tags.push(tag);
      }
      return tags;
    }
    function encodeCursor(value) {
      return encodeURIComponent(JSON.stringify(value));
    }
    function decodeCursor(value) {
      if (!value) return { side: "next", page: 0 };
      try {
        const parsed = JSON.parse(decodeURIComponent(String(value)));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
        const keys = Object.keys(parsed);
        if (keys.length !== 2 || !keys.includes("side") || !keys.includes("page")) throw new Error("cursor fields");
        if (parsed.side !== "next" && parsed.side !== "previous") throw new Error("invalid cursor side");
        if (!Number.isSafeInteger(parsed.page) || parsed.page < 0) throw new Error("invalid cursor page");
        return parsed;
      } catch (_) {
        throw invalid("cursor \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
    }
    function createDataViewer(options) {
      const settings = options || {};
      const store = settings.serverStore || createServerStore({ cgiRoot: settings.cgiRoot });
      const jobScopedTags = settings.productPolicy?.target === "ls";
      let jobs = settings.jobRepository || null;
      const connectionFactory = settings.connectionFactory || defaultConnectionFactory;
      function withServer(name, operation, callback) {
        let called = false;
        store.get(name, (storeError, server) => {
          called = true;
          if (storeError) {
            callback(storeError);
            return;
          }
          if (!server) {
            callback(error("DB_SERVER_NOT_FOUND", "\uB4F1\uB85D DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name }));
            return;
          }
          let connection;
          try {
            connection = connectionFactory(serverConnectionConfig(server));
            callback(null, operation(connection, server));
          } catch (failure) {
            callback(failure && failure.code ? failure : error("DB_UNAVAILABLE", "DB \uC694\uCCAD\uC744 \uCC98\uB9AC\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { server: name }));
          } finally {
            try {
              if (connection && typeof connection.close === "function") connection.close();
            } catch (_) {
            }
          }
        });
        if (!called) callback(error("DB_UNAVAILABLE", "\uB4F1\uB85D DB server \uC77D\uAE30\uB294 \uB3D9\uAE30 \uC644\uB8CC\uB418\uC5B4\uC57C \uD569\uB2C8\uB2E4.", { server: name }));
      }
      function metadata(connection, tableValue, serverUser) {
        const target = qualifiedTable(tableValue);
        let userId = null;
        const lookupUser = target.tableUser || String(serverUser || "").toUpperCase();
        if (lookupUser) {
          const users = rowsOf(connection.query("SELECT USER_ID, NAME FROM M$SYS_USERS"));
          const found = users.find((row) => String(row.NAME || row.name).toUpperCase() === lookupUser);
          if (!found) throw invalid("DB user\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { user: lookupUser });
          userId = found.USER_ID === void 0 ? found.user_id : found.USER_ID;
        }
        const tableRows = userId === null ? rowsOf(connection.query("SELECT ID, TYPE, NAME FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1", target.tableName)) : rowsOf(connection.query("SELECT ID, TYPE, NAME FROM M$SYS_TABLES WHERE NAME = ? AND USER_ID = ? AND DATABASE_ID = -1", target.tableName, userId));
        const tableRow = tableRows[0];
        if (!tableRow) throw error("DB_TABLE_NOT_FOUND", "TAG table\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { table: target.table });
        const tableType = Number(tableRow.TYPE === void 0 ? tableRow.type : tableRow.TYPE);
        if (tableType !== 6) throw invalid("\uC120\uD0DD\uD55C table\uC740 TAG table\uC774 \uC544\uB2D9\uB2C8\uB2E4.", { table: target.table });
        const tableId = tableRow.ID === void 0 ? tableRow.id : tableRow.ID;
        const columns = rowsOf(connection.query(
          "SELECT c.NAME, c.TYPE, c.ID, c.LENGTH, c.FLAG FROM M$SYS_COLUMNS c, M$SYS_TABLES t WHERE c.TABLE_ID = t.ID AND c.DATABASE_ID = t.DATABASE_ID AND t.ID = ? AND t.DATABASE_ID = -1 AND c.ID < 65534 ORDER BY c.ID ASC",
          tableId
        )).map(mapColumn);
        return { target, columns };
      }
      function column(columns, requested, fallback, predicate, label) {
        const name = identifier(requested || fallback, label);
        const found = columns.find((item) => item.name === name);
        if (!found || predicate && !predicate(found)) throw invalid(`${label}\uC774 table metadata\uC640 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`, { column: name });
        return found;
      }
      function roleColumn(columns, requested, role, label) {
        const requestedName = requested === void 0 || requested === null || requested === "" ? null : identifier(requested, label);
        const candidates = columns.filter((item) => item[role] === true);
        const found = candidates[0];
        if (candidates.length !== 1 || requestedName && requestedName !== found.name) {
          throw invalid(`${label}\uC774 table metadata\uC640 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`, { column: requestedName });
        }
        return found;
      }
      function request(params, serverRequired) {
        if (!params || typeof params !== "object" || Array.isArray(params)) throw invalid("DB \uC694\uCCAD\uC740 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
        if (serverRequired !== false && (typeof params.server !== "string" || !params.server)) throw invalid("server\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
        return params;
      }
      function invalidJob(name, reason) {
        throw error("JOB_INVALID_CONFIG", reason || "\uC800\uC7A5\uB41C Job DB \uC124\uC815\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
      }
      function sourceMismatch(name, reason, details) {
        throw error("JOB_DATA_SOURCE_MISMATCH", reason, { job: name, ...details || {} });
      }
      function jobDataRequest(params, requireNames = true) {
        request(params, false);
        const name = jobName(params.job);
        let document;
        if (!jobs) jobs = new JobRepository({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir });
        try {
          document = jobs.read(name);
        } catch (failure) {
          if (failure && (failure.code === "JOB_NOT_FOUND" || failure.code === "JOB_INVALID_CONFIG")) throw failure;
          invalidJob(name);
        }
        if (!document || typeof document !== "object" || Array.isArray(document) || document.schemaVersion !== 1 || document.name !== name || !document.database || typeof document.database !== "object" || Array.isArray(document.database) || !Array.isArray(document.methodCalls) || document.methodCalls.length < 1) {
          invalidJob(name);
        }
        let database = document.database;
        if (typeof database.server !== "string" || !database.server || typeof database.table !== "string" || typeof database.valueColumn !== "string" || typeof database.stringValueColumn !== "string") invalidJob(name);
        if (jobScopedTags) {
          let called = false;
          let storeError = null;
          let server = null;
          store.get(database.server, (failure, value) => {
            called = true;
            storeError = failure;
            server = value;
          });
          if (!called) invalidJob(name, "\uB4F1\uB85D DB server \uC77D\uAE30\uB294 \uB3D9\uAE30 \uC644\uB8CC\uB418\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
          if (storeError) throw storeError;
          if (!server) invalidJob(name, "\uC800\uC7A5\uB41C Job\uC758 Database Server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          database = {
            ...database,
            ...server.defaultTable ? { table: server.defaultTable } : {},
            ...server.valueColumn ? { valueColumn: server.valueColumn } : {},
            stringValueColumn: server.stringValueColumn || ""
          };
        }
        let table;
        let valueColumn;
        let stringValueColumn;
        try {
          table = qualifiedTable(database.table).table;
          valueColumn = identifier(database.valueColumn, "database.valueColumn");
          stringValueColumn = database.stringValueColumn ? identifier(database.stringValueColumn, "database.stringValueColumn") : null;
        } catch (_) {
          invalidJob(name);
        }
        if (typeof params.server !== "string" || !params.server || typeof params.table !== "string" || !params.table || requireNames && !Object.prototype.hasOwnProperty.call(params, "names")) {
          sourceMismatch(name, requireNames ? "job, server, table, names\uAC00 \uBAA8\uB450 \uD544\uC694\uD569\uB2C8\uB2E4." : "job, server, table\uC774 \uBAA8\uB450 \uD544\uC694\uD569\uB2C8\uB2E4.");
        }
        const requestedNames = requireNames ? namesOf(params.names) : [];
        if (params.server !== database.server) {
          sourceMismatch(name, "\uC694\uCCAD server\uAC00 Job DB \uC124\uC815\uACFC \uB2E4\uB985\uB2C8\uB2E4.");
        }
        let requestedTable;
        try {
          requestedTable = qualifiedTable(params.table).table;
        } catch (_) {
          sourceMismatch(name, "\uC694\uCCAD table \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        }
        if (requestedTable !== table) {
          sourceMismatch(name, "\uC694\uCCAD table\uC774 Job DB \uC124\uC815\uACFC \uB2E4\uB985\uB2C8\uB2E4.");
        }
        if (params.valueColumn !== void 0 && identifier(params.valueColumn, "valueColumn") !== valueColumn) {
          sourceMismatch(name, "\uC694\uCCAD valueColumn\uC774 Job DB \uC124\uC815\uACFC \uB2E4\uB985\uB2C8\uB2E4.");
        }
        if (params.stringValueColumn !== void 0) {
          const requestedStringValue = params.stringValueColumn ? identifier(params.stringValueColumn, "stringValueColumn") : null;
          if (requestedStringValue !== stringValueColumn) {
            sourceMismatch(name, "\uC694\uCCAD stringValueColumn\uC774 Job DB \uC124\uC815\uACFC \uB2E4\uB985\uB2C8\uB2E4.");
          }
        }
        const tagEntries = [];
        document.methodCalls.forEach((call, callIndex) => {
          const callLabel = String(call?.name || call?.id || `Call ${callIndex + 1}`).trim() || `Call ${callIndex + 1}`;
          const groups = Array.isArray(call.outputSelections) ? call.outputSelections.map((selection) => selection.tags || []) : [call.tags || []];
          groups.flat().forEach((tag) => {
            const tagName = String(tag?.name || "").trim();
            if (tagName && !tagEntries.some((item) => item.name === tagName)) {
              tagEntries.push({ name: tagName, treePath: [callLabel, tagName] });
            }
          });
        });
        return {
          name,
          names: requestedNames,
          tagEntries,
          database: { server: database.server, table, valueColumn, stringValueColumn }
        };
      }
      function hasOpcuaPaging(params) {
        return ["page", "pageSize", "boundedRange", "cursorSide", "cursorTime", "cursorName", "cursorOffset"].some((key) => Object.prototype.hasOwnProperty.call(params || {}, key));
      }
      function nonNegativeInteger(value, fallback, maximum, label) {
        const number = value === void 0 || value === null || value === "" ? fallback : Number(value);
        if (!Number.isInteger(number) || number < 0 || number > maximum) throw invalid(`${label}\uC740 0~${maximum} \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
        return number;
      }
      function opcuaPageParams(params, selectedJob) {
        const pageSize = positiveInteger(params.pageSize, 100, MAX_TOTAL_ROWS, "pageSize");
        const page = positiveInteger(params.page, 1, 1e6, "page");
        const from = optionalDate(params.from, "from");
        const to = optionalDate(params.to, "to");
        if (from && to && from > to) throw invalid("from\uC740 to\uBCF4\uB2E4 \uB2A6\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        const cursorSide = params.cursorSide === "next" || params.cursorSide === "prev" ? params.cursorSide : null;
        const cursorTime = optionalDate(params.cursorTime, "cursorTime");
        const cursorName = cursorSide && cursorTime ? String(params.cursorName || "") : "";
        if (cursorSide && !cursorTime || !cursorSide && (cursorTime || params.cursorName !== void 0 || params.cursorOffset !== void 0)) {
          throw invalid("cursor fields\uAC00 \uD568\uAED8 \uD544\uC694\uD569\uB2C8\uB2E4.");
        }
        return {
          names: selectedJob.names,
          job: selectedJob.name,
          direction: params.direction === "oldest" ? "oldest" : "latest",
          page,
          pageSize,
          boundedRange: params.boundedRange === true || params.boundedRange === "true",
          cursorSide,
          cursorTime,
          cursorName,
          cursorOffset: nonNegativeInteger(params.cursorOffset, 0, MAX_TOTAL_ROWS, "cursorOffset"),
          from,
          to
        };
      }
      function opcuaCursor(parsed, primary, time) {
        if (!parsed.cursorSide || !parsed.cursorTime) return null;
        const latest = parsed.direction !== "oldest";
        const next = parsed.cursorSide === "next";
        if (latest && next) return { sql: `(${time.name} < ? OR (${time.name} = ? AND ${primary.name} > ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: "DESC", orderName: "ASC", reverse: false };
        if (latest) return { sql: `(${time.name} > ? OR (${time.name} = ? AND ${primary.name} < ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: "ASC", orderName: "DESC", reverse: true };
        if (next) return { sql: `(${time.name} > ? OR (${time.name} = ? AND ${primary.name} > ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: "ASC", orderName: "ASC", reverse: false };
        return { sql: `(${time.name} < ? OR (${time.name} = ? AND ${primary.name} < ?))`, values: [parsed.cursorTime, parsed.cursorTime, parsed.cursorName], orderTime: "DESC", orderName: "DESC", reverse: true };
      }
      function mapViewerRow(row, primary, time, numeric, stringValue) {
        const date = new Date(rowValue(row, time.name));
        if (!Number.isFinite(date.getTime())) return null;
        const numberValue = numeric ? rowValue(row, numeric.name) : null;
        const textValue = stringValue ? rowValue(row, stringValue.name) : null;
        return {
          name: String(rowValue(row, primary.name)),
          time: date.toISOString(),
          value: numberValue === void 0 ? null : numberValue,
          stringValue: textValue === void 0 ? null : textValue
        };
      }
      function opcuaPage(connection, server, selectedJob, params) {
        const parsed = opcuaPageParams(params, selectedJob);
        const value = metadata(connection, selectedJob.database.table, server.user);
        const primary = roleColumn(value.columns, params.primaryColumn, "primaryKey", "primaryColumn");
        const time = roleColumn(value.columns, params.timeColumn, "basetime", "timeColumn");
        const numeric = column(value.columns, selectedJob.database.valueColumn, null, (item) => item.numeric, "valueColumn");
        const stringValue = selectedJob.database.stringValueColumn ? column(
          value.columns,
          selectedJob.database.stringValueColumn,
          null,
          (item) => item.string && !item.primaryKey,
          "stringValueColumn"
        ) : null;
        const clauses = [`${primary.name} IN (${parsed.names.map(() => "?").join(", ")})`];
        const values = parsed.names.slice();
        if (parsed.from) {
          clauses.push(`${time.name} >= ?`);
          values.push(parsed.from);
        }
        if (parsed.to) {
          clauses.push(`${time.name} <= ?`);
          values.push(parsed.to);
        }
        const cursor = opcuaCursor(parsed, primary, time);
        if (cursor) {
          clauses.push(cursor.sql);
          values.push(...cursor.values);
        }
        const orderTime = cursor ? cursor.orderTime : parsed.direction === "oldest" ? "ASC" : "DESC";
        const orderName = cursor ? cursor.orderName : "ASC";
        const selected = [primary.name, time.name, numeric.name];
        if (stringValue) selected.push(stringValue.name);
        let limit = "";
        if (!parsed.boundedRange) {
          const offset = cursor ? parsed.cursorOffset : (parsed.page - 1) * parsed.pageSize;
          values.push(offset, parsed.pageSize);
          limit = " LIMIT ?, ?";
        }
        const rows = rowsOf(connection.query(
          `SELECT ${selected.join(", ")} FROM ${value.target.table} WHERE ${clauses.join(" AND ")} ORDER BY ${time.name} ${orderTime}, ${primary.name} ${orderName}${limit}`,
          ...values
        ));
        const ordered = cursor && cursor.reverse ? rows.reverse() : rows;
        return {
          server: server.name,
          job: selectedJob.name,
          table: value.target.table,
          columns: { primary: primary.name, time: time.name, numericValue: numeric.name, stringValue: stringValue ? stringValue.name : null },
          names: parsed.names,
          direction: parsed.direction,
          page: parsed.page,
          pageSize: parsed.pageSize,
          rows: ordered.map((row) => mapViewerRow(row, primary, time, numeric, stringValue)).filter(Boolean)
        };
      }
      return {
        connect(params, callback) {
          try {
            request(params);
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(params.server, (_connection, server) => ({
            server: server.name,
            connected: true,
            host: server.host,
            port: server.port,
            user: server.user
          }), callback);
        },
        createTable(params, callback) {
          try {
            request(params);
          } catch (failure) {
            callback(failure);
            return;
          }
          let table;
          let valueColumn;
          let stringValueColumn;
          try {
            table = identifier(params.table, "table");
            valueColumn = identifier(params.valueColumn, "valueColumn");
            if (params.stringValueColumn === void 0 || params.stringValueColumn === null || params.stringValueColumn === "") {
              stringValueColumn = null;
            } else stringValueColumn = identifier(params.stringValueColumn, "stringValueColumn");
            if (valueColumn === "NAME" || valueColumn === "TIME" || valueColumn === stringValueColumn || stringValueColumn && (stringValueColumn === "NAME" || stringValueColumn === "TIME")) {
              throw tableInvalid("TAG table column \uC774\uB984\uC774 \uAE30\uBCF8 key/time \uC5F4\uACFC \uACB9\uCE69\uB2C8\uB2E4.");
            }
          } catch (failure) {
            callback(failure && failure.code === "TABLE_INVALID" ? failure : tableInvalid("TAG table \uB610\uB294 value column \uC124\uC815\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4."));
            return;
          }
          withServer(params.server, (connection, server) => {
            const existing = rowsOf(connection.query(
              "SELECT ID FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1",
              table
            ));
            if (existing.length) throw error("TABLE_ALREADY_EXISTS", "\uAC19\uC740 \uC774\uB984\uC758 table\uC774 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { table });
            const definitions = [
              "NAME VARCHAR(100) PRIMARY KEY",
              "TIME DATETIME BASETIME",
              `${valueColumn} DOUBLE SUMMARIZED`
            ];
            if (stringValueColumn) definitions.push(`${stringValueColumn} VARCHAR(1024)`);
            connection.exec(`CREATE TAG TABLE ${table} (${definitions.join(", ")})`);
            return {
              server: server.name,
              table,
              primaryKeyColumn: "NAME",
              basetimeColumn: "TIME",
              valueColumn,
              stringValueColumn
            };
          }, callback);
        },
        listTables(params, callback) {
          try {
            request(params);
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(params.server, (connection) => {
            const users = rowsOf(connection.query("SELECT USER_ID, NAME FROM M$SYS_USERS"));
            const names = {};
            users.forEach((row) => {
              names[row.USER_ID === void 0 ? row.user_id : row.USER_ID] = row.NAME || row.name;
            });
            return rowsOf(connection.query(
              "SELECT NAME, TYPE, ID, USER_ID FROM M$SYS_TABLES WHERE TYPE IN (0, 6) AND DATABASE_ID = -1"
            )).filter((row) => Number(row.TYPE === void 0 ? row.type : row.TYPE) === 6).map((row) => ({
              name: row.NAME || row.name,
              user: names[row.USER_ID === void 0 ? row.user_id : row.USER_ID] || null,
              type: "TAG"
            }));
          }, callback);
        },
        columns(params, callback) {
          try {
            request(params);
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(params.server, (connection, server) => {
            const value = metadata(connection, params.table, server.user);
            return {
              server: server.name,
              table: value.target.table,
              tableType: "TAG",
              columns: value.columns,
              primaryColumn: (value.columns.find((item) => item.primaryKey) || {}).name || null,
              timeColumn: (value.columns.find((item) => item.basetime) || {}).name || null,
              numericValueColumns: value.columns.filter((item) => item.numeric && !item.primaryKey).map((item) => item.name),
              stringValueColumns: value.columns.filter((item) => item.string && !item.primaryKey).map((item) => item.name)
            };
          }, callback);
        },
        tags(params, callback) {
          let selectedJob;
          try {
            selectedJob = jobDataRequest(params, false);
          } catch (failure) {
            callback(failure);
            return;
          }
          if (jobScopedTags) {
            const tagEntries = selectedJob.tagEntries || [];
            let limit2 = tagEntries.length;
            if (params.limit !== void 0 && params.limit !== "") {
              try {
                if (tagEntries.length) limit2 = positiveInteger(params.limit, tagEntries.length, tagEntries.length, "limit");
                else if (Number(params.limit) !== 0) throw invalid("limit\uC740 Tag\uAC00 \uC5C6\uC744 \uB54C 0\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
              } catch (failure) {
                callback(failure);
                return;
              }
            }
            return callback(null, {
              server: selectedJob.database.server,
              table: selectedJob.database.table,
              tags: tagEntries.slice(0, limit2).map((tag) => ({ id: null, name: tag.name, treePath: tag.treePath })),
              assetHierarchy: null,
              limited: tagEntries.length > limit2,
              limit: limit2
            });
          }
          let limit;
          try {
            limit = positiveInteger(params.limit, 200, MAX_TAGS, "limit");
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(selectedJob.database.server, (connection, server) => {
            const value = metadata(connection, selectedJob.database.table, server.user);
            const primary = roleColumn(value.columns, params.primaryColumn, "primaryKey", "primaryColumn");
            const metaTable = value.target.tableUser ? `${value.target.tableUser}._${value.target.tableName}_META` : `_${value.target.tableName}_META`;
            const hierarchyRows = rowsOf(connection.query(
              `SELECT * FROM ${metaTable} WHERE ${primary.name} = ?`,
              HIERARCHY_TAG_NAME
            ));
            const assetHierarchy = findAssetHierarchy(hierarchyRows[0]);
            const queryLimit = limit + (assetHierarchy ? 2 : 1);
            const rows = rowsOf(connection.query(
              assetHierarchy ? `SELECT * FROM ${metaTable} ORDER BY ${primary.name} LIMIT ?` : `SELECT _ID, ${primary.name} FROM ${metaTable} ORDER BY ${primary.name} LIMIT ?`,
              queryLimit
            ));
            const allTags = mapTagMetaRows(rows, assetHierarchy, primary.name);
            const tags = allTags.slice(0, limit);
            return {
              server: server.name,
              table: value.target.table,
              tags,
              assetHierarchy,
              limited: allTags.length > limit,
              limit
            };
          }, callback);
        },
        data(params, callback) {
          let selectedJob;
          try {
            selectedJob = jobDataRequest(params);
          } catch (failure) {
            callback(failure);
            return;
          }
          if (hasOpcuaPaging(params)) {
            withServer(selectedJob.database.server, (connection, server) => opcuaPage(connection, server, selectedJob, params), callback);
            return;
          }
          let parsed;
          try {
            parsed = {
              names: selectedJob.names,
              job: selectedJob.name,
              rowsPerTag: positiveInteger(params.rowsPerTag, 100, MAX_ROWS_PER_TAG, "rowsPerTag"),
              direction: params.direction === "oldest" ? "oldest" : "latest",
              from: optionalDate(params.from, "from"),
              to: optionalDate(params.to, "to"),
              timezone: timezone(params),
              cursor: decodeCursor(params.cursor)
            };
            if (parsed.names.length * parsed.rowsPerTag > MAX_TOTAL_ROWS) throw invalid(`\uD55C \uC694\uCCAD\uC758 row\uB294 \uCD5C\uB300 ${MAX_TOTAL_ROWS}\uAC1C\uC785\uB2C8\uB2E4.`);
            parsed.offset = parsed.cursor.page * parsed.rowsPerTag;
            if (!Number.isSafeInteger(parsed.offset)) throw invalid("cursor page\uAC00 \uB108\uBB34 \uD07D\uB2C8\uB2E4.");
            if (parsed.from && parsed.to && parsed.from > parsed.to) throw invalid("from\uC740 to\uBCF4\uB2E4 \uB2A6\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(selectedJob.database.server, (connection, server) => {
            const value = metadata(connection, selectedJob.database.table, server.user);
            const primary = roleColumn(value.columns, params.primaryColumn, "primaryKey", "primaryColumn");
            const time = roleColumn(value.columns, params.timeColumn, "basetime", "timeColumn");
            const numeric = column(value.columns, selectedJob.database.valueColumn, null, (item) => item.numeric, "valueColumn");
            const stringValue = selectedJob.database.stringValueColumn ? column(
              value.columns,
              selectedJob.database.stringValueColumn,
              null,
              (item) => item.string && !item.primaryKey,
              "stringValueColumn"
            ) : null;
            if (!numeric && !stringValue) throw invalid("valueColumn \uB610\uB294 stringValueColumn\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
            const order = parsed.direction === "oldest" ? "ASC" : "DESC";
            const pageRows = [];
            let anyHasMore = false;
            parsed.names.forEach((name) => {
              const clauses = [`${primary.name} = ?`];
              const values = [name];
              if (parsed.from) {
                clauses.push(`${time.name} >= ?`);
                values.push(parsed.from);
              }
              if (parsed.to) {
                clauses.push(`${time.name} <= ?`);
                values.push(parsed.to);
              }
              values.push(parsed.offset, parsed.rowsPerTag + 1);
              const selected = [primary.name, time.name];
              if (numeric) selected.push(numeric.name);
              if (stringValue) selected.push(stringValue.name);
              const fetchedRows = rowsOf(connection.query(
                `SELECT ${selected.join(", ")} FROM ${value.target.table} WHERE ${clauses.join(" AND ")} ORDER BY ${time.name} ${order} LIMIT ?, ?`,
                ...values
              ));
              if (fetchedRows.length > parsed.rowsPerTag) anyHasMore = true;
              const rows = fetchedRows.slice(0, parsed.rowsPerTag);
              rows.forEach((row) => {
                const date = new Date(rowValue(row, time.name));
                if (!Number.isFinite(date.getTime())) return;
                const numberValue = numeric ? rowValue(row, numeric.name) : null;
                const textValue = stringValue ? rowValue(row, stringValue.name) : null;
                pageRows.push({
                  name: String(rowValue(row, primary.name)),
                  time: date.toISOString(),
                  value: numberValue === void 0 ? null : numberValue,
                  stringValue: textValue === void 0 ? null : textValue
                });
              });
            });
            pageRows.sort((left, right) => parsed.direction === "oldest" ? left.time.localeCompare(right.time) : right.time.localeCompare(left.time));
            return {
              server: server.name,
              job: parsed.job,
              table: value.target.table,
              columns: {
                primary: primary.name,
                time: time.name,
                numericValue: numeric ? numeric.name : null,
                stringValue: stringValue ? stringValue.name : null
              },
              names: parsed.names,
              direction: parsed.direction,
              timezone: parsed.timezone,
              rowsPerTag: parsed.rowsPerTag,
              rows: pageRows,
              cursor: {
                next: anyHasMore ? encodeCursor({ side: "next", page: parsed.cursor.page + 1 }) : null,
                previous: parsed.cursor.page > 0 ? encodeCursor({ side: "previous", page: parsed.cursor.page - 1 }) : null
              }
            };
          }, callback);
        },
        stat(params, callback) {
          let selectedJob;
          try {
            selectedJob = jobDataRequest(params);
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(selectedJob.database.server, (connection, server) => {
            const value = metadata(connection, selectedJob.database.table, server.user);
            const primary = roleColumn(value.columns, params.primaryColumn, "primaryKey", "primaryColumn");
            const time = roleColumn(value.columns, params.timeColumn, "basetime", "timeColumn");
            const rows = rowsOf(connection.query(
              `SELECT MIN(${time.name}) AS MIN_TIME, MAX(${time.name}) AS MAX_TIME FROM ${value.target.table} WHERE ${primary.name} IN (${selectedJob.names.map(() => "?").join(", ")})`,
              ...selectedJob.names
            ));
            const row = rows[0] || {};
            const asIso = (source) => {
              if (source === void 0 || source === null || source === "") return null;
              const date = new Date(source);
              return Number.isFinite(date.getTime()) ? date.toISOString() : null;
            };
            return {
              server: server.name,
              job: selectedJob.name,
              table: value.target.table,
              names: selectedJob.names,
              minTime: asIso(rowValue(row, "MIN_TIME")),
              maxTime: asIso(rowValue(row, "MAX_TIME"))
            };
          }, callback);
        },
        dataTotal(params, callback) {
          let selectedJob;
          let parsed;
          try {
            selectedJob = jobDataRequest(params);
            parsed = opcuaPageParams(params, selectedJob);
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(selectedJob.database.server, (connection, server) => {
            const value = metadata(connection, selectedJob.database.table, server.user);
            const primary = roleColumn(value.columns, params.primaryColumn, "primaryKey", "primaryColumn");
            const time = roleColumn(value.columns, params.timeColumn, "basetime", "timeColumn");
            const clauses = [`${primary.name} IN (${parsed.names.map(() => "?").join(", ")})`];
            const values = parsed.names.slice();
            if (parsed.from) {
              clauses.push(`${time.name} >= ?`);
              values.push(parsed.from);
            }
            if (parsed.to) {
              clauses.push(`${time.name} <= ?`);
              values.push(parsed.to);
            }
            const rows = rowsOf(connection.query(
              `SELECT COUNT(*) AS ROW_COUNT FROM ${value.target.table} WHERE ${clauses.join(" AND ")}`,
              ...values
            ));
            const total = Number(rowValue(rows[0] || {}, "ROW_COUNT"));
            if (!Number.isSafeInteger(total) || total < 0) throw invalid("row count\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
            return {
              server: server.name,
              job: selectedJob.name,
              table: value.target.table,
              names: parsed.names,
              total,
              pageSize: parsed.pageSize,
              lastPage: Math.max(1, Math.ceil(total / parsed.pageSize))
            };
          }, callback);
        },
        chart(params, callback) {
          let selectedJob;
          try {
            selectedJob = jobDataRequest(params);
          } catch (failure) {
            callback(failure);
            return;
          }
          let parsed;
          try {
            parsed = {
              names: selectedJob.names,
              job: selectedJob.name,
              from: optionalDate(params.from, "from"),
              to: optionalDate(params.to, "to"),
              timezone: timezone(params)
            };
          } catch (failure) {
            callback(failure);
            return;
          }
          withServer(selectedJob.database.server, (connection, server) => {
            const value = metadata(connection, selectedJob.database.table, server.user);
            const primary = roleColumn(value.columns, params.primaryColumn, "primaryKey", "primaryColumn");
            const time = roleColumn(value.columns, params.timeColumn, "basetime", "timeColumn");
            const numeric = column(value.columns, selectedJob.database.valueColumn, null, (item) => item.numeric, "valueColumn");
            const clauses = [`${primary.name} IN (${parsed.names.map((name) => `'${escapeSqlString(name)}'`).join(", ")})`];
            if (parsed.from) clauses.push(`${time.name} >= ${formatSqlDateLiteral(parsed.from)}`);
            if (parsed.to) clauses.push(`${time.name} <= ${formatSqlDateLiteral(parsed.to)}`);
            const query = `SELECT ${time.name} AS TIME, ${primary.name} AS NAME, ${numeric.name} AS VALUE FROM ${value.target.table} WHERE ${clauses.join(" AND ")} ORDER BY ${time.name} ASC, ${primary.name} ASC`;
            return {
              server: server.name,
              job: parsed.job,
              table: value.target.table,
              columns: { primary: primary.name, time: time.name, numericValue: numeric.name },
              names: parsed.names,
              timezone: parsed.timezone,
              range: {
                from: parsed.from ? parsed.from.toISOString() : null,
                to: parsed.to ? parsed.to.toISOString() : null
              },
              query
            };
          }, callback);
        }
      };
    }
    module2.exports = {
      MAX_NAMES,
      MAX_ROWS_PER_TAG,
      MAX_TOTAL_ROWS,
      createDataViewer,
      identifier,
      qualifiedTable,
      rowsOf
    };
  }
});

// cgi-bin/src/db/metadata-reader.js
var require_metadata_reader = __commonJS({
  "cgi-bin/src/db/metadata-reader.js"(exports2, module2) {
    "use strict";
    var TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
    var FLAG_BASETIME = 16777216;
    var FLAG_PRIMARY = 134217728;
    var NUMERIC_TYPES = /* @__PURE__ */ new Set([4, 104, 8, 108, 12, 112, 16, 20]);
    var STRING_TYPES = /* @__PURE__ */ new Set([5, 49, 53]);
    function defaultClientFactory(config) {
      const machcli = require("machcli");
      if (!machcli || typeof machcli.Client !== "function") {
        throw new Error("machcli.Client\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      }
      return new machcli.Client(config);
    }
    function rowsOf(iterable) {
      if (!iterable) return [];
      if (Array.isArray(iterable)) return iterable;
      const rows = [];
      for (const row of iterable) rows.push(row);
      return rows;
    }
    function typeName(code, length) {
      const names = {
        4: "short",
        104: "ushort",
        8: "integer",
        108: "uinteger",
        12: "long",
        112: "ulong",
        6: "datetime",
        16: "float",
        20: "double",
        49: "text",
        53: "clob",
        57: "blob",
        97: "binary",
        32: "ipv4",
        36: "ipv6",
        61: "json"
      };
      if (Number(code) === 5) return `varchar(${Number(length) || 0})`;
      return names[Number(code)] || "unknown";
    }
    function connectionConfig(server) {
      const source = server && server.connection && typeof server.connection === "object" ? server.connection : server;
      return {
        host: source.host,
        port: source.port,
        user: source.user,
        password: source.password
      };
    }
    function createMetadataReader(options) {
      const settings = options || {};
      const clientFactory = settings.clientFactory || defaultClientFactory;
      function withConnection(server, callback, operation) {
        let client = null;
        let connection = null;
        let result = null;
        let failure = null;
        try {
          client = clientFactory(connectionConfig(server));
          if (!client || typeof client.connect !== "function") {
            throw new Error("machcli client connect()\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          }
          connection = client.connect();
          if (!connection || typeof connection.query !== "function") {
            throw new Error("machcli connection query()\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          }
          result = operation(connection);
        } catch (operationError) {
          failure = operationError;
        } finally {
          try {
            if (connection && typeof connection.close === "function") connection.close();
          } catch (_) {
          }
          try {
            if (client && typeof client.close === "function") client.close();
          } catch (_) {
          }
        }
        callback(failure, result);
      }
      return {
        listTables(server, callback) {
          withConnection(server, callback, (connection) => ({
            tables: rowsOf(connection.query(
              "SELECT NAME FROM M$SYS_TABLES WHERE TYPE = 6 AND DATABASE_ID = -1 ORDER BY NAME ASC"
            )).map((row) => String(row.NAME === void 0 ? row.name : row.NAME))
          }));
        },
        createTagTable(server, table, callback) {
          if (typeof table !== "string" || !TABLE_NAME.test(table)) {
            callback(new Error("DB table name \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4."));
            return;
          }
          withConnection(server, callback, (connection) => {
            if (typeof connection.exec !== "function") throw new Error("machcli connection exec()\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
            const existing = rowsOf(connection.query(
              "SELECT ID FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1",
              table
            ));
            if (existing.length) {
              const failure = new Error("\uAC19\uC740 \uC774\uB984\uC758 table\uC774 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.");
              failure.code = "TABLE_ALREADY_EXISTS";
              throw failure;
            }
            connection.exec(`CREATE TAG TABLE ${table} (NAME VARCHAR(100) PRIMARY KEY, TIME DATETIME BASETIME, VALUE DOUBLE SUMMARIZED, STR_VALUE VARCHAR(1024))`);
            return { table, valueColumn: "VALUE", stringValueColumn: "STR_VALUE" };
          });
        },
        columns(server, table, callback) {
          if (typeof table !== "string" || !TABLE_NAME.test(table)) {
            callback(new Error("DB table name \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4."));
            return;
          }
          withConnection(server, callback, (connection) => {
            const tableRows = rowsOf(connection.query(
              "SELECT ID, TYPE, NAME FROM M$SYS_TABLES WHERE NAME = ? AND DATABASE_ID = -1",
              table
            ));
            const tableRow = tableRows[0] || null;
            if (!tableRow) {
              return { table, tableType: "NOT_FOUND", columns: [] };
            } else {
              const tableId = tableRow.ID === void 0 ? tableRow.id : tableRow.ID;
              const tableTypeCode = tableRow.TYPE === void 0 ? tableRow.type : tableRow.TYPE;
              const columnRows = rowsOf(connection.query(
                "SELECT c.NAME, c.TYPE, c.ID, c.LENGTH, c.FLAG FROM M$SYS_COLUMNS c, M$SYS_TABLES t WHERE c.TABLE_ID = t.ID AND c.DATABASE_ID = t.DATABASE_ID AND t.ID = ? AND t.DATABASE_ID = -1 AND c.ID < 65534 ORDER BY c.ID ASC",
                tableId
              ));
              return {
                table,
                tableType: Number(tableTypeCode) === 6 ? "TAG" : Number(tableTypeCode) === 0 ? "LOG" : "UNSUPPORTED",
                columns: columnRows.map((row) => {
                  const flag = Number(row.FLAG === void 0 ? row.flag : row.FLAG) || 0;
                  const name = row.NAME === void 0 ? row.name : row.NAME;
                  const type = row.TYPE === void 0 ? row.type : row.TYPE;
                  const length = row.LENGTH === void 0 ? row.length : row.LENGTH;
                  const typeCode = Number(type);
                  return {
                    name,
                    type: typeName(typeCode, length),
                    primaryKey: Boolean(flag & FLAG_PRIMARY),
                    basetime: Boolean(flag & FLAG_BASETIME),
                    numeric: NUMERIC_TYPES.has(typeCode),
                    string: STRING_TYPES.has(typeCode)
                  };
                })
              };
            }
          });
        }
      };
    }
    module2.exports = { createMetadataReader };
  }
});

// cgi-bin/src/config/settings-validator.js
var require_settings_validator = __commonJS({
  "cgi-bin/src/config/settings-validator.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    function positiveInteger(value) {
      return Number.isInteger(value) && value > 0;
    }
    function loggingPolicy(value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !positiveInteger(value.maxFileBytes) || value.maxFileBytes < 64 * 1024 || value.maxFileBytes > 10 * 1024 * 1024 || !positiveInteger(value.maxFiles) || value.maxFiles > 10 || !positiveInteger(value.summaryIntervalMs) || value.summaryIntervalMs < 60 * 1e3 || value.summaryIntervalMs > 24 * 60 * 60 * 1e3) {
        throw error("SETTINGS_INVALID", "logging \uC124\uC815\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      return {
        maxFileBytes: value.maxFileBytes,
        maxFiles: value.maxFiles,
        summaryIntervalMs: value.summaryIntervalMs
      };
    }
    function lsPolicy(value) {
      if (value === void 0) return null;
      const interval = value?.interval;
      const writer = value?.writer;
      const performance = value?.performance;
      if (!value || typeof value !== "object" || Array.isArray(value) || !interval || typeof interval !== "object" || Array.isArray(interval) || typeof interval.useTaskCycle !== "boolean" || !writer || typeof writer !== "object" || Array.isArray(writer) || !positiveInteger(writer.queueCapacity) || writer.queueCapacity > 1024 || !positiveInteger(writer.flushMaxRows) || writer.flushMaxRows > 65535 || !positiveInteger(writer.flushIntervalMs) || writer.flushIntervalMs > 60 * 60 * 1e3 || !performance || typeof performance !== "object" || Array.isArray(performance) || typeof performance.enabled !== "boolean" || !positiveInteger(performance.jobSampleCount) || !positiveInteger(performance.writerSummaryIntervalMs)) {
        throw error("SETTINGS_INVALID", "LS interval \uC124\uC815\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      return {
        interval: { useTaskCycle: interval.useTaskCycle },
        // Shared writer settings; users do not edit them in the frontend.
        writer: {
          queueCapacity: writer.queueCapacity,
          flushMaxRows: writer.flushMaxRows,
          flushIntervalMs: writer.flushIntervalMs
        },
        // Go applies the operational floors and records a correction in the Job
        // log. Preserve the requested values here so that audit message can show
        // both the configured and applied values.
        performance: {
          enabled: performance.enabled,
          jobSampleCount: performance.jobSampleCount,
          writerSummaryIntervalMs: performance.writerSummaryIntervalMs
        }
      };
    }
    function validateSettings(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw error("SETTINGS_INVALID", "settings\uB294 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
      }
      if (value.schemaVersion !== 1) {
        throw error("SETTINGS_INVALID", "settings schemaVersion\uC740 1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      }
      if (!value.limits || !positiveInteger(value.limits.maxGeneratedTagsPerCall) || !positiveInteger(value.limits.maxBufferedRowsPerCycle)) {
        throw error("SETTINGS_INVALID", "limits \uAC12\uC740 0\uBCF4\uB2E4 \uD070 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
      }
      const defaults = value.defaults;
      if (!defaults || typeof defaults !== "object" || Array.isArray(defaults) || !defaults.database || typeof defaults.database !== "object" || Array.isArray(defaults.database) || typeof defaults.database.server !== "string" || !defaults.database.server) {
        throw error("SETTINGS_INVALID", "\uAE30\uBCF8 Database \uC124\uC815\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      return {
        schemaVersion: 1,
        limits: {
          maxGeneratedTagsPerCall: value.limits.maxGeneratedTagsPerCall,
          maxBufferedRowsPerCycle: value.limits.maxBufferedRowsPerCycle
        },
        defaults: {
          database: { server: defaults.database.server }
        },
        logging: loggingPolicy(value.logging),
        ...lsPolicy(value.ls) ? { ls: lsPolicy(value.ls) } : {}
      };
    }
    module2.exports = { validateSettings };
  }
});

// cgi-bin/src/config/settings-loader.js
var require_settings_loader = __commonJS({
  "cgi-bin/src/config/settings-loader.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var { error } = require_errors();
    var { validateSettings } = require_settings_validator();
    function defaultSettings() {
      return {
        schemaVersion: 1,
        limits: {
          maxGeneratedTagsPerCall: 1e3,
          maxBufferedRowsPerCycle: 1e4
        },
        defaults: {
          database: { server: "localhost" }
        },
        logging: {
          maxFileBytes: 1024 * 1024,
          maxFiles: 3,
          summaryIntervalMs: 60 * 60 * 1e3
        },
        // LS writer tuning is intentionally an internal deployment setting. It
        // is copied into the Go collector policy file but is not exposed in the UI.
        ls: {
          interval: { useTaskCycle: true },
          writer: { queueCapacity: 64, flushMaxRows: 1024, flushIntervalMs: 1e3 },
          performance: { enabled: true, jobSampleCount: 1e3, writerSummaryIntervalMs: 3e4 }
        }
      };
    }
    function loadSettings(file) {
      let value;
      try {
        value = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (readError) {
        if (readError && readError.code === "ENOENT") return defaultSettings();
        throw error("SETTINGS_INVALID", "settings \uD30C\uC77C\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
          message: readError.message
        });
      }
      const base = defaultSettings();
      const defaults = value.defaults && typeof value.defaults === "object" && !Array.isArray(value.defaults) ? value.defaults : {};
      return validateSettings({
        ...base,
        ...value,
        limits: value.limits || base.limits,
        defaults: {
          ...base.defaults,
          ...defaults,
          database: { ...base.defaults.database, ...defaults.database || {} }
        },
        logging: { ...base.logging, ...value.logging && typeof value.logging === "object" && !Array.isArray(value.logging) ? value.logging : {} },
        ls: {
          ...base.ls,
          ...value.ls && typeof value.ls === "object" && !Array.isArray(value.ls) ? value.ls : {},
          interval: { ...base.ls.interval, ...value.ls?.interval && typeof value.ls.interval === "object" && !Array.isArray(value.ls.interval) ? value.ls.interval : {} },
          writer: { ...base.ls.writer, ...value.ls?.writer && typeof value.ls.writer === "object" && !Array.isArray(value.ls.writer) ? value.ls.writer : {} },
          performance: { ...base.ls.performance, ...value.ls?.performance && typeof value.ls.performance === "object" && !Array.isArray(value.ls.performance) ? value.ls.performance : {} }
        }
      });
    }
    module2.exports = { loadSettings, defaultSettings };
  }
});

// cgi-bin/src/config/product-policy.js
var require_product_policy = __commonJS({
  "cgi-bin/src/config/product-policy.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var genericPolicy = {
      target: "generic",
      minimumIntervalMs: 1e3,
      validateProductConfig(config) {
        return config;
      }
    };
    function loadProductPolicy(cgiRoot) {
      const file = path.join(cgiRoot, "product", "index.js");
      if (!fs.existsSync(file)) return genericPolicy;
      const policy = require(file);
      if (!policy || !["generic", "ls"].includes(policy.target) || !Number.isInteger(policy.minimumIntervalMs) || policy.minimumIntervalMs < 1 || typeof policy.validateProductConfig !== "function") {
        throw new Error("Product Backend module is invalid.");
      }
      return policy;
    }
    module2.exports = { loadProductPolicy };
  }
});

// cgi-bin/src/service/controller-state.js
var require_controller_state = __commonJS({
  "cgi-bin/src/service/controller-state.js"(exports2, module2) {
    "use strict";
    var KNOWN_STATES = /* @__PURE__ */ new Set([
      "RUNNING",
      "STARTING",
      "STOPPING",
      "STOPPED",
      "FAILED"
    ]);
    function controllerDetail(info) {
      if (!info || typeof info !== "object") return "";
      const value = info.error || info.config && info.config.start_error || "";
      return String(value);
    }
    function reportedState(info) {
      if (!info || typeof info !== "object") return "";
      return String(info.status || info.state || "").toUpperCase();
    }
    function classifyControllerState(info, options) {
      const settings = options || {};
      const reported = reportedState(info);
      let state;
      if (settings.notInstalled) state = "NOT_INSTALLED";
      else if (KNOWN_STATES.has(reported)) state = reported;
      else if (!reported && info && info.running === true) state = "RUNNING";
      else state = "UNKNOWN";
      return {
        state,
        known: state !== "UNKNOWN",
        running: state === "RUNNING" || state === "STARTING",
        startComplete: state === "RUNNING",
        activeForStop: state === "RUNNING" || state === "STARTING" || state === "STOPPING",
        knownInactive: state === "STOPPED" || state === "FAILED" || state === "NOT_INSTALLED",
        detail: controllerDetail(info)
      };
    }
    module2.exports = {
      classifyControllerState
    };
  }
});

// cgi-bin/src/service/controller-adapter.js
var require_controller_adapter = __commonJS({
  "cgi-bin/src/service/controller-adapter.js"(exports2, module2) {
    "use strict";
    function loadServiceModule(explicit) {
      if (explicit !== void 0) return explicit;
      try {
        return require("service");
      } catch (_) {
        return null;
      }
    }
    function createControllerAdapter(serviceModule) {
      const source = loadServiceModule(serviceModule);
      let client = null;
      let clientError = null;
      try {
        if (!source || typeof source.Client !== "function") {
          throw new Error("service.Client\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        }
        client = new source.Client();
      } catch (creationError) {
        clientError = creationError;
      }
      function invoke(method, args, callback) {
        if (clientError) {
          callback(clientError);
          return;
        }
        try {
          if (!client || typeof client[method] !== "function") {
            callback(new Error(`service.Client.${method}()\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`));
            return;
          }
          client[method](...args, callback);
        } catch (callError) {
          callback(callError);
        }
      }
      return {
        status(name, callback) {
          invoke("status", [name], callback);
        },
        install(descriptor, callback) {
          invoke("install", [descriptor], callback);
        },
        start(name, callback) {
          invoke("start", [name], callback);
        },
        stop(name, callback) {
          invoke("stop", [name], callback);
        },
        uninstall(name, callback) {
          invoke("uninstall", [name], callback);
        },
        details(name, key, callback) {
          if (clientError) {
            callback(clientError);
            return;
          }
          try {
            if (!client || !client.details || typeof client.details.get !== "function") {
              callback(new Error("service.Client.details.get()\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."));
              return;
            }
            client.details.get(name, key, (detailsError, runtime) => {
              if (detailsError && /Detail\s+'.+'\s+not found/i.test(detailsError.message || "")) {
                callback(null, null);
                return;
              }
              if (detailsError) {
                callback(detailsError);
                return;
              }
              const details = runtime && runtime.details;
              callback(null, details && Object.prototype.hasOwnProperty.call(details, key) ? details[key] : null);
            });
          } catch (detailsError) {
            callback(detailsError);
          }
        }
      };
    }
    function isNotInstalled(error) {
      if (error && error.rpcCode !== void 0) return error.rpcCode === -32004;
      const message = error && error.message ? error.message : String(error || "");
      return /service\b.*\b(?:not found|not installed|does not exist)\b/i.test(message) || /\b(?:no such|unknown) service\b/i.test(message);
    }
    module2.exports = { createControllerAdapter, isNotInstalled };
  }
});

// cgi-bin/src/collector/ls-runtime.js
var require_ls_runtime = __commonJS({
  "cgi-bin/src/collector/ls-runtime.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var process = require("process");
    var { writeJsonAtomic } = require_atomic_json();
    var { createServerStore } = require_server_store();
    var { loadSettings } = require_settings_loader();
    var { classifyControllerState } = require_controller_state();
    var { isNotInstalled } = require_controller_adapter();
    var LS_SERVICE_NAME = "_dbu_collector";
    var SNAPSHOT_FILE = "go-collector.json";
    var SECRET_FILE = "go-collector-secrets.json";
    var ACTIVE_FILE = "go-collector-active-jobs.json";
    var RUNTIME_FILE = "go-collector-runtime.json";
    var BINARY_FILE = path.join("bin", "neo-dbus-collector");
    var LAUNCHER_FILE = "neo-dbus-launcher.js";
    var CONTROL_FILE = "neo-dbus-control.js";
    function runtimePaths(cgiRoot) {
      return {
        snapshot: path.join(cgiRoot, "conf.d", SNAPSHOT_FILE),
        secret: path.join(cgiRoot, "conf.d", SECRET_FILE),
        active: path.join(cgiRoot, "conf.d", ACTIVE_FILE),
        runtime: path.join(cgiRoot, "data", RUNTIME_FILE),
        binary: path.join(cgiRoot, BINARY_FILE),
        launcher: path.join(cgiRoot, LAUNCHER_FILE),
        control: path.join(cgiRoot, CONTROL_FILE)
      };
    }
    function readRuntime(file) {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : { jobs: {} };
      } catch (readError) {
        if (readError && readError.code === "ENOENT") return { jobs: {} };
        throw readError;
      }
    }
    function readActiveJobs(file) {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!value || value.schemaVersion !== 1 || !Array.isArray(value.names) || value.names.some((name) => typeof name !== "string")) throw new Error("LS collector active Job state is invalid.");
        return [...new Set(value.names)].sort();
      } catch (readError) {
        if (readError && readError.code === "ENOENT") return [];
        throw readError;
      }
    }
    function syncCallback(operation) {
      let called = false;
      let failure;
      let value;
      operation((error, result) => {
        called = true;
        failure = error;
        value = result;
      });
      if (!called) throw new Error("LS collector configuration store must complete synchronously.");
      if (failure) throw failure;
      return value;
    }
    function writeSecretAtomic(file, value) {
      writeJsonAtomic(file, value);
      if (typeof fs.chmodSync !== "function") throw new Error("secure collector secret file permissions are unavailable.");
      fs.chmodSync(file, 384);
    }
    function controllerStatus(controller, callback) {
      controller.status(LS_SERVICE_NAME, (statusError, info) => {
        if (statusError && isNotInstalled(statusError)) {
          callback(null, { controllerState: "NOT_INSTALLED", controllerDetail: null, statusError: null });
          return;
        }
        if (statusError) {
          callback(null, { controllerState: "UNKNOWN", controllerDetail: statusError.message || null, statusError });
          return;
        }
        const state = classifyControllerState(info);
        callback(null, {
          controllerState: state.known ? state.state : "UNKNOWN",
          controllerDetail: state.detail || null,
          statusError: state.known ? null : new Error(state.detail || "Controller state is unknown.")
        });
      });
    }
    function createLsRuntime(options) {
      const settings = options || {};
      const cgiRoot = settings.cgiRoot;
      const controller = settings.controller;
      const serverStore = settings.serverStore || createServerStore({ cgiRoot });
      const processApi = settings.process || process;
      const files = runtimePaths(cgiRoot);
      function ensureExecutable() {
        if (!fs.existsSync(files.binary)) throw new Error("LS Go collector executable is missing. Build the LS package first.");
        if (!fs.existsSync(files.launcher) || !fs.existsSync(files.control)) {
          throw new Error("LS Go collector JSH launcher files are missing.");
        }
        if (typeof fs.chmodSync !== "function") throw new Error("LS collector executable permissions cannot be set by this JSH runtime.");
        fs.chmodSync(files.binary, 493);
        fs.chmodSync(files.launcher, 493);
        fs.chmodSync(files.control, 493);
      }
      function syncConfig() {
        const settings2 = loadSettings(path.join(cgiRoot, "conf.d", "settings.json"));
        const profileName = settings2.defaults.database.server;
        const source = syncCallback((callback) => serverStore.get(profileName, callback));
        if (!source) throw new Error(`LS collector DB server was not found: ${profileName}`);
        const servers = {};
        servers[profileName] = {
          host: source.host,
          port: source.port,
          user: source.user,
          password: source.password,
          defaultTable: source.defaultTable || "",
          valueColumn: source.valueColumn || "",
          stringValueColumn: source.stringValueColumn || ""
        };
        writeJsonAtomic(files.snapshot, {
          schemaVersion: 2,
          logging: settings2.logging,
          writer: settings2.ls.writer,
          performance: settings2.ls.performance
        });
        writeSecretAtomic(files.secret, { schemaVersion: 1, servers });
        if (!fs.existsSync(files.active)) writeJsonAtomic(files.active, { schemaVersion: 1, names: [] });
      }
      function execControl(action, name) {
        ensureExecutable();
        if (!processApi || typeof processApi.exec !== "function") throw new Error("JSH process.exec() is unavailable for LS collector control.");
        const exitCode = processApi.exec(files.control, action, name);
        if (exitCode !== 0) throw new Error(`LS collector ${action} control command failed (exit=${exitCode}).`);
      }
      function install(callback) {
        try {
          ensureExecutable();
        } catch (permissionError) {
          callback(permissionError);
          return;
        }
        controllerStatus(controller, (_unused, state) => {
          if (state.statusError) {
            callback(state.statusError);
            return;
          }
          if (state.controllerState !== "NOT_INSTALLED") {
            callback(null, state);
            return;
          }
          controller.install({
            name: LS_SERVICE_NAME,
            // The collector must come back after a Neo process restart and then
            // restore the logical active-job checkpoint. Service-controller
            // descriptors are disabled unless enable is explicitly true.
            enable: true,
            working_dir: cgiRoot,
            executable: files.launcher
          }, (installError) => {
            if (!installError) {
              controllerStatus(controller, (_ignored, installed) => callback(installed.statusError, installed));
              return;
            }
            if (!/already exists/i.test(String(installError.message || installError))) {
              callback(installError);
              return;
            }
            callback(null, {
              controllerState: "STOPPED",
              controllerDetail: "Existing shared collector service retained during package install.",
              statusError: null
            });
          });
        });
      }
      function ensureRunning(callback) {
        install((installError, state) => {
          if (installError) {
            callback(installError);
            return;
          }
          if (["RUNNING", "STARTING"].includes(state.controllerState)) {
            callback(null, state);
            return;
          }
          controller.start(LS_SERVICE_NAME, (startError) => {
            if (startError) {
              callback(startError);
              return;
            }
            controllerStatus(controller, (_ignored, started) => callback(started.statusError, started));
          });
        });
      }
      function daemonStatus(callback) {
        controllerStatus(controller, callback);
      }
      function inspect(name, callback) {
        controllerStatus(controller, (_unused, service) => {
          if (service.statusError) {
            callback(null, service);
            return;
          }
          if (service.controllerState === "NOT_INSTALLED") {
            callback(null, service);
            return;
          }
          if (!["RUNNING", "STARTING"].includes(service.controllerState)) {
            callback(null, {
              controllerState: service.controllerState === "FAILED" ? "FAILED" : "STOPPED",
              controllerDetail: service.controllerDetail,
              statusError: null
            });
            return;
          }
          let runtime;
          try {
            runtime = readRuntime(files.runtime);
          } catch (runtimeError) {
            callback(null, { controllerState: "UNKNOWN", controllerDetail: runtimeError.message, statusError: runtimeError });
            return;
          }
          const job = runtime.jobs && runtime.jobs[name];
          const runtimeState = job && job.state;
          const mappedState = runtimeState === "running" ? "RUNNING" : runtimeState === "starting" ? "STARTING" : runtimeState === "stopping" ? "STOPPING" : runtimeState === "failed" ? "FAILED" : "STOPPED";
          callback(null, {
            controllerState: mappedState,
            controllerDetail: job && job.stateDetail || service.controllerDetail,
            statusError: null
          });
        });
      }
      function overview(callback) {
        controllerStatus(controller, (_unused, service) => {
          if (service.statusError) {
            callback(null, { service, runtime: { jobs: {} } });
            return;
          }
          try {
            callback(null, { service, runtime: readRuntime(files.runtime) });
          } catch (runtimeError) {
            callback(null, {
              service: { controllerState: "UNKNOWN", controllerDetail: runtimeError.message, statusError: runtimeError },
              runtime: { jobs: {} }
            });
          }
        });
      }
      function lastRun(name, callback) {
        try {
          const runtime = readRuntime(files.runtime);
          const job = runtime.jobs && runtime.jobs[name];
          if (!job) {
            callback(null, null);
            return;
          }
          if (!job.lastReadAt && !job.lastStoredAt && !job.lastError) {
            callback(null, null);
            return;
          }
          callback(null, {
            status: job.lastError ? "failed" : "success",
            lastRunAt: job.lastReadAt || null,
            lastSuccessfulRunAt: job.lastError ? null : job.lastReadAt || null,
            lastStoredAt: job.lastStoredAt || null,
            lastError: job.lastError || null,
            overrunCount: Number.isSafeInteger(job.overrunCount) && job.overrunCount >= 0 ? job.overrunCount : 0,
            queueSkipped: Number.isSafeInteger(job.queueSkipped) && job.queueSkipped >= 0 ? job.queueSkipped : 0,
            lastOverrunAt: job.lastOverrunAt || null,
            methodCalls: []
          });
        } catch (runtimeError) {
          callback(runtimeError);
        }
      }
      function uninstall(callback) {
        controllerStatus(controller, (_unused, state) => {
          if (state.statusError || state.controllerState === "NOT_INSTALLED") {
            callback(state.statusError || null);
            return;
          }
          const remove = () => controller.uninstall(LS_SERVICE_NAME, callback);
          if (["RUNNING", "STARTING"].includes(state.controllerState)) {
            controller.stop(LS_SERVICE_NAME, (stopError) => {
              if (stopError) {
                callback(stopError);
                return;
              }
              remove();
            });
          } else remove();
        });
      }
      return {
        serviceName: LS_SERVICE_NAME,
        syncConfig,
        inspect,
        lastRun,
        install,
        daemonStatus,
        installPackage(callback) {
          try {
            syncConfig();
          } catch (snapshotError) {
            callback(snapshotError);
            return;
          }
          install(callback);
        },
        ensureRunning,
        startDaemon(callback) {
          try {
            syncConfig();
          } catch (snapshotError) {
            callback(snapshotError);
            return;
          }
          ensureRunning(callback);
        },
        start(name, callback) {
          try {
            execControl("start", name);
            callback(null);
          } catch (controlError) {
            callback(controlError);
          }
        },
        stop(name, callback) {
          try {
            execControl("stop", name);
            callback(null);
          } catch (controlError) {
            callback(controlError);
          }
        },
        reload(name, callback) {
          try {
            execControl("reload", name);
            callback(null);
          } catch (controlError) {
            callback(controlError);
          }
        },
        refreshLog(name, callback) {
          try {
            execControl("refresh-log", name);
            callback(null);
          } catch (controlError) {
            callback(controlError);
          }
        },
        clearOverrun(name, callback) {
          try {
            execControl("clear-overrun", name);
            callback(null);
          } catch (controlError) {
            callback(controlError);
          }
        },
        stopDaemon(callback) {
          controllerStatus(controller, (_unused, state) => {
            if (state.statusError || ["NOT_INSTALLED", "STOPPED", "FAILED"].includes(state.controllerState)) {
              callback(state.statusError || null);
              return;
            }
            controller.stop(LS_SERVICE_NAME, callback);
          });
        },
        activeNames() {
          return readActiveJobs(files.active);
        },
        overview,
        reloadAllActive(callback) {
          let names;
          try {
            names = readActiveJobs(files.active);
            this.syncConfig();
          } catch (snapshotError) {
            callback(snapshotError);
            return;
          }
          daemonStatus((_unused, state) => {
            if (state.statusError) {
              callback(state.statusError);
              return;
            }
            if (!["RUNNING", "STARTING"].includes(state.controllerState)) {
              callback(null, { names, reloaded: false });
              return;
            }
            let index = 0;
            const next = (reloadError) => {
              if (reloadError || index >= names.length) {
                callback(reloadError || null, { names, reloaded: true });
                return;
              }
              const name = names[index];
              index += 1;
              this.reload(name, next);
            };
            next(null);
          });
        },
        uninstall
      };
    }
    module2.exports = {
      ACTIVE_FILE,
      BINARY_FILE,
      LS_SERVICE_NAME,
      RUNTIME_FILE,
      SECRET_FILE,
      SNAPSHOT_FILE,
      createLsRuntime,
      readActiveJobs,
      runtimePaths
    };
  }
});

// cgi-bin/src/cgi/db-api.js
var require_db_api = __commonJS({
  "cgi-bin/src/cgi/db-api.js"(exports2, module2) {
    "use strict";
    var process = require("process");
    var httpDefault = require_http();
    var { createDataViewer } = require_data_viewer();
    var { createMetadataReader } = require_metadata_reader();
    var { MAX_SERVER_JSON_BYTES, createServerStore } = require_server_store();
    var { loadSettings } = require_settings_loader();
    var { loadProductPolicy } = require_product_policy();
    var { createLsRuntime } = require_ls_runtime();
    var { createControllerAdapter } = require_controller_adapter();
    var { JobRepository } = require_repository();
    var { error } = require_errors();
    var path = require("path");
    function requestMethod() {
      return String(process.env.get && process.env.get("REQUEST_METHOD") || process.env.REQUEST_METHOD || "GET").toUpperCase();
    }
    function createDbApi(options) {
      const settings = options || {};
      const http = settings.http || httpDefault;
      const store = settings.store || createServerStore({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir });
      const productPolicy = settings.productPolicy || (settings.cgiRoot ? loadProductPolicy(settings.cgiRoot) : null);
      const viewer = settings.viewer || createDataViewer({ cgiRoot: settings.cgiRoot, serverStore: store, productPolicy });
      const metadataReader = settings.metadataReader || createMetadataReader({ clientFactory: settings.clientFactory });
      const method = settings.method || requestMethod;
      function lsRuntime() {
        if (settings.lsRuntime) return settings.lsRuntime;
        if (!settings.cgiRoot) return null;
        const policy = productPolicy || loadProductPolicy(settings.cgiRoot);
        if (policy.target !== "ls") return null;
        return createLsRuntime({
          cgiRoot: settings.cgiRoot,
          controller: createControllerAdapter(),
          serverStore: store,
          repository: settings.repository || new JobRepository({ cgiRoot: settings.cgiRoot, jobDir: settings.jobDir })
        });
      }
      function run(kind) {
        let responded = false;
        const reply = (status, data) => {
          if (responded) return;
          responded = true;
          http.reply(status, { ok: true, data });
        };
        const fail = (failure, status) => {
          if (responded) return;
          responded = true;
          http.fail(failure, status);
        };
        const callback = (status) => (failure, data) => {
          if (failure) fail(failure);
          else reply(status, data);
        };
        const notAllowed = (allowed) => fail(Object.assign(new Error(`${allowed.join(", ")} \uC694\uCCAD\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`), {
          code: "METHOD_NOT_ALLOWED",
          details: { allowed }
        }), 405);
        const query = (arrayKeys) => {
          const result = http.readQuery(void 0, { arrayKeys: arrayKeys || [] });
          if (!result.ok) {
            fail(result.error);
            return null;
          }
          return result.value;
        };
        const body = () => {
          const result = http.readBody(void 0, { maxBytes: MAX_SERVER_JSON_BYTES });
          if (!result.ok) {
            fail(result.error);
            return null;
          }
          try {
            return http.requireObject(result.value, "DB request");
          } catch (failure) {
            fail(failure);
            return null;
          }
        };
        const previewConnection = (payload) => {
          const port = Number(payload?.port);
          if (!payload || typeof payload.host !== "string" || !payload.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535 || typeof payload.user !== "string" || !payload.user || typeof payload.password !== "string" || !payload.password) {
            throw error("DB_SERVER_INVALID", "Database Server \uC5F0\uACB0 \uC124\uC815\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
          }
          return { host: payload.host, port, user: payload.user, password: payload.password };
        };
        try {
          const verb = method();
          if (kind === "server") {
            if (verb === "GET") {
              const params2 = query();
              if (params2) store.getPublic(params2.name, callback(200));
            } else if (verb === "POST") {
              if (lsRuntime()) {
                fail(error("LS_DATABASE_PROFILE_FIXED", "LS\uC5D0\uC11C\uB294 Database \uC124\uC815\uC744 \uCD94\uAC00\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uAE30\uC874 \uC124\uC815\uC744 \uC218\uC815\uD558\uC2ED\uC2DC\uC624."), 409);
                return;
              }
              const payload = body();
              if (payload) store.create(payload, callback(201));
            } else if (verb === "PUT") {
              const params2 = query();
              if (!params2) return;
              const payload = body();
              if (!payload) return;
              const runtime = lsRuntime();
              if (!runtime) {
                store.update(params2.name, payload, callback(200));
                return;
              }
              let active;
              try {
                active = runtime.activeNames();
              } catch (activeError) {
                fail(activeError);
                return;
              }
              if (active.length && payload.restartRunningJobs !== true) {
                fail(error("LS_DATABASE_RESTART_REQUIRED", "Database \uC124\uC815\uC744 \uC800\uC7A5\uD558\uBA74 \uC2E4\uD589 \uC911\uC778 LS Job\uC774 \uC7AC\uC2DC\uC791\uB429\uB2C8\uB2E4.", { jobs: active }), 409);
                return;
              }
              store.update(params2.name, payload, (updateError, value) => {
                if (updateError) {
                  fail(updateError);
                  return;
                }
                if (!active.length) {
                  try {
                    runtime.syncConfig();
                  } catch (snapshotError) {
                    fail(snapshotError);
                    return;
                  }
                  reply(200, value);
                  return;
                }
                runtime.reloadAllActive((reloadError) => {
                  if (reloadError) {
                    fail(reloadError);
                    return;
                  }
                  reply(200, value);
                });
              });
            } else if (verb === "DELETE") {
              const params2 = query();
              if (params2) {
                const defaults = loadSettings(path.join(settings.cgiRoot, "conf.d", "settings.json"));
                if (params2.name === defaults.defaults.database.server) {
                  fail(error("DB_SERVER_DEFAULT_REQUIRED", "\uAE30\uBCF8 Database Server\uB294 \uB2E4\uB978 \uAE30\uBCF8 \uC11C\uBC84\uB97C \uC9C0\uC815\uD558\uAE30 \uC804\uC5D0\uB294 \uC0AD\uC81C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name: params2.name }), 409);
                } else if (lsRuntime()) fail(error("LS_DATABASE_PROFILE_FIXED", "LS\uC5D0\uC11C\uB294 Database \uC124\uC815\uC744 \uC0AD\uC81C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."), 409);
                else store.remove(params2.name, callback(200));
              }
            } else notAllowed(["GET", "POST", "PUT", "DELETE"]);
            return;
          }
          if (kind === "server-list") {
            if (verb !== "GET") notAllowed(["GET"]);
            else store.list(callback(200));
            return;
          }
          const definitions = {
            connect: { verb: "GET", method: "connect" },
            "table-create": { verb: "POST", method: "createTable", body: true, status: 201 },
            "table-list": { verb: "GET", method: "listTables" },
            "table-columns": { verb: "GET", method: "columns" },
            "preview-tables": { verb: "POST", method: "listTables", body: true, target: "metadata" },
            "preview-columns": { verb: "POST", method: "columns", body: true, target: "metadata" },
            "table-tags": { verb: "GET", method: "tags" },
            "table-data": { verb: "GET", method: "data", arrays: ["names"] },
            "table-stat": { verb: "GET", method: "stat", arrays: ["names"] },
            "table-chart": { verb: "GET", method: "chart", arrays: ["names"] }
          };
          const definition = definitions[kind];
          if (!definition) {
            fail(http.requestError("\uC54C \uC218 \uC5C6\uB294 DB API\uC785\uB2C8\uB2E4.", { kind }));
            return;
          }
          if (verb !== definition.verb) {
            notAllowed([definition.verb]);
            return;
          }
          const params = definition.body ? body() : query(definition.arrays);
          if (!params) return;
          if (definition.target === "metadata") {
            let connection;
            try {
              connection = previewConnection(params);
            } catch (previewValidationError) {
              fail(previewValidationError);
              return;
            }
            if (kind === "preview-tables") {
              metadataReader.listTables(connection, (previewError, result) => {
                if (previewError) {
                  fail(error("DB_UNAVAILABLE", "Database\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."));
                  return;
                }
                reply(200, { tables: Array.isArray(result?.tables) ? result.tables : [] });
              });
            } else {
              metadataReader.columns(connection, params.table, (previewError, result) => {
                if (previewError) {
                  fail(error("DB_UNAVAILABLE", "Database\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."));
                  return;
                }
                reply(200, { table: result?.table, tableType: result?.tableType, columns: Array.isArray(result?.columns) ? result.columns : [] });
              });
            }
            return;
          }
          if (kind === "table-data" && params.includeTotal === "true") {
            viewer.dataTotal(params, callback(definition.status || 200));
            return;
          }
          viewer[definition.method](params, callback(definition.status || 200));
        } catch (failure) {
          fail(failure);
        }
      }
      return { run };
    }
    module2.exports = { createDbApi, requestMethod };
  }
});

// cgi-bin/src/log/reader.js
var require_reader = __commonJS({
  "cgi-bin/src/log/reader.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { error } = require_errors();
    var { sanitizeText } = require_sanitize();
    var JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
    var ROTATION = /^(.*)_(\d{8}_\d{6}(?:_\d{3})?)\.log$/;
    var DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
    var DEFAULT_MAX_LINES = 1e3;
    var DEFAULT_MAX_ALL_BYTES = 2 * 1024 * 1024;
    function invalid(reason, details) {
      return error("LOG_REQUEST_INVALID", reason, details);
    }
    function jobName(value) {
      const name = String(value || "");
      if (!JOB_NAME.test(name) || /[\\/]/.test(name)) throw invalid("Job name \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      return name;
    }
    function fileNameForJob(name, value) {
      const file = String(value || `${name}.log`);
      if (path.basename(file) !== file || file.includes("..")) throw invalid("\uB85C\uADF8 \uD30C\uC77C name \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (file === `${name}.log`) return file;
      const match = file.match(ROTATION);
      if (!match || match[1] !== name) throw invalid("\uC120\uD0DD\uD55C Job\uC758 \uB85C\uADF8 \uD30C\uC77C\uC774 \uC544\uB2D9\uB2C8\uB2E4.", { name, file });
      return file;
    }
    function integer(value, fallback, maximum, label) {
      const parsed = value === void 0 || value === null || value === "" ? fallback : Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw invalid(`${label} \uBC94\uC704\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`);
      return parsed;
    }
    function createLogReader(options) {
      const settings = options || {};
      const logDir = settings.logDir || path.join(path.dirname(settings.cgiRoot), "logs");
      const maxFileBytes = settings.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
      const maxLines = settings.maxLines || DEFAULT_MAX_LINES;
      const maxAllBytes = settings.maxAllBytes || DEFAULT_MAX_ALL_BYTES;
      function complete(callback, operation) {
        try {
          callback(null, operation());
        } catch (failure) {
          callback(failure);
        }
      }
      function files() {
        try {
          return fs.readdirSync(logDir).filter((file) => file.endsWith(".log")).sort();
        } catch (failure) {
          if (failure && failure.code === "ENOENT") return [];
          throw error("LOG_UNAVAILABLE", "\uB85C\uADF8 \uBAA9\uB85D\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        }
      }
      function stat(file) {
        try {
          return fs.statSync(path.join(logDir, file));
        } catch (failure) {
          if (failure && failure.code === "ENOENT") throw error("LOG_NOT_FOUND", "\uB85C\uADF8 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { file });
          throw error("LOG_UNAVAILABLE", "\uB85C\uADF8 \uD30C\uC77C \uC815\uBCF4\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { file });
        }
      }
      function read(name, requestedFile, maximum) {
        const file = fileNameForJob(name, requestedFile);
        const info2 = stat(file);
        if (!info2.isFile()) throw error("LOG_NOT_FOUND", "\uB85C\uADF8 \uD30C\uC77C\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { file });
        if (info2.size > maxFileBytes || info2.size > maximum) {
          throw error("LOG_TOO_LARGE", "\uB85C\uADF8 \uD30C\uC77C\uC774 \uC77D\uAE30 \uC0C1\uD55C\uC744 \uB118\uC5C8\uC2B5\uB2C8\uB2E4.", {
            file,
            size: info2.size,
            maximum: Math.min(maxFileBytes, maximum)
          });
        }
        try {
          return { file, info: info2, content: sanitizeText(fs.readFileSync(path.join(logDir, file), "utf8")) };
        } catch (_) {
          throw error("LOG_UNAVAILABLE", "\uB85C\uADF8 \uD30C\uC77C\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { file });
        }
      }
      function info(file, name) {
        const value = stat(file);
        return { name: file, size: value.size, active: file === `${name}.log` };
      }
      return {
        all(callback) {
          complete(callback, () => {
            const grouped = {};
            files().forEach((file) => {
              const rotation = file.match(ROTATION);
              const name = rotation ? rotation[1] : file.slice(0, -4);
              if (!JOB_NAME.test(name)) return;
              if (!grouped[name]) grouped[name] = [];
              grouped[name].push(info(file, name));
            });
            return {
              jobs: Object.keys(grouped).sort().map((name) => ({
                name,
                fileCount: grouped[name].length,
                totalSize: grouped[name].reduce((sum, file) => sum + file.size, 0),
                active: grouped[name].some((file) => file.active),
                files: grouped[name].sort((left, right) => {
                  if (left.active !== right.active) return left.active ? -1 : 1;
                  return left.name.localeCompare(right.name);
                })
              }))
            };
          });
        },
        list(params, callback) {
          complete(callback, () => {
            const name = jobName(params && params.name);
            const result = files().filter((file) => {
              try {
                fileNameForJob(name, file);
                return true;
              } catch (_) {
                return false;
              }
            }).map((file) => info(file, name)).sort((left, right) => {
              if (left.active !== right.active) return left.active ? -1 : 1;
              return left.name.localeCompare(right.name);
            });
            return { name, files: result };
          });
        },
        content(params, callback) {
          complete(callback, () => {
            const name = jobName(params && params.name);
            const page = integer(params && params.page, 1, 1e6, "page");
            const linesPerPage = integer(params && params.lines, Math.min(200, maxLines), maxLines, "lines");
            const value = read(name, params && params.file, maxFileBytes);
            const lines = value.content.split("\n");
            if (lines.length && lines[lines.length - 1] === "") lines.pop();
            const start = (page - 1) * linesPerPage;
            return {
              name,
              file: value.file,
              page,
              linesPerPage,
              totalLines: lines.length,
              lines: lines.slice(start, start + linesPerPage),
              nextPage: start + linesPerPage < lines.length ? page + 1 : null,
              previousPage: page > 1 ? page - 1 : null
            };
          });
        },
        contentAll(params, callback) {
          complete(callback, () => {
            const name = jobName(params && params.name);
            const value = read(name, params && params.file, maxAllBytes);
            return { name, file: value.file, size: value.info.size, content: value.content };
          });
        },
        tail(params, callback) {
          complete(callback, () => {
            const name = jobName(params && params.name);
            const lineCount = integer(params && params.lines, Math.min(200, maxLines), maxLines, "lines");
            const value = read(name, params && params.file, maxFileBytes);
            const lines = value.content.split("\n");
            if (lines.length && lines[lines.length - 1] === "") lines.pop();
            return { name, file: value.file, lines: lines.slice(Math.max(0, lines.length - lineCount)), totalLines: lines.length };
          });
        }
      };
    }
    module2.exports = {
      DEFAULT_MAX_ALL_BYTES,
      DEFAULT_MAX_FILE_BYTES,
      DEFAULT_MAX_LINES,
      createLogReader,
      fileNameForJob,
      jobName
    };
  }
});

// cgi-bin/src/cgi/log-api.js
var require_log_api = __commonJS({
  "cgi-bin/src/cgi/log-api.js"(exports2, module2) {
    "use strict";
    var process = require("process");
    var httpDefault = require_http();
    var { createLogReader } = require_reader();
    function requestMethod() {
      return String(process.env.get && process.env.get("REQUEST_METHOD") || process.env.REQUEST_METHOD || "GET").toUpperCase();
    }
    function createLogApi(options) {
      const settings = options || {};
      const http = settings.http || httpDefault;
      const reader = settings.reader || createLogReader({ cgiRoot: settings.cgiRoot, logDir: settings.logDir });
      const method = settings.method || requestMethod;
      function run(kind) {
        let responded = false;
        const fail = (failure, status) => {
          if (responded) return;
          responded = true;
          http.fail(failure, status);
        };
        const callback = (failure, data) => {
          if (responded) return;
          responded = true;
          if (failure) http.fail(failure);
          else http.reply(200, { ok: true, data });
        };
        if (method() !== "GET") {
          fail(Object.assign(new Error("GET \uC694\uCCAD\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."), {
            code: "METHOD_NOT_ALLOWED",
            details: { allowed: ["GET"] }
          }), 405);
          return;
        }
        const methods = {
          all: "all",
          list: "list",
          content: "content",
          "content-all": "contentAll",
          tail: "tail"
        };
        const target = methods[kind];
        if (!target) {
          fail(http.requestError("\uC54C \uC218 \uC5C6\uB294 Log API\uC785\uB2C8\uB2E4.", { kind }));
          return;
        }
        try {
          if (kind === "all") reader.all(callback);
          else {
            const parsed = http.readQuery();
            if (!parsed.ok) fail(parsed.error);
            else reader[target](parsed.value, callback);
          }
        } catch (failure) {
          fail(failure);
        }
      }
      return { run };
    }
    module2.exports = { createLogApi, requestMethod };
  }
});

// cgi-bin/src/cgi/bootstrap.js
var require_bootstrap = __commonJS({
  "cgi-bin/src/cgi/bootstrap.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var process = require("process");
    var { createDbApi } = require_db_api();
    var { createLogApi } = require_log_api();
    function cgiRoot(script) {
      const source = String(script || process.argv[1] || "");
      const marker = `${path.sep}cgi-bin${path.sep}`;
      const index = source.lastIndexOf(marker);
      if (index < 0) throw new Error("cgi-bin root\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return source.slice(0, index + marker.length - 1);
    }
    function runDb(kind) {
      const root = cgiRoot();
      createDbApi({ cgiRoot: root }).run(kind);
    }
    function runLog(kind) {
      const root = cgiRoot();
      createLogApi({ cgiRoot: root }).run(kind);
    }
    module2.exports = { cgiRoot, runDb, runLog };
  }
});

// cgi-bin/src/dbus/adapter.js
var require_adapter = __commonJS({
  "cgi-bin/src/dbus/adapter.js"(exports2, module2) {
    "use strict";
    function loadDbus(explicit) {
      if (explicit !== void 0) return explicit;
      return require("dbus");
    }
    function createDbusAdapter(explicit) {
      const module3 = loadDbus(explicit);
      let connection = null;
      let connectionKey = null;
      function close() {
        if (connection && typeof connection.close === "function") {
          try {
            connection.close();
          } catch (_) {
          }
        }
        connection = null;
        connectionKey = null;
      }
      function connected(type, destination) {
        const key = `${type}\0${destination || ""}`;
        if (connection && connectionKey === key) return connection;
        close();
        if (!module3 || typeof module3.Connection !== "function") throw new Error("dbus.Connection\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        connection = new module3.Connection({ busType: type });
        connectionKey = key;
        return connection;
      }
      return {
        connect(type, destination) {
          return connected(type, destination);
        },
        call(config, method, args) {
          try {
            return connected(config.busType, config.destination).call({
              destination: config.destination,
              path: method.objectPath,
              method: `${method.interface}.${method.methodName}`,
              args
            });
          } catch (callError) {
            close();
            throw callError;
          }
        },
        introspect(config) {
          try {
            const current = connected(config.busType, config.destination);
            if (typeof current.introspect !== "function") throw new Error("dbus.Connection.introspect\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
            return current.introspect({ destination: config.destination, path: config.objectPath });
          } catch (introspectionError) {
            close();
            throw introspectionError;
          }
        },
        close
      };
    }
    module2.exports = { createDbusAdapter };
  }
});

// cgi-bin/src/ls/interval-policy.js
var require_interval_policy = __commonJS({
  "cgi-bin/src/ls/interval-policy.js"(exports2, module2) {
    "use strict";
    var { createDbusAdapter } = require_adapter();
    var TASK_NUMBER = 0;
    function fallback(source) {
      return { cycleMs: 1, source };
    }
    function resolveIntervalPolicy(options) {
      const settings = options?.settings || {};
      const policy = options?.productPolicy || {};
      if (policy.target !== "ls") return fallback("not-ls");
      if (settings.ls?.interval?.useTaskCycle === false) return fallback("disabled");
      let dbus;
      try {
        dbus = (options?.dbusFactory || (() => createDbusAdapter()))();
        const response = dbus.call(
          { busType: "system", destination: "ls.plc" },
          { objectPath: "/ls/plc/program", interface: "ls.plc.program", methodName: "GetTaskCycleInfo" },
          [`uint16:${TASK_NUMBER}`]
        );
        const body = response?.body;
        const value = Array.isArray(body) && typeof body[0] === "string" ? JSON.parse(body[0]) : null;
        const cycleMs = value && value.rtn === 1 ? Number(value["period-ms"]) : NaN;
        if (!Number.isInteger(cycleMs) || cycleMs < 1 || cycleMs > 864e5) return fallback("invalid-response");
        return { cycleMs, source: "plc" };
      } catch (_) {
        return fallback("unavailable");
      } finally {
        if (dbus) dbus.close();
      }
    }
    function defaultIntervalMs(cycleMs) {
      const cycle = Number.isInteger(cycleMs) && cycleMs > 0 ? cycleMs : 1;
      return Math.ceil(10 / cycle) * cycle;
    }
    module2.exports = { TASK_NUMBER, resolveIntervalPolicy, defaultIntervalMs };
  }
});

// cgi-bin/src/db/validation-adapter.js
var require_validation_adapter = __commonJS({
  "cgi-bin/src/db/validation-adapter.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var NUMERIC_TYPES = /* @__PURE__ */ new Set([
      "byte",
      "short",
      "ushort",
      "integer",
      "int",
      "uint",
      "long",
      "ulong",
      "float",
      "double",
      "number",
      "numeric",
      "decimal"
    ]);
    var INTEGER_TYPES = /* @__PURE__ */ new Set(["byte", "short", "ushort", "integer", "int", "uint", "long", "ulong"]);
    var STRING_TYPES = /* @__PURE__ */ new Set(["char", "varchar", "text", "clob", "string"]);
    function defaultDependencies(options) {
      const settings = options || {};
      const serverModule = require_server_store();
      const metadataModule = require_metadata_reader();
      const dataViewerModule = require_data_viewer();
      const serverStore = serverModule.createServerStore({ cgiRoot: settings.cgiRoot });
      return {
        serverStore,
        metadataReader: metadataModule.createMetadataReader({ cgiRoot: settings.cgiRoot }),
        tableCreator: dataViewerModule.createDataViewer({ cgiRoot: settings.cgiRoot, serverStore })
      };
    }
    function unavailable(reason) {
      return error("DB_UNAVAILABLE", "DB \uC124\uC815\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
        reason: reason && reason.message ? reason.message : String(reason || "DB dependency unavailable")
      });
    }
    function invalid(reason, details) {
      return error("JOB_INVALID", reason, details);
    }
    function callDependency(target, method, args, callback) {
      let completed = false;
      const done = (dependencyError, value) => {
        if (completed) return;
        completed = true;
        callback(dependencyError, value);
      };
      try {
        if (!target || typeof target[method] !== "function") {
          done(new Error(`DB adapter dependency ${method}()\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`));
          return;
        }
        target[method](...args, done);
      } catch (dependencyError) {
        done(dependencyError);
      }
    }
    function columnByName(columns, name) {
      const expected = String(name || "").toUpperCase();
      return columns.find((column) => String(column && column.name || "").toUpperCase() === expected) || null;
    }
    function typeOf(column) {
      return String(column && column.type || "").toLowerCase().replace(/\(.*/, "");
    }
    function validatedExistingMapping(database, metadata, options) {
      const columns = metadata && metadata.columns;
      if (!metadata || String(metadata.tableType || "").toUpperCase() !== "TAG" || !Array.isArray(columns)) {
        throw invalid("\uC120\uD0DD\uD55C table\uC740 TAG table\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.", { table: database.table });
      }
      const primary = columns.find((column) => column && (column.primaryKey === true || column.primary === true));
      const basetime = columns.find((column) => column && column.basetime === true);
      const valueColumn = columnByName(columns, database.valueColumn);
      const configuredStringColumn = String(database.stringValueColumn || "").trim();
      const stringColumn = configuredStringColumn ? columnByName(columns, configuredStringColumn) : null;
      if (!primary || !STRING_TYPES.has(typeOf(primary))) {
        throw invalid("TAG name primary column\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { table: database.table });
      }
      if (!basetime) {
        throw invalid("TAG basetime column\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { table: database.table });
      }
      if (!valueColumn || !NUMERIC_TYPES.has(typeOf(valueColumn))) {
        throw invalid("database.valueColumn\uC740 \uC120\uD0DD\uD55C TAG table\uC758 \uC22B\uC790 column\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.", {
          problem: "value-column",
          table: database.table,
          valueColumn: database.valueColumn
        });
      }
      if (INTEGER_TYPES.has(typeOf(valueColumn)) && options && options.fractionalValuePossible === true) {
        throw invalid("\uC815\uC218 VALUE column\uC5D0\uB294 \uC18C\uC218 \uACB0\uACFC\uAC00 \uAC00\uB2A5\uD55C Tag Transform\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
          problem: "fractional-value",
          table: database.table,
          valueColumn: database.valueColumn
        });
      }
      if (configuredStringColumn && (!stringColumn || !STRING_TYPES.has(typeOf(stringColumn)))) {
        throw invalid("database.stringValueColumn\uC740 \uBB38\uC790\uC5F4 column\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.", {
          problem: "string-value-column",
          table: database.table,
          stringValueColumn: database.stringValueColumn
        });
      }
      return {
        server: database.server,
        table: database.table,
        tagNameColumn: primary.name,
        basetimeColumn: basetime.name,
        valueColumn: valueColumn.name,
        stringValueColumn: stringColumn ? stringColumn.name : null
      };
    }
    function createDatabaseValidationAdapter(options) {
      const settings = options || {};
      let dependencies = null;
      let dependencyError = null;
      try {
        dependencies = settings.serverStore && settings.metadataReader ? settings : (settings.loadDependencies || defaultDependencies)(settings);
        if (!dependencies || !dependencies.serverStore || !dependencies.metadataReader) {
          throw new Error("DB validation dependencies\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
        }
      } catch (loadError) {
        dependencyError = loadError;
      }
      return {
        validate(database, callback) {
          if (dependencyError) {
            callback(unavailable(dependencyError));
            return;
          }
          callDependency(dependencies.serverStore, "get", [database.server], (serverError, server) => {
            if (serverError) {
              callback(unavailable(serverError));
              return;
            }
            if (!server) {
              callback(invalid("\uB4F1\uB85D\uB41C DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { server: database.server }));
              return;
            }
            callDependency(dependencies.metadataReader, "columns", [server, database.table], (metadataError, metadata) => {
              if (metadataError) {
                callback(unavailable(metadataError));
                return;
              }
              try {
                callback(null, validatedExistingMapping(database, metadata));
              } catch (validationError) {
                callback(validationError);
              }
            });
          });
        },
        ensure(database, options2, callback) {
          if (dependencyError) {
            callback(unavailable(dependencyError));
            return;
          }
          callDependency(dependencies.serverStore, "get", [database.server], (serverError, server) => {
            if (serverError) {
              callback(unavailable(serverError));
              return;
            }
            if (!server) {
              callback(invalid("\uB4F1\uB85D\uB41C DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { server: database.server }));
              return;
            }
            callDependency(dependencies.metadataReader, "columns", [server, database.table], (metadataError, metadata) => {
              if (metadataError) {
                callback(unavailable(metadataError));
                return;
              }
              if (!metadata || !metadata.tableType) {
                callback(unavailable(new Error("DB Table \uC870\uD68C \uACB0\uACFC\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.")));
                return;
              }
              if (String(metadata.tableType).toUpperCase() !== "NOT_FOUND") {
                database.table = String(database.table).trim().toUpperCase();
                database.valueColumn = String(database.valueColumn).trim().toUpperCase();
                database.stringValueColumn = String(database.stringValueColumn || "").trim().toUpperCase();
                try {
                  callback(null, validatedExistingMapping(database, metadata, options2));
                } catch (validationError) {
                  callback(validationError);
                }
                return;
              }
              if (!dependencies.tableCreator) {
                callback(unavailable(new Error("DB table creator\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.")));
                return;
              }
              const needsStringValueColumn = options2 && options2.needsStringValueColumn === true;
              database.valueColumn = "VALUE";
              database.stringValueColumn = needsStringValueColumn ? "STR_VALUE" : "";
              database.table = String(database.table).trim().toUpperCase();
              const request = {
                server: database.server,
                table: database.table,
                valueColumn: "VALUE",
                stringValueColumn: needsStringValueColumn ? "STR_VALUE" : null
              };
              callDependency(dependencies.tableCreator, "createTable", [request], (createError, created) => {
                if (createError && createError.code !== "TABLE_ALREADY_EXISTS") {
                  callback(createError);
                  return;
                }
                if (createError) {
                  callDependency(dependencies.metadataReader, "columns", [server, request.table], (raceReadError, raceMetadata) => {
                    if (raceReadError) {
                      callback(unavailable(raceReadError));
                      return;
                    }
                    try {
                      callback(null, validatedExistingMapping(database, raceMetadata, options2));
                    } catch (validationError) {
                      callback(validationError);
                    }
                  });
                  return;
                }
                database.table = String(created && created.table || request.table).trim().toUpperCase();
                const complete = () => callback(null, {
                  server: database.server,
                  table: database.table,
                  valueColumn: database.valueColumn,
                  stringValueColumn: database.stringValueColumn
                });
                if (typeof dependencies.serverStore.setDefaultTableColumns !== "function" || String(server.defaultTable || "").trim().toUpperCase() !== database.table) {
                  complete();
                  return;
                }
                callDependency(dependencies.serverStore, "setDefaultTableColumns", [
                  database.server,
                  database.table,
                  database.valueColumn,
                  database.stringValueColumn
                ], (defaultError) => {
                  if (defaultError) {
                    callback(defaultError);
                    return;
                  }
                  complete();
                });
              });
            });
          });
        }
      };
    }
    module2.exports = { createDatabaseValidationAdapter };
  }
});

// cgi-bin/src/output/storage-policy.js
var require_storage_policy = __commonJS({
  "cgi-bin/src/output/storage-policy.js"(exports2, module2) {
    "use strict";
    var NUMERIC_DBUS_TYPES = /* @__PURE__ */ new Set([
      "byte",
      "uint16",
      "uint32",
      "uint64",
      "int16",
      "int32",
      "int64",
      "double"
    ]);
    function selectionStorageType(selection, outputType) {
      const configuredType = selection && selection.valueType === "array" ? selection.elementType : selection && selection.valueType;
      if (configuredType) return configuredType === "numeric" ? "numeric" : "string";
      return NUMERIC_DBUS_TYPES.has(outputType) ? "numeric" : "string";
    }
    function jobNeedsStringValueColumn(config, interfaceStore) {
      return config.methodCalls.some((call) => {
        const dbusInterface = interfaceStore.find(call.interfaceId);
        const method = dbusInterface.methods.find((candidate) => candidate.id === call.methodId);
        const selections = Array.isArray(call.outputSelections) ? call.outputSelections : [{ sourceIndex: 0 }];
        return selections.some((selection) => selectionStorageType(
          selection,
          method.outputs[selection.sourceIndex] && method.outputs[selection.sourceIndex].type
        ) === "string");
      });
    }
    function tagMayProduceFractionalValue(tag) {
      const source = tag || {};
      const bias = source.bias === void 0 ? 0 : Number(source.bias);
      const multiplier = source.multiplier === void 0 ? 1 : Number(source.multiplier);
      if (!Number.isFinite(bias) || !Number.isFinite(multiplier)) return true;
      if (!Number.isInteger(multiplier)) return true;
      const order = Array.isArray(source.transformOrder) ? source.transformOrder : ["bias", "multiplier"];
      const constant = order[0] === "multiplier" ? bias : bias * multiplier;
      return !Number.isInteger(constant);
    }
    function jobMayProduceFractionalValue(config) {
      return (config && Array.isArray(config.methodCalls) ? config.methodCalls : []).some((call) => {
        const selections = Array.isArray(call && call.outputSelections) ? call.outputSelections : [{ tags: Array.isArray(call && call.tags) ? call.tags : [] }];
        return selections.some((selection) => (Array.isArray(selection && selection.tags) ? selection.tags : []).some(tagMayProduceFractionalValue));
      });
    }
    module2.exports = {
      jobMayProduceFractionalValue,
      jobNeedsStringValueColumn,
      selectionStorageType,
      tagMayProduceFractionalValue
    };
  }
});

// cgi-bin/src/interfaces/validator.js
var require_validator2 = __commonJS({
  "cgi-bin/src/interfaces/validator.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var { normalizeType } = require_types();
    var ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    var OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;
    var DBUS_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
    var MEMBER = /^[A-Za-z_][A-Za-z0-9_]*$/;
    var PARAMETER = /^[A-Za-z_][A-Za-z0-9_]*$/;
    var MAX_IDENTIFIER_LENGTH = 100;
    var MAX_INTERFACES = 128;
    var MAX_METHODS = 128;
    var MAX_PARAMETERS = 64;
    var MAX_XML_BYTES = 256 * 1024;
    function fail(code, reason, details) {
      throw error(code, reason, details);
    }
    function object(value, code, label) {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label}\uC740(\uB294) \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
    }
    function fields(value, allowed, code, label) {
      if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code, `${label}\uC5D0 \uC54C \uC218 \uC5C6\uB294 \uD544\uB4DC\uAC00 \uC788\uC2B5\uB2C8\uB2E4.`);
    }
    function isIdentifier(value) {
      return typeof value === "string" && value.length <= MAX_IDENTIFIER_LENGTH && ID.test(value);
    }
    function identifier(value, code, label) {
      if (!isIdentifier(value)) fail(code, `${label} \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`);
      return value;
    }
    function parameter(value, code) {
      object(value, code, "parameter");
      fields(value, ["name", "type", "required", "validation"], code, "parameter");
      const type = normalizeType(value.type);
      if (typeof value.name !== "string" || !PARAMETER.test(value.name) || type === null) {
        fail(code, "parameter name \uB610\uB294 type\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      if (value.required !== void 0 && typeof value.required !== "boolean") fail(code, "parameter required \uAC12\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (value.validation !== void 0) {
        object(value.validation, code, "parameter validation");
        const validation = value.validation;
        if (Object.keys(validation).some((key) => !["minimum", "maximum", "pattern"].includes(key)) || validation.minimum !== void 0 && typeof validation.minimum !== "number" || validation.maximum !== void 0 && typeof validation.maximum !== "number" || validation.pattern !== void 0 && typeof validation.pattern !== "string") fail(code, "parameter validation \uAC12\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      return {
        name: value.name,
        type,
        ...value.required === void 0 ? {} : { required: value.required },
        ...value.validation === void 0 ? {} : { validation: { ...value.validation } }
      };
    }
    function validateMethod(value) {
      const code = "DBUS_METHOD_INVALID";
      object(value, code, "Method");
      fields(value, ["id", "source", "member", "inputs", "outputs"], code, "Method");
      identifier(value.id, code, "Method ID");
      if (!["discovered", "manual"].includes(value.source)) fail(code, "Method source\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (typeof value.member !== "string" || !MEMBER.test(value.member)) fail(code, "Method member\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (!Array.isArray(value.inputs) || !Array.isArray(value.outputs) || value.inputs.length > MAX_PARAMETERS || value.outputs.length > MAX_PARAMETERS) fail(code, "Method parameter \uC218\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      const inputs = value.inputs.map((item) => parameter(item, code));
      const outputs = value.outputs.map((item) => parameter(item, code));
      const names = /* @__PURE__ */ new Set();
      inputs.concat(outputs).forEach((item) => {
        if (names.has(item.name)) fail(code, "Method parameter name\uC774 \uC911\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        names.add(item.name);
      });
      return { id: value.id, source: value.source, member: value.member, inputs, outputs };
    }
    function validateInterface(value, options) {
      const settings = options || {};
      const code = "DBUS_INTERFACE_INVALID";
      object(value, code, "DBus Interface");
      fields(value, ["schemaVersion", "id", "name", "origin", "builtIn", "busType", "destination", "objectPath", "interface", "methods"], code, "DBus Interface");
      if (value.id !== void 0 || !settings.idOptional) identifier(value.id, code, "Interface ID");
      const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : value.interface;
      if (value.schemaVersion !== 1 || !["discovered", "manual"].includes(value.origin) || typeof value.builtIn !== "boolean" || !["system", "session"].includes(value.busType) || typeof value.destination !== "string" || !DBUS_NAME.test(value.destination) || typeof value.objectPath !== "string" || !OBJECT_PATH.test(value.objectPath) || typeof value.interface !== "string" || !DBUS_NAME.test(value.interface) || !Array.isArray(value.methods) || value.methods.length > MAX_METHODS) fail(code, "DBus Interface \uAC12\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      const methods = value.methods.map(validateMethod);
      const ids = /* @__PURE__ */ new Set();
      methods.forEach((method) => {
        if (ids.has(method.id)) fail(code, "Method ID\uAC00 \uC911\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        if (method.source !== value.origin && !(settings.allowLegacyMixedOrigin && value.origin === "manual")) fail(code, "DBus Interface origin\uACFC Method source\uAC00 \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
        ids.add(method.id);
      });
      if (typeof name !== "string" || name.length > MAX_IDENTIFIER_LENGTH) fail(code, "DBus Interface \uC774\uB984\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      return { schemaVersion: 1, ...value.id === void 0 ? {} : { id: value.id }, name, origin: value.origin, builtIn: value.builtIn, busType: value.busType, destination: value.destination, objectPath: value.objectPath, interface: value.interface, methods };
    }
    function utf8ByteLength(value) {
      const text = String(value);
      let size = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 128) size += 1;
        else if (code < 2048) size += 2;
        else if (code >= 55296 && code <= 56319 && index + 1 < text.length && text.charCodeAt(index + 1) >= 56320 && text.charCodeAt(index + 1) <= 57343) {
          size += 4;
          index += 1;
        } else size += 3;
      }
      return size;
    }
    function validateXmlSize(xml) {
      if (utf8ByteLength(xml) > MAX_XML_BYTES) fail("INTROSPECTION_UNSUPPORTED", "Introspection XML\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4.");
    }
    module2.exports = { isIdentifier, validateInterface, validateMethod, validateXmlSize, MAX_IDENTIFIER_LENGTH, MAX_INTERFACES, MAX_METHODS, MAX_PARAMETERS };
  }
});

// cgi-bin/src/interfaces/store.js
var require_store = __commonJS({
  "cgi-bin/src/interfaces/store.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { error } = require_errors();
    var { writeJsonAtomic } = require_atomic_json();
    var { validateInterface } = require_validator2();
    var InterfaceStore = class {
      constructor(options) {
        this.cgiRoot = options.cgiRoot;
        this.fs = options.fs || fs;
        this.builtInDir = path.join(this.cgiRoot, "interfaces.d");
        this.customDir = path.join(this.cgiRoot, "conf.d", "interfaces");
      }
      readDirectory(directory, builtIn) {
        if (!this.fs.existsSync(directory)) return [];
        return this.fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => {
          let parsed;
          try {
            const raw = JSON.parse(this.fs.readFileSync(path.join(directory, name), "utf8"));
            const methods = raw.methods || [];
            const hasDiscovered = methods.some((method) => method && method.source === "discovered");
            const hasManual = methods.some((method) => method && method.source === "manual");
            const origin = raw.origin || (hasDiscovered && !hasManual ? "discovered" : "manual");
            parsed = validateInterface({ ...raw, name: raw.name || raw.interface, origin }, { allowLegacyMixedOrigin: true });
          } catch (failure) {
            throw error("DBUS_INTERFACE_INVALID", "DBus Interface \uD30C\uC77C\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { file: name });
          }
          if (parsed.id + ".json" !== name) throw error("DBUS_INTERFACE_INVALID", "DBus Interface ID\uC640 \uD30C\uC77C\uBA85\uC774 \uB2E4\uB985\uB2C8\uB2E4.", { file: name });
          return { ...parsed, builtIn };
        });
      }
      list() {
        const all = this.readDirectory(this.builtInDir, true).concat(this.readDirectory(this.customDir, false));
        const ids = /* @__PURE__ */ new Set();
        all.forEach((item) => {
          if (ids.has(item.id)) throw error("DBUS_INTERFACE_INVALID", "DBus Interface ID\uAC00 \uC911\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { id: item.id });
          ids.add(item.id);
        });
        return all;
      }
      find(id) {
        return this.list().find((item) => item.id === id) || null;
      }
      save(value) {
        const valid = { ...validateInterface({ ...value, builtIn: false }), builtIn: false };
        writeJsonAtomic(path.join(this.customDir, valid.id + ".json"), valid);
        return valid;
      }
      remove(id) {
        this.fs.unlinkSync(path.join(this.customDir, id + ".json"));
      }
    };
    module2.exports = { InterfaceStore };
  }
});

// cgi-bin/src/config/sha256.js
var require_sha256 = __commonJS({
  "cgi-bin/src/config/sha256.js"(exports2, module2) {
    "use strict";
    var ROUND_CONSTANTS = [
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ];
    function add(left, right) {
      return (left >>> 0) + (right >>> 0) >>> 0;
    }
    function rotateRight(value, amount) {
      return (value >>> amount | value << 32 - amount) >>> 0;
    }
    function utf8Bytes(value) {
      var text = String(value);
      var bytes = [];
      for (var index = 0; index < text.length; index += 1) {
        var code = text.charCodeAt(index);
        if (code >= 55296 && code <= 56319) {
          var next = text.charCodeAt(index + 1);
          if (next >= 56320 && next <= 57343) {
            code = 65536 + (code - 55296 << 10) + (next - 56320);
            index += 1;
          } else code = 65533;
        } else if (code >= 56320 && code <= 57343) code = 65533;
        if (code < 128) bytes.push(code);
        else if (code < 2048) bytes.push(192 | code >>> 6, 128 | code & 63);
        else if (code < 65536) bytes.push(224 | code >>> 12, 128 | code >>> 6 & 63, 128 | code & 63);
        else bytes.push(240 | code >>> 18, 128 | code >>> 12 & 63, 128 | code >>> 6 & 63, 128 | code & 63);
      }
      return bytes;
    }
    function wordHex(value) {
      var hex = (value >>> 0).toString(16);
      return "00000000".slice(hex.length) + hex;
    }
    function sha256(value) {
      var bytes = utf8Bytes(value);
      var bitLength = bytes.length * 8;
      bytes.push(128);
      while (bytes.length % 64 !== 56) bytes.push(0);
      var highLength = Math.floor(bitLength / 4294967296);
      var lowLength = bitLength >>> 0;
      bytes.push(
        highLength >>> 24 & 255,
        highLength >>> 16 & 255,
        highLength >>> 8 & 255,
        highLength & 255,
        lowLength >>> 24 & 255,
        lowLength >>> 16 & 255,
        lowLength >>> 8 & 255,
        lowLength & 255
      );
      var h0 = 1779033703;
      var h1 = 3144134277;
      var h2 = 1013904242;
      var h3 = 2773480762;
      var h4 = 1359893119;
      var h5 = 2600822924;
      var h6 = 528734635;
      var h7 = 1541459225;
      for (var offset = 0; offset < bytes.length; offset += 64) {
        var words = new Array(64);
        var word;
        for (word = 0; word < 16; word += 1) {
          var position = offset + word * 4;
          words[word] = (bytes[position] << 24 | bytes[position + 1] << 16 | bytes[position + 2] << 8 | bytes[position + 3]) >>> 0;
        }
        for (word = 16; word < 64; word += 1) {
          var smallSigma0 = rotateRight(words[word - 15], 7) ^ rotateRight(words[word - 15], 18) ^ words[word - 15] >>> 3;
          var smallSigma1 = rotateRight(words[word - 2], 17) ^ rotateRight(words[word - 2], 19) ^ words[word - 2] >>> 10;
          words[word] = add(add(add(words[word - 16], smallSigma0), words[word - 7]), smallSigma1);
        }
        var a = h0;
        var b = h1;
        var c = h2;
        var d = h3;
        var e = h4;
        var f = h5;
        var g = h6;
        var h = h7;
        for (word = 0; word < 64; word += 1) {
          var bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
          var choose = e & f ^ ~e & g;
          var temporary1 = add(add(add(add(h, bigSigma1), choose), ROUND_CONSTANTS[word]), words[word]);
          var bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
          var majority = a & b ^ a & c ^ b & c;
          var temporary2 = add(bigSigma0, majority);
          h = g;
          g = f;
          f = e;
          e = add(d, temporary1);
          d = c;
          c = b;
          b = a;
          a = add(temporary1, temporary2);
        }
        h0 = add(h0, a);
        h1 = add(h1, b);
        h2 = add(h2, c);
        h3 = add(h3, d);
        h4 = add(h4, e);
        h5 = add(h5, f);
        h6 = add(h6, g);
        h7 = add(h7, h);
      }
      return wordHex(h0) + wordHex(h1) + wordHex(h2) + wordHex(h3) + wordHex(h4) + wordHex(h5) + wordHex(h6) + wordHex(h7);
    }
    module2.exports = { sha256 };
  }
});

// cgi-bin/src/config/profile-lock-key.js
var require_profile_lock_key = __commonJS({
  "cgi-bin/src/config/profile-lock-key.js"(exports2, module2) {
    "use strict";
    var { sha256 } = require_sha256();
    function profileLockKey(profileId) {
      return sha256(String(profileId));
    }
    module2.exports = { profileLockKey };
  }
});

// cgi-bin/src/jobs/defaults.js
var require_defaults = __commonJS({
  "cgi-bin/src/jobs/defaults.js"(exports2, module2) {
    "use strict";
    function jobDefaults() {
      return {
        schemaVersion: 1,
        schedule: { intervalMs: 1e3 },
        retry: { initialDelayMs: 5e3, maximumDelayMs: 3e4, multiplier: 2 },
        execution: { savePolicy: "perMethod", onMethodError: "stop" },
        methodCalls: [],
        database: { server: "", table: "TAG", valueColumn: "VALUE", stringValueColumn: "STR_VALUE" },
        // maxFiles is retained in Job documents for backward compatibility.
        // Actual PLC rotation is the global settings.logging policy.
        log: { level: "info", maxFiles: 3 }
      };
    }
    module2.exports = { jobDefaults };
  }
});

// cgi-bin/src/jobs/index-repository.js
var require_index_repository = __commonJS({
  "cgi-bin/src/jobs/index-repository.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { writeJsonAtomic } = require_atomic_json();
    var { error } = require_errors();
    var { validateJobName } = require_validator();
    var INDEX_SCHEMA_VERSION = 1;
    function tagsForCall(call) {
      if (Array.isArray(call && call.outputSelections)) {
        return call.outputSelections.flatMap((selection) => Array.isArray(selection.tags) ? selection.tags : []);
      }
      return Array.isArray(call && call.tags) ? call.tags : [];
    }
    function fromDocument(document) {
      const calls = Array.isArray(document && document.methodCalls) ? document.methodCalls : [];
      return {
        schemaVersion: INDEX_SCHEMA_VERSION,
        name: document.name,
        profileId: document.profileId || "",
        revision: document.revision,
        intervalMs: document.schedule && document.schedule.intervalMs,
        methodCallCount: calls.length,
        tagCount: calls.reduce((total, call) => total + tagsForCall(call).length, 0),
        interfaceIds: [...new Set(calls.map((call) => call.interfaceId).filter(Boolean))].sort(),
        methodReferences: calls.map((call) => ({
          interfaceId: call.interfaceId,
          methodId: call.methodId,
          callId: call.id
        })),
        database: {
          server: document.database && document.database.server,
          table: document.database && document.database.table,
          valueColumn: document.database && document.database.valueColumn,
          stringValueColumn: document.database && document.database.stringValueColumn || ""
        },
        execution: {
          savePolicy: document.execution && document.execution.savePolicy,
          onMethodError: document.execution && document.execution.onMethodError
        },
        logLevel: document.log && document.log.level || "info"
      };
    }
    function validateIndex(name, value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== INDEX_SCHEMA_VERSION || value.name !== name || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isInteger(value.methodCallCount) || value.methodCallCount < 0 || !Number.isInteger(value.tagCount) || value.tagCount < 0 || typeof value.profileId !== "string" || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1 || !Array.isArray(value.interfaceIds) || !Array.isArray(value.methodReferences) || value.interfaceIds.some((item) => typeof item !== "string" || !item) || value.methodReferences.length !== value.methodCallCount || value.methodReferences.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof item.interfaceId !== "string" || !item.interfaceId || typeof item.methodId !== "string" || !item.methodId || typeof item.callId !== "string" || !item.callId) || !value.database || typeof value.database !== "object" || Array.isArray(value.database) || ["server", "table", "valueColumn", "stringValueColumn"].some((field) => typeof value.database[field] !== "string") || !value.execution || typeof value.execution !== "object" || Array.isArray(value.execution) || typeof value.execution.savePolicy !== "string" || typeof value.execution.onMethodError !== "string" || typeof value.logLevel !== "string" || !value.logLevel) {
        throw error("JOB_INVALID_CONFIG", "Job summary\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. Job\uC744 \uB2E4\uC2DC \uC800\uC7A5\uD558\uC2ED\uC2DC\uC624.", {
          name,
          summaryUnavailable: true
        });
      }
      return value;
    }
    var JobIndexRepository = class {
      constructor(options) {
        const settings = options || {};
        this.directory = settings.directory || path.join(settings.cgiRoot, "conf.d", "job-index");
        this.jobDirectory = settings.jobDirectory || path.join(settings.cgiRoot, "conf.d", "jobs");
        fs.mkdirSync(this.directory, { recursive: true });
      }
      file(name) {
        return path.join(this.directory, `${validateJobName(name)}.json`);
      }
      jobFile(name) {
        return path.join(this.jobDirectory, `${validateJobName(name)}.json`);
      }
      exists(name) {
        return fs.existsSync(this.file(name));
      }
      registered(name) {
        return fs.existsSync(this.jobFile(name)) && this.exists(name);
      }
      read(name) {
        validateJobName(name);
        let value;
        try {
          value = JSON.parse(fs.readFileSync(this.file(name), "utf8"));
        } catch (failure) {
          if (failure && failure.code === "ENOENT") {
            throw error("JOB_NOT_FOUND", "Job summary\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name, summaryUnavailable: true });
          }
          throw error("JOB_INVALID_CONFIG", "Job summary\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. Job\uC744 \uB2E4\uC2DC \uC800\uC7A5\uD558\uC2ED\uC2DC\uC624.", {
            name,
            summaryUnavailable: true
          });
        }
        return validateIndex(name, value);
      }
      write(document) {
        validateJobName(document && document.name);
        const value = validateIndex(document.name, fromDocument(document));
        writeJsonAtomic(this.file(document.name), value);
        return value;
      }
      remove(name) {
        const target = this.file(name);
        try {
          fs.unlinkSync(target);
        } catch (failure) {
          if (!failure || failure.code !== "ENOENT") throw failure;
        }
      }
      list() {
        if (!fs.existsSync(this.directory)) return [];
        return fs.readdirSync(this.directory).filter((entry) => entry.endsWith(".json")).sort().flatMap((entry) => {
          const name = entry.slice(0, -5);
          try {
            validateJobName(name);
            if (!fs.existsSync(this.jobFile(name))) return [];
            return [{ name, index: this.read(name), error: null }];
          } catch (failure) {
            return [{ name, index: null, error: failure }];
          }
        });
      }
    };
    module2.exports = { INDEX_SCHEMA_VERSION, JobIndexRepository, fromDocument, validateIndex };
  }
});

// cgi-bin/src/jobs/manager.js
var require_manager = __commonJS({
  "cgi-bin/src/jobs/manager.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var { error } = require_errors();
    var { loadSettings } = require_settings_loader();
    var { loadProductPolicy } = require_product_policy();
    var { resolveIntervalPolicy } = require_interval_policy();
    var { createDatabaseValidationAdapter } = require_validation_adapter();
    var { jobMayProduceFractionalValue, jobNeedsStringValueColumn } = require_storage_policy();
    var { InterfaceStore } = require_store();
    var { profileLockKey: interfaceLockKey } = require_profile_lock_key();
    var { classifyControllerState } = require_controller_state();
    var { createControllerAdapter, isNotInstalled } = require_controller_adapter();
    var { createLsRuntime } = require_ls_runtime();
    var { createServerStore } = require_server_store();
    var { jobDefaults } = require_defaults();
    var { createJobOperationLock } = require_operation_lock();
    var { JobIndexRepository, fromDocument: indexFromDocument } = require_index_repository();
    var { JobRepository, revisionOf } = require_repository();
    var { deepMerge, validateJobConfig, validateJobName } = require_validator();
    var SERVICE_PREFIX = "_dbu_";
    function serviceName(name) {
      return `${SERVICE_PREFIX}${validateJobName(name)}`;
    }
    function publicError(source) {
      return {
        code: source && source.code || "INTERNAL_ERROR",
        reason: source && source.message ? source.message : String(source || "unknown error"),
        details: source && source.details || {}
      };
    }
    function controllerFailure(code, reason, name, state, detail) {
      return error(code, reason, {
        name,
        controllerState: state || "UNKNOWN",
        controllerDetail: detail || null
      });
    }
    function stripName(document) {
      const config = { ...document };
      delete config.name;
      delete config.revision;
      return config;
    }
    function sameConfig(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }
    function tagsForCall(call) {
      if (Array.isArray(call && call.outputSelections)) {
        return call.outputSelections.flatMap((selection) => Array.isArray(selection.tags) ? selection.tags : []);
      }
      return Array.isArray(call && call.tags) ? call.tags : [];
    }
    function pick(source, fields) {
      const result = {};
      fields.forEach((field) => {
        if (source && Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
      });
      return result;
    }
    function projectLastRun(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const result = pick(value, [
        "startedAt",
        "completedAt",
        "status",
        "lastRunAt",
        "lastSuccessfulRunAt",
        "lastStoredAt",
        "lastError",
        "overrunCount",
        "queueSkipped",
        "lastOverrunAt"
      ]);
      if (Array.isArray(value.methodCalls)) {
        result.methodCalls = value.methodCalls.map((method) => pick(method, [
          "id",
          "name",
          "interfaceId",
          "methodId",
          "requestedAt",
          "completedAt",
          "status",
          "storedCount",
          "error"
        ]));
      }
      return result;
    }
    var JobManager = class {
      constructor(options) {
        const settings = options || {};
        this.cgiRoot = settings.cgiRoot;
        this.controller = settings.controller || createControllerAdapter(settings.serviceModule);
        this.database = settings.databaseAdapter || createDatabaseValidationAdapter({ cgiRoot: this.cgiRoot });
        this.repository = settings.repository || new JobRepository({
          cgiRoot: this.cgiRoot,
          jobDir: settings.jobDir
        });
        this.interfaceStore = settings.interfaceStore || new InterfaceStore({ cgiRoot: this.cgiRoot });
        this.productPolicy = settings.productPolicy || loadProductPolicy(this.cgiRoot);
        this.dbusFactory = settings.dbusFactory;
        this.isLs = this.productPolicy.target === "ls";
        this.indexRepository = settings.indexRepository || (this.isLs ? new JobIndexRepository({
          cgiRoot: this.cgiRoot,
          jobDirectory: this.repository.directory,
          directory: settings.jobIndexDir
        }) : null);
        this.serverStore = settings.serverStore || createServerStore({ cgiRoot: this.cgiRoot });
        this.lsRuntime = this.isLs ? settings.lsRuntime || createLsRuntime({
          cgiRoot: this.cgiRoot,
          controller: this.controller,
          repository: this.repository,
          serverStore: this.serverStore,
          process: settings.process
        }) : null;
        this.operationLock = settings.operationLock || createJobOperationLock({
          directory: path.join(this.cgiRoot, "conf.d", ".job-operation-locks")
        });
        this.packageLifecycleLock = settings.packageLifecycleLock || createJobOperationLock({
          directory: path.join(this.cgiRoot, "conf.d", ".package-lifecycle-locks")
        });
        this.interfaceMutationLock = settings.interfaceMutationLock || createJobOperationLock({
          directory: path.join(this.cgiRoot, "conf.d", ".interface-mutation-locks")
        });
        this.interfaceReaderLock = settings.interfaceReaderLock || createJobOperationLock({
          directory: path.join(this.cgiRoot, "conf.d", ".interface-mutation-readers")
        });
        this.settingsFile = settings.settingsFile || path.join(this.cgiRoot, "conf.d", "settings.json");
        this.collectorPath = settings.collectorPath || path.join(this.cgiRoot, "neo-collector.js");
      }
      get jobDir() {
        return this.repository.directory;
      }
      validateName(name) {
        return validateJobName(name);
      }
      serviceName(name) {
        return serviceName(name);
      }
      configPath(name) {
        return this.repository.file(name);
      }
      settings() {
        return loadSettings(this.settingsFile);
      }
      requestJsonMaxBytes() {
        return this.productPolicy.maxRequestJsonBytes;
      }
      validateConfig(config, options) {
        const productLimits = this.productPolicy.validationLimits || {};
        const enforceInterval = options?.enforceInterval !== false;
        const intervalPolicy = enforceInterval ? resolveIntervalPolicy({ settings: this.settings(), productPolicy: this.productPolicy, dbusFactory: this.dbusFactory }) : { cycleMs: 1 };
        const validated = validateJobConfig(config, {
          interfaceStore: this.interfaceStore,
          limits: { ...this.settings().limits, ...productLimits },
          minimumIntervalMs: this.productPolicy.minimumIntervalMs || 1e3,
          intervalCycleMs: intervalPolicy.cycleMs,
          maxJobJsonBytes: this.productPolicy.maxJobJsonBytes
        });
        const productValidated = this.productPolicy.validateProductConfig(validated);
        if (this.isLs && options?.enforceDatabaseProfile !== false && productValidated.database.server !== this.settings().defaults.database.server) {
          throw error("LS_DATABASE_PROFILE_REQUIRED", "LS Job\uC740 \uAE30\uBCF8 Database \uC124\uC815\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.", {
            server: this.settings().defaults.database.server
          });
        }
        return productValidated;
      }
      validateDatabase(config, callback) {
        if (!this.isLs) {
          this.database.validate(config.database, callback);
          return;
        }
        this.serverStore.get(config.database.server, (serverError, server) => {
          if (serverError) {
            callback(serverError);
            return;
          }
          if (!server) {
            callback(error("DB_SERVER_NOT_FOUND", "\uB4F1\uB85D DB server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { server: config.database.server }));
            return;
          }
          config.database = {
            ...config.database,
            table: server.defaultTable || config.database.table,
            valueColumn: server.valueColumn || config.database.valueColumn,
            stringValueColumn: server.stringValueColumn || config.database.stringValueColumn
          };
          this.database.validate(config.database, callback);
        });
      }
      databaseOptions(config) {
        return {
          needsStringValueColumn: jobNeedsStringValueColumn(config, this.interfaceStore),
          fractionalValuePossible: jobMayProduceFractionalValue(config)
        };
      }
      callback(callback, operation) {
        try {
          operation();
        } catch (operationError) {
          callback(operationError);
        }
      }
      assertPackageLifecycleAvailable(name) {
        try {
          this.packageLifecycleLock.assertAvailable("package-lifecycle");
        } catch (failure) {
          if (failure && failure.code === "JOB_CONFLICT") {
            throw error("JOB_CONFLICT", "package lifecycle\uC774 Job \uBCC0\uACBD\uC744 \uC9C4\uD589\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.", { name });
          }
          throw failure;
        }
      }
      assertInterfaceMutationAvailable(interfaceId, name) {
        try {
          this.interfaceMutationLock.assertAvailable(interfaceLockKey(interfaceId));
        } catch (failure) {
          if (failure && failure.code === "JOB_CONFLICT") {
            throw error("JOB_CONFLICT", "DBus Interface \uBCC0\uACBD\uC774 Job \uC2DC\uC791 \uB610\uB294 \uC800\uC7A5\uC744 \uC9C4\uD589\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.", { name, interfaceId });
          }
          throw failure;
        }
      }
      withMutation(name, callback, operation) {
        let handle;
        let holdInterfaces;
        const readers = [];
        const heldInterfaceIds = /* @__PURE__ */ new Set();
        try {
          this.assertPackageLifecycleAvailable(name);
          handle = this.operationLock.acquire(name);
          this.assertPackageLifecycleAvailable(name);
          holdInterfaces = (config) => {
            const ids = [...new Set((config && config.methodCalls || []).map((call) => call && call.interfaceId).filter((id) => typeof id === "string"))].sort();
            ids.forEach((interfaceId) => {
              if (heldInterfaceIds.has(interfaceId)) return;
              this.assertInterfaceMutationAvailable(interfaceId, name);
              const reader = this.interfaceReaderLock.acquire(`${interfaceLockKey(interfaceId)}--${name}`);
              readers.push(reader);
              heldInterfaceIds.add(interfaceId);
              this.assertInterfaceMutationAvailable(interfaceId, name);
            });
          };
        } catch (failure) {
          readers.reverse().forEach((reader) => {
            try {
              reader.release();
            } catch (_) {
            }
          });
          if (handle) {
            try {
              handle.release();
            } catch (cleanupError) {
              if (failure && (typeof failure === "object" || typeof failure === "function")) {
                failure.cleanupError = cleanupError;
              }
            }
          }
          callback(failure);
          return;
        }
        let finished = false;
        const done = (failure, value) => {
          if (finished) return;
          finished = true;
          let releaseFailure = null;
          readers.reverse().forEach((reader) => {
            try {
              reader.release();
            } catch (cleanupError) {
              if (!releaseFailure) releaseFailure = cleanupError;
            }
          });
          try {
            handle.release();
          } catch (cleanupError) {
            releaseFailure = cleanupError;
          }
          if (failure && releaseFailure && (typeof failure === "object" || typeof failure === "function")) {
            failure.cleanupError = releaseFailure;
          }
          callback(failure || releaseFailure, value);
        };
        try {
          operation(handle, done, holdInterfaces);
        } catch (failure) {
          done(failure);
        }
      }
      withLifecycleHandle(name, handles, callback, operation) {
        let finished = false;
        const done = (failure, value) => {
          if (finished) return;
          finished = true;
          callback(failure, value);
        };
        try {
          const validatedName = this.validateName(name);
          const handle = handles.get(validatedName);
          if (!handle) throw error("JOB_CONFLICT", "package lifecycle \uB300\uC0C1 Job lock\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", { name: validatedName });
          handle.assertOwned();
          operation(validatedName, handle, done);
        } catch (failure) {
          done(failure);
        }
      }
      acquirePackageLifecycle(names) {
        const handles = /* @__PURE__ */ new Map();
        let fence = null;
        const releaseAll = () => {
          let releaseFailure = null;
          [...handles.entries()].reverse().forEach(([name, handle]) => {
            try {
              handle.release();
              handles.delete(name);
            } catch (failure) {
              if (!releaseFailure) releaseFailure = failure;
            }
          });
          if (handles.size === 0 && fence) {
            try {
              fence.release();
              fence = null;
            } catch (failure) {
              if (!releaseFailure) releaseFailure = failure;
            }
          }
          if (releaseFailure) throw releaseFailure;
        };
        fence = this.packageLifecycleLock.acquire("package-lifecycle");
        const releaseSession = () => {
          if (handles.size === 0 && !fence) return;
          releaseAll();
        };
        const acquireNames = (requestedNames) => {
          if (!fence) throw error("JOB_CONFLICT", "package lifecycle lock\uC774 \uC774\uBBF8 \uD574\uC81C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
          try {
            const orderedNames = [...new Set(
              (requestedNames || []).map((name) => this.validateName(name))
            )].sort();
            orderedNames.forEach((name) => {
              if (!handles.has(name)) handles.set(name, this.operationLock.acquire(name));
            });
          } catch (failure) {
            try {
              releaseSession();
            } catch (cleanupError) {
              if (failure && (typeof failure === "object" || typeof failure === "function")) {
                failure.cleanupError = cleanupError;
              }
            }
            throw failure;
          }
        };
        acquireNames(names);
        return {
          acquire: acquireNames,
          stopForPackage: (name, callback) => this.withLifecycleHandle(
            name,
            handles,
            callback,
            (validatedName, handle, done) => this.stopForPackageWithHandle(validatedName, handle, done)
          ),
          delete: (name, callback) => this.withLifecycleHandle(
            name,
            handles,
            callback,
            (validatedName, handle, done) => this.deleteWithHandle(validatedName, handle, done)
          ),
          release: () => {
            releaseSession();
          }
        };
      }
      callController(method, args, callback) {
        let finished = false;
        const done = (callError, value) => {
          if (finished) return;
          finished = true;
          callback(callError, value);
        };
        try {
          if (!this.controller || typeof this.controller[method] !== "function") {
            done(new Error(`Controller service.${method}()\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`));
            return;
          }
          this.controller[method](...args, done);
        } catch (callError) {
          done(callError);
        }
      }
      inspect(name, callback) {
        if (this.isLs) {
          this.lsRuntime.inspect(name, callback);
          return;
        }
        const target = this.serviceName(name);
        this.callController("status", [target], (statusError, info) => {
          if (statusError && isNotInstalled(statusError)) {
            callback(null, {
              controllerState: "NOT_INSTALLED",
              controllerDetail: null,
              info: null,
              statusError: null
            });
            return;
          }
          if (statusError) {
            const failure = controllerFailure(
              "CONTROLLER_UNAVAILABLE",
              "Controller \uC0C1\uD0DC\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
              name,
              "UNKNOWN",
              statusError.message
            );
            callback(null, {
              controllerState: "UNKNOWN",
              controllerDetail: statusError.message || null,
              info: null,
              statusError: failure
            });
            return;
          }
          const classified = classifyControllerState(info);
          const stateError = classified.known ? null : controllerFailure(
            "CONTROLLER_UNKNOWN",
            "Controller \uC0C1\uD0DC\uB97C \uC54C \uC218 \uC5C6\uC5B4 \uC548\uC804\uD558\uAC8C \uC791\uC5C5\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
            name,
            "UNKNOWN",
            classified.detail || "\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uAC70\uB098 \uBE44\uC5B4 \uC788\uB294 Controller \uC751\uB2F5\uC785\uB2C8\uB2E4."
          );
          callback(null, {
            controllerState: classified.state,
            controllerDetail: classified.detail || null,
            info,
            statusError: stateError
          });
        });
      }
      view(name, config, state, configError, revision) {
        const statusKnown = !state.statusError && state.controllerState !== "UNKNOWN";
        const installed = statusKnown ? state.controllerState !== "NOT_INSTALLED" : null;
        const running = statusKnown ? ["RUNNING", "STARTING", "STOPPING"].includes(state.controllerState) : null;
        return {
          name,
          config,
          configState: statusKnown ? installed ? "installed" : "config-only" : null,
          executionState: statusKnown ? running ? "running" : "stopped" : null,
          controllerState: state.controllerState,
          controllerDetail: state.controllerDetail,
          statusKnown,
          installed,
          running,
          ...Number.isInteger(revision) ? { revision } : {},
          ...configError ? { error: publicError(configError) } : {},
          ...state.statusError ? { controllerError: publicError(state.statusError) } : {}
        };
      }
      readValidated(name) {
        const document = this.repository.read(name);
        const revision = revisionOf(document);
        try {
          return { document, config: this.validateConfig(stripName(document), { enforceInterval: false, enforceDatabaseProfile: false }), revision };
        } catch (validationError) {
          if (validationError && validationError.code === "JOB_INVALID_CONFIG") throw validationError;
          throw error("JOB_INVALID_CONFIG", "\uC800\uC7A5\uB41C Job \uC124\uC815\uC774 schemaVersion 1 \uACC4\uC57D\uACFC \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", {
            name,
            cause: validationError.message,
            revision
          });
        }
      }
      readIndex(name) {
        if (!this.indexRepository.registered(name)) {
          throw error("JOB_NOT_FOUND", "Job\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
        }
        return this.indexRepository.read(name);
      }
      syncIndex(document) {
        if (!this.isLs) return null;
        const expected = indexFromDocument(document);
        let current = null;
        try {
          current = this.indexRepository.read(document.name);
        } catch (_) {
        }
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
          return this.indexRepository.write(document);
        }
        return current;
      }
      configFromIndex(index, databaseCache) {
        const cache = databaseCache || {};
        let database = cache[index.database.server];
        if (!database) {
          let called = false;
          let readError = null;
          let server = null;
          this.serverStore.get(index.database.server, (failure, value) => {
            called = true;
            readError = failure;
            server = value;
          });
          if (!called) throw new Error("LS Database profile read must complete synchronously.");
          if (readError) throw readError;
          database = {
            ...index.database,
            ...server && server.defaultTable ? { table: server.defaultTable } : {},
            ...server && server.valueColumn ? { valueColumn: server.valueColumn } : {},
            ...server ? { stringValueColumn: server.stringValueColumn || "" } : {}
          };
          cache[index.database.server] = database;
        }
        return {
          schedule: { intervalMs: index.intervalMs },
          methodCalls: index.methodReferences.map((reference) => ({
            id: reference.callId,
            interfaceId: reference.interfaceId,
            methodId: reference.methodId
          })),
          database: { ...database },
          execution: { ...index.execution },
          log: { level: index.logLevel }
        };
      }
      lsState(overview, name) {
        const service = overview && overview.service || {
          controllerState: "UNKNOWN",
          controllerDetail: null,
          statusError: new Error("LS collector state is unavailable.")
        };
        if (service.statusError || service.controllerState === "NOT_INSTALLED") return service;
        if (!["RUNNING", "STARTING"].includes(service.controllerState)) {
          return {
            controllerState: service.controllerState === "FAILED" ? "FAILED" : "STOPPED",
            controllerDetail: service.controllerDetail,
            statusError: null
          };
        }
        const runtime = overview.runtime && overview.runtime.jobs && overview.runtime.jobs[name];
        const runtimeState = runtime && runtime.state;
        const controllerState = runtimeState === "running" ? "RUNNING" : runtimeState === "starting" ? "STARTING" : runtimeState === "stopping" ? "STOPPING" : runtimeState === "failed" ? "FAILED" : "STOPPED";
        return {
          controllerState,
          controllerDetail: runtime && runtime.stateDetail || service.controllerDetail,
          statusError: null
        };
      }
      lsLastRun(runtimeJob) {
        if (!runtimeJob) return null;
        if (!runtimeJob.lastReadAt && !runtimeJob.lastStoredAt && !runtimeJob.lastError) return null;
        return projectLastRun({
          status: runtimeJob.lastError ? "failed" : "success",
          lastRunAt: runtimeJob.lastReadAt || null,
          lastSuccessfulRunAt: runtimeJob.lastError ? null : runtimeJob.lastReadAt || null,
          lastStoredAt: runtimeJob.lastStoredAt || null,
          lastError: runtimeJob.lastError || null,
          overrunCount: Number.isSafeInteger(runtimeJob.overrunCount) && runtimeJob.overrunCount >= 0 ? runtimeJob.overrunCount : 0,
          queueSkipped: Number.isSafeInteger(runtimeJob.queueSkipped) && runtimeJob.queueSkipped >= 0 ? runtimeJob.queueSkipped : 0,
          lastOverrunAt: runtimeJob.lastOverrunAt || null,
          methodCalls: []
        });
      }
      diagnostic(name, callback) {
        let value;
        try {
          value = this.readValidated(name);
        } catch (configError) {
          if (configError.code !== "JOB_INVALID_CONFIG") {
            callback(configError);
            return;
          }
          callback(null, this.view(name, null, {
            controllerState: "UNKNOWN",
            controllerDetail: configError.message,
            statusError: null
          }, configError, configError.details && configError.details.revision));
          return;
        }
        this.inspect(name, (_unused, state) => callback(null, this.view(name, value.config, state, null, value.revision)));
      }
      get(name, callback) {
        this.callback(callback, () => {
          this.validateName(name);
          if (this.isLs && !this.indexRepository.exists(name)) {
            if (!this.repository.exists(name)) {
              throw error("JOB_NOT_FOUND", "Job\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name });
            }
            throw error("JOB_INVALID_CONFIG", "This Job configuration cannot be read. Recreate the Job before continuing.", {
              name,
              registrationMissing: true
            });
          }
          if (this.isLs) this.readIndex(name);
          this.diagnostic(name, callback);
        });
      }
      status(name, callback) {
        if (!this.isLs) {
          this.get(name, (getError, detail) => {
            if (getError) {
              callback(getError);
              return;
            }
            this.lastRun(name, (lastRunError, value) => callback(lastRunError, {
              job: detail,
              lastRun: value && value.lastRun || null
            }));
          });
          return;
        }
        let index;
        try {
          index = this.readIndex(this.validateName(name));
        } catch (readError) {
          callback(readError);
          return;
        }
        this.lsRuntime.overview((_unused, overview) => {
          try {
            const state = this.lsState(overview, name);
            const config = this.configFromIndex(index);
            const job = this.view(name, config, state, null, index.revision);
            job.methodCallCount = index.methodCallCount;
            job.tagCount = index.tagCount;
            callback(null, {
              job,
              lastRun: this.lsLastRun(overview.runtime && overview.runtime.jobs && overview.runtime.jobs[name])
            });
          } catch (statusError) {
            callback(statusError);
          }
        });
      }
      summary(detail, lastRun) {
        const config = detail.config;
        return {
          name: detail.name,
          interfaceIds: config ? [...new Set((config.methodCalls || []).map((call) => call.interfaceId))].sort() : [],
          methodCallCount: config && Array.isArray(config.methodCalls) ? config.methodCalls.length : 0,
          configState: detail.configState,
          executionState: detail.executionState,
          controllerState: detail.controllerState,
          controllerDetail: detail.controllerDetail,
          statusKnown: detail.statusKnown,
          installed: detail.installed,
          running: detail.running,
          lastStoredAt: lastRun && lastRun.lastStoredAt || null,
          ...detail.error ? { error: detail.error } : {},
          ...detail.controllerError ? { controllerError: detail.controllerError } : {}
        };
      }
      readLastRun(name, state, callback) {
        if (this.isLs) {
          this.lsRuntime.lastRun(name, callback);
          return;
        }
        if (state.installed === false) {
          callback(null, null);
          return;
        }
        if (state.installed === null) {
          callback(state.statusError || controllerFailure(
            "CONTROLLER_UNKNOWN",
            "Controller \uC0C1\uD0DC\uB97C \uC54C \uC218 \uC5C6\uC5B4 service details\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
            name,
            state.controllerState,
            state.controllerDetail
          ));
          return;
        }
        this.callController("details", [this.serviceName(name), "lastRun"], callback);
      }
      listFromLsOverview(records, overview) {
        const databaseCache = {};
        return records.map((record) => {
          if (record.error || !record.index) {
            const state2 = { controllerState: "UNKNOWN", controllerDetail: record.error && record.error.message, statusError: null };
            return this.summary(this.view(record.name, null, state2, record.error), null);
          }
          const state = this.lsState(overview, record.name);
          const detail = this.view(record.name, this.configFromIndex(record.index, databaseCache), state, null, record.index.revision);
          const runtimeJob = overview.runtime && overview.runtime.jobs && overview.runtime.jobs[record.name];
          return {
            ...this.summary(detail, this.lsLastRun(runtimeJob)),
            tagCount: record.index.tagCount
          };
        });
      }
      list(callback) {
        if (this.isLs) {
          let records2;
          try {
            records2 = this.indexRepository.list();
          } catch (listError) {
            callback(listError);
            return;
          }
          if (!records2.length) {
            callback(null, []);
            return;
          }
          this.lsRuntime.overview((_unused, overview) => {
            try {
              callback(null, this.listFromLsOverview(records2, overview));
            } catch (listError) {
              callback(listError);
            }
          });
          return;
        }
        let records;
        try {
          records = this.repository.list();
        } catch (listError) {
          callback(listError);
          return;
        }
        if (!records.length) {
          callback(null, []);
          return;
        }
        const values = new Array(records.length);
        let pending = records.length;
        records.forEach((record, index) => {
          this.diagnostic(record.name, (detailError, detail) => {
            const resolved = detailError ? this.view(record.name, null, {
              controllerState: "UNKNOWN",
              controllerDetail: detailError.message,
              statusError: null
            }, detailError) : detail;
            if (resolved.installed !== true) {
              values[index] = this.summary(resolved, null);
              pending -= 1;
              if (pending === 0) callback(null, values);
              return;
            }
            this.readLastRun(record.name, resolved, (lastRunError, lastRun) => {
              if (lastRunError && !resolved.controllerError) {
                resolved.controllerError = publicError(controllerFailure(
                  "CONTROLLER_UNAVAILABLE",
                  "service details\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                  record.name,
                  resolved.controllerState,
                  lastRunError.message
                ));
              }
              values[index] = this.summary(resolved, projectLastRun(lastRun));
              pending -= 1;
              if (pending === 0) callback(null, values);
            });
          });
        });
      }
      health(callback) {
        if (!this.isLs) {
          this.list((listError, jobs) => callback(listError, { jobs: jobs || [], daemonState: null }));
          return;
        }
        let records;
        try {
          records = this.indexRepository.list();
        } catch (listError) {
          callback(listError);
          return;
        }
        this.lsRuntime.overview((_unused, overview) => {
          try {
            callback(null, {
              jobs: this.listFromLsOverview(records, overview),
              daemonState: overview.service
            });
          } catch (listError) {
            callback(listError);
          }
        });
      }
      create(payload, callback) {
        if (this.isLs) {
          this.createLs(payload, callback);
          return;
        }
        this.callback(callback, () => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw error("JOB_INVALID", "Job create body\uB294 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
          }
          const unknown = Object.keys(payload).filter((key) => !["name", "config"].includes(key));
          if (unknown.length || !Object.prototype.hasOwnProperty.call(payload, "config")) {
            throw error("JOB_INVALID", "Job create body\uB294 name\uACFC config\uB9CC \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4.", { fields: unknown });
          }
          const name = this.validateName(payload.name);
          this.withMutation(name, callback, (handle, done, holdInterfaces) => {
            let config;
            try {
              holdInterfaces(payload.config);
              config = this.validateConfig(payload.config);
            } catch (validationError) {
              done(validationError);
              return;
            }
            this.inspect(name, (_unused, state) => {
              if (state.statusError) {
                done(state.statusError);
                return;
              }
              if (state.controllerState !== "NOT_INSTALLED") {
                done(error("SERVICE_ALREADY_INSTALLED", "\uAC19\uC740 \uC774\uB984\uC758 Controller service\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", {
                  name,
                  controllerState: state.controllerState
                }));
                return;
              }
              this.database.ensure(config.database, this.databaseOptions(config), (databaseError) => {
                if (databaseError) {
                  done(databaseError);
                  return;
                }
                let document;
                const discardConfig = (failure) => {
                  try {
                    handle.assertOwned();
                    this.repository.remove(name);
                  } catch (cleanupError) {
                    failure.details = { ...failure.details || {}, cleanupError: cleanupError.message };
                  }
                  done(failure);
                };
                try {
                  handle.assertOwned();
                  document = this.repository.create(name, config);
                } catch (createError) {
                  done(createError);
                  return;
                }
                const descriptor = {
                  name: this.serviceName(name),
                  enable: false,
                  working_dir: this.cgiRoot,
                  executable: this.collectorPath,
                  args: [`${name}.json`]
                };
                try {
                  handle.assertOwned();
                } catch (ownershipError) {
                  discardConfig(ownershipError);
                  return;
                }
                this.callController("install", [descriptor], (installError) => {
                  if (installError) {
                    discardConfig(controllerFailure(
                      "CONTROLLER_UNAVAILABLE",
                      "Job service\uB97C \uC790\uB3D9 \uC124\uCE58\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                      name,
                      "NOT_INSTALLED",
                      installError.message
                    ));
                    return;
                  }
                  this.inspect(name, (_inspectError, after) => {
                    if (!after.statusError && after.controllerState === "STOPPED") {
                      done(null, this.view(name, config, after, null, revisionOf(document)));
                      return;
                    }
                    const failure = after.statusError || controllerFailure(
                      "CONTROLLER_OPERATION_FAILED",
                      "\uC790\uB3D9 \uC124\uCE58\uD55C service\uAC00 STOPPED \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.",
                      name,
                      after.controllerState,
                      after.controllerDetail
                    );
                    try {
                      handle.assertOwned();
                    } catch (ownershipError) {
                      discardConfig(ownershipError);
                      return;
                    }
                    this.callController("uninstall", [this.serviceName(name)], (cleanupError) => {
                      if (cleanupError) failure.details = { ...failure.details || {}, cleanupError: cleanupError.message };
                      discardConfig(failure);
                    });
                  });
                });
              });
            });
          });
        });
      }
      warnings(name, config) {
        const currentTags = /* @__PURE__ */ new Set();
        config.methodCalls.forEach((call) => tagsForCall(call).forEach((tag) => currentTags.add(tag.name)));
        const jobs = [];
        const tags = /* @__PURE__ */ new Set();
        const registeredNames = this.isLs ? new Set(this.indexRepository.list().filter((record) => record.index).map((record) => record.name)) : null;
        this.repository.list().forEach((record) => {
          if (registeredNames && !registeredNames.has(record.name)) return;
          if (!record.document || record.name === name) return;
          const other = stripName(record.document);
          if (!other.database || other.database.server !== config.database.server || other.database.table !== config.database.table || !Array.isArray(other.methodCalls)) return;
          let matched = false;
          other.methodCalls.forEach((call) => {
            tagsForCall(call).forEach((tag) => {
              if (currentTags.has(tag.name)) {
                matched = true;
                tags.add(tag.name);
              }
            });
          });
          if (matched) jobs.push(record.name);
        });
        if (!jobs.length) return [];
        return [{
          code: "TAG_NAME_USED_BY_ANOTHER_JOB",
          reason: "\uAC19\uC740 DB table\uC758 Tag name\uC744 \uB2E4\uB978 Job\uB3C4 \uC0AC\uC6A9\uD569\uB2C8\uB2E4.",
          path: "/methodCalls",
          details: { jobs: jobs.sort(), tags: [...tags].sort() }
        }];
      }
      validate(payload, callback) {
        this.callback(callback, () => {
          const source = payload && Object.prototype.hasOwnProperty.call(payload, "config") ? payload.config : payload;
          const name = payload && Object.prototype.hasOwnProperty.call(payload, "name") ? this.validateName(payload.name) : null;
          const config = this.validateConfig(source);
          this.validateDatabase(config, (databaseError) => {
            if (databaseError) {
              callback(databaseError);
              return;
            }
            try {
              callback(null, { valid: true, warnings: this.warnings(name, config) });
            } catch (warningError) {
              callback(warningError);
            }
          });
        });
      }
      guardMutable(name, callback) {
        let value;
        try {
          value = this.readValidated(name);
        } catch (readError) {
          callback(readError);
          return;
        }
        this.inspect(name, (_unused, state) => {
          if (state.statusError) {
            callback(state.statusError);
            return;
          }
          if (["RUNNING", "STARTING", "STOPPING"].includes(state.controllerState)) {
            callback(error("JOB_RUNNING", "\uC2E4\uD589 \uC911\uC774\uAC70\uB098 \uC804\uD658 \uC911\uC778 Job\uC740 \uBC14\uAFB8\uAC70\uB098 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
              name,
              controllerState: state.controllerState
            }));
            return;
          }
          callback(null, value, state);
        });
      }
      update(name, patch, callback) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, "name")) {
          callback(error("JOB_NAME_IMMUTABLE", "Job name\uC740 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { name }));
          return;
        }
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          callback(error("JOB_INVALID", "Job patch\uB294 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4."));
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done, holdInterfaces) => {
            this.guardMutable(name, (guardError, current) => {
              if (guardError) {
                done(guardError);
                return;
              }
              try {
                const { revision: _clientRevision, ...configPatch } = patch;
                const existing = current.config;
                holdInterfaces(existing);
                const merged = deepMerge(deepMerge(jobDefaults(), existing), configPatch);
                holdInterfaces(merged);
                const config = this.validateConfig(merged);
                this.database.ensure(config.database, this.databaseOptions(config), (databaseError) => {
                  if (databaseError) {
                    done(databaseError);
                    return;
                  }
                  try {
                    handle.assertOwned();
                    if (sameConfig(existing, config)) {
                      this.syncIndex(current.document);
                      this.inspect(name, (_unused, state) => done(null, this.view(
                        name,
                        existing,
                        state,
                        null,
                        current.revision
                      )));
                      return;
                    }
                    const nextRevision = current.revision + 1;
                    const document = this.repository.save(
                      name,
                      { ...config, name, revision: nextRevision },
                      current.revision
                    );
                    this.syncIndex(document);
                    this.inspect(name, (_unused, state) => done(null, this.view(
                      name,
                      stripName(document),
                      state,
                      null,
                      revisionOf(document)
                    )));
                  } catch (saveError) {
                    done(saveError);
                  }
                });
              } catch (updateError) {
                done(updateError);
              }
            });
          });
        });
      }
      // Log level is operational metadata rather than a data-plane configuration.
      // LS can apply it to the daemon without stopping a reader or resetting its
      // runtime checkpoint. All other Job edits remain blocked while running.
      updateLog(name, patch, callback) {
        if (!this.isLs) {
          callback(error("LOG_HOT_APPLY_NOT_AVAILABLE", "\uC2E4\uD589 \uC911 Log Level \uBCC0\uACBD\uC740 LS \uC81C\uD488\uC5D0\uC11C\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.", { name }));
          return;
        }
        if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some((key) => !["revision", "level"].includes(key))) {
          callback(error("JOB_INVALID", "Log Level \uBCC0\uACBD\uC740 revision\uACFC level\uB9CC \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4.", { name }));
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done, holdInterfaces) => {
            let current;
            try {
              current = this.readValidated(name);
              holdInterfaces(current.config);
            } catch (readError) {
              done(readError);
              return;
            }
            let config;
            try {
              config = this.validateConfig({
                ...current.config,
                log: { ...current.config.log, level: patch.level }
              }, { enforceDatabaseProfile: false });
            } catch (validationError) {
              done(validationError);
              return;
            }
            this.inspect(name, (_unused, before) => {
              if (before.statusError) {
                done(before.statusError);
                return;
              }
              let document;
              try {
                handle.assertOwned();
                if (sameConfig(current.config, config)) {
                  this.syncIndex(current.document);
                  const completeUnchanged = () => done(
                    null,
                    this.view(name, current.config, before, null, current.revision)
                  );
                  if (before.controllerState !== "RUNNING") {
                    completeUnchanged();
                    return;
                  }
                  this.lsRuntime.refreshLog(name, (controlError) => {
                    if (controlError) {
                      done(controllerFailure("CONTROLLER_OPERATION_FAILED", "LS Job Log Level\uC744 \uC989\uC2DC \uBC18\uC601\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", name, "RUNNING", controlError.message));
                      return;
                    }
                    completeUnchanged();
                  });
                  return;
                }
                const nextRevision = current.revision + 1;
                document = this.repository.save(
                  name,
                  { ...config, name, revision: nextRevision },
                  current.revision
                );
                this.syncIndex(document);
              } catch (saveError) {
                done(saveError);
                return;
              }
              const complete = () => this.inspect(name, (_ignored, after) => done(
                after.statusError,
                this.view(name, config, after, null, revisionOf(document))
              ));
              if (before.controllerState !== "RUNNING") {
                complete();
                return;
              }
              this.lsRuntime.refreshLog(name, (controlError) => {
                if (controlError) {
                  done(controllerFailure("CONTROLLER_OPERATION_FAILED", "LS Job Log Level\uC744 \uC989\uC2DC \uBC18\uC601\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", name, "RUNNING", controlError.message));
                  return;
                }
                complete();
              });
            });
          });
        });
      }
      clearOverrun(name, callback) {
        if (!this.isLs) {
          callback(error("OVERRUN_CLEAR_NOT_AVAILABLE", "Skipped cycle \uCD08\uAE30\uD654\uB294 LS \uC81C\uD488\uC5D0\uC11C\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.", { name }));
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            try {
              this.readIndex(name);
            } catch (readError) {
              done(readError);
              return;
            }
            try {
              handle.assertOwned();
            } catch (lockError) {
              done(lockError);
              return;
            }
            this.lsRuntime.clearOverrun(name, (controlError) => {
              if (controlError) {
                done(controllerFailure("CONTROLLER_OPERATION_FAILED", "LS Job skipped cycle \uCD08\uAE30\uD654\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", name, "UNKNOWN", controlError.message));
                return;
              }
              this.lsRuntime.lastRun(name, (runtimeError, lastRun) => {
                if (runtimeError) {
                  done(runtimeError);
                  return;
                }
                done(null, { lastRun: projectLastRun(lastRun) });
              });
            });
          });
        });
      }
      install(name, callback) {
        if (this.isLs) {
          this.installLs(name, callback);
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done, holdInterfaces) => {
            const current = this.readValidated(name);
            try {
              holdInterfaces(current.config);
            } catch (interfaceConflict) {
              done(interfaceConflict);
              return;
            }
            this.inspect(name, (_unused, before) => {
              if (before.statusError) {
                done(before.statusError);
                return;
              }
              if (before.controllerState !== "NOT_INSTALLED") {
                done(error("SERVICE_ALREADY_INSTALLED", "Job service\uAC00 \uC774\uBBF8 \uC124\uCE58\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.", {
                  name,
                  controllerState: before.controllerState
                }));
                return;
              }
              const descriptor = {
                name: this.serviceName(name),
                enable: false,
                working_dir: this.cgiRoot,
                executable: this.collectorPath,
                args: [`${name}.json`]
              };
              try {
                handle.assertOwned();
              } catch (ownershipError) {
                done(ownershipError);
                return;
              }
              this.callController("install", [descriptor], (installError) => {
                if (installError) {
                  done(controllerFailure(
                    "CONTROLLER_UNAVAILABLE",
                    "Job service\uB97C \uC124\uCE58\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                    name,
                    "NOT_INSTALLED",
                    installError.message
                  ));
                  return;
                }
                this.inspect(name, (_inspectError, after) => {
                  if (!after.statusError && after.controllerState === "STOPPED") {
                    done(null, this.view(name, current.config, after));
                    return;
                  }
                  const failure = after.statusError || controllerFailure(
                    "CONTROLLER_OPERATION_FAILED",
                    "\uC124\uCE58\uD55C service\uAC00 STOPPED \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.",
                    name,
                    after.controllerState,
                    after.controllerDetail
                  );
                  try {
                    handle.assertOwned();
                  } catch (ownershipError) {
                    done(ownershipError);
                    return;
                  }
                  this.callController("uninstall", [this.serviceName(name)], (cleanupError) => {
                    if (cleanupError) failure.details.cleanupError = cleanupError.message;
                    done(failure);
                  });
                });
              });
            });
          });
        });
      }
      start(name, callback) {
        if (this.isLs) {
          this.startLs(name, callback);
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done, holdInterfaces) => {
            const current = this.readValidated(name);
            try {
              holdInterfaces(current.config);
            } catch (interfaceConflict) {
              done(interfaceConflict);
              return;
            }
            this.inspect(name, (_unused, before) => {
              if (before.statusError) {
                done(before.statusError);
                return;
              }
              if (["RUNNING", "STARTING", "STOPPING"].includes(before.controllerState)) {
                done(error("JOB_RUNNING", "\uC2E4\uD589 \uC911\uC774\uAC70\uB098 \uC804\uD658 \uC911\uC778 Job\uC740 \uC2DC\uC791\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
                  name,
                  controllerState: before.controllerState
                }));
                return;
              }
              const startInstalled = (installedState) => this.validateDatabase(current.config, (databaseError) => {
                if (databaseError) {
                  done(databaseError);
                  return;
                }
                try {
                  handle.assertOwned();
                } catch (ownershipError) {
                  done(ownershipError);
                  return;
                }
                this.callController("start", [this.serviceName(name)], (startError) => {
                  if (startError) {
                    done(controllerFailure(
                      "CONTROLLER_UNAVAILABLE",
                      "Job service\uB97C \uC2DC\uC791\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                      name,
                      installedState.controllerState,
                      startError.message
                    ));
                    return;
                  }
                  this.inspect(name, (_inspectError, after) => {
                    if (after.statusError) done(after.statusError);
                    else if (!["RUNNING", "STARTING"].includes(after.controllerState)) done(controllerFailure(
                      "CONTROLLER_OPERATION_FAILED",
                      "\uC2DC\uC791 \uC694\uCCAD \uB4A4 service\uAC00 \uC2DC\uC791 \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.",
                      name,
                      after.controllerState,
                      after.controllerDetail
                    ));
                    else done(null, this.view(name, current.config, after));
                  });
                });
              });
              if (before.controllerState !== "NOT_INSTALLED") {
                startInstalled(before);
                return;
              }
              const descriptor = {
                name: this.serviceName(name),
                enable: false,
                working_dir: this.cgiRoot,
                executable: this.collectorPath,
                args: [`${name}.json`]
              };
              try {
                handle.assertOwned();
              } catch (ownershipError) {
                done(ownershipError);
                return;
              }
              this.callController("install", [descriptor], (installError) => {
                if (installError) {
                  done(controllerFailure(
                    "CONTROLLER_UNAVAILABLE",
                    "Job service\uB97C \uC790\uB3D9 \uC124\uCE58\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                    name,
                    "NOT_INSTALLED",
                    installError.message
                  ));
                  return;
                }
                this.inspect(name, (_inspectError, installedState) => {
                  if (installedState.statusError) {
                    done(installedState.statusError);
                    return;
                  }
                  if (installedState.controllerState !== "STOPPED") {
                    done(controllerFailure(
                      "CONTROLLER_OPERATION_FAILED",
                      "\uC790\uB3D9 \uC124\uCE58\uD55C service\uAC00 STOPPED \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.",
                      name,
                      installedState.controllerState,
                      installedState.controllerDetail
                    ));
                    return;
                  }
                  startInstalled(installedState);
                });
              });
            });
          });
        });
      }
      stop(name, callback) {
        if (this.isLs) {
          this.stopLs(name, callback);
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            const current = this.readValidated(name);
            this.inspect(name, (_unused, before) => {
              if (before.statusError) {
                done(before.statusError);
                return;
              }
              if (before.controllerState === "NOT_INSTALLED") {
                done(error("SERVICE_NOT_INSTALLED", "Job service\uAC00 \uC124\uCE58\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", { name }));
                return;
              }
              if (["STARTING", "STOPPING"].includes(before.controllerState)) {
                done(error("JOB_RUNNING", "\uC804\uD658 \uC911\uC778 Job\uC740 \uC0C8 lifecycle \uC694\uCCAD\uC744 \uBC1B\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
                  name,
                  controllerState: before.controllerState
                }));
                return;
              }
              if (before.controllerState !== "RUNNING") {
                done(error("SERVICE_NOT_RUNNING", "\uC2E4\uD589 \uC911\uC778 Job service\uB9CC \uBA48\uCD9C \uC218 \uC788\uC2B5\uB2C8\uB2E4.", {
                  name,
                  controllerState: before.controllerState
                }));
                return;
              }
              try {
                handle.assertOwned();
              } catch (ownershipError) {
                done(ownershipError);
                return;
              }
              this.callController("stop", [this.serviceName(name)], (stopError) => {
                if (stopError) {
                  done(controllerFailure(
                    "CONTROLLER_UNAVAILABLE",
                    "Job service\uB97C \uBA48\uCD94\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                    name,
                    before.controllerState,
                    stopError.message
                  ));
                  return;
                }
                this.inspect(name, (_inspectError, after) => {
                  if (after.statusError) done(after.statusError);
                  else if (!["STOPPING", "STOPPED"].includes(after.controllerState)) done(controllerFailure(
                    "CONTROLLER_OPERATION_FAILED",
                    "\uC911\uC9C0 \uC694\uCCAD \uB4A4 service\uAC00 \uC911\uC9C0 \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.",
                    name,
                    after.controllerState,
                    after.controllerDetail
                  ));
                  else done(null, this.view(name, current.config, after));
                });
              });
            });
          });
        });
      }
      stopForPackage(name, callback) {
        if (this.isLs) {
          this.stopForPackageLs(name, callback);
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            this.stopForPackageWithHandle(name, handle, done);
          });
        });
      }
      stopForPackageWithHandle(name, handle, done) {
        const current = this.readValidated(name);
        this.inspect(name, (_unused, before) => {
          if (before.statusError) {
            done(before.statusError);
            return;
          }
          if (["NOT_INSTALLED", "STOPPED", "FAILED"].includes(before.controllerState)) {
            done(null, this.view(name, current.config, before));
            return;
          }
          if (!["RUNNING", "STARTING", "STOPPING"].includes(before.controllerState)) {
            done(controllerFailure(
              "CONTROLLER_UNKNOWN",
              "Controller \uC0C1\uD0DC\uB97C \uC54C \uC218 \uC5C6\uC5B4 package stop\uC744 \uC9C4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.",
              name,
              before.controllerState,
              before.controllerDetail
            ));
            return;
          }
          try {
            handle.assertOwned();
          } catch (ownershipError) {
            done(ownershipError);
            return;
          }
          this.callController("stop", [this.serviceName(name)], (stopError) => {
            if (stopError) {
              done(controllerFailure(
                "CONTROLLER_UNAVAILABLE",
                "package stop \uC911 Job service\uB97C \uBA48\uCD94\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                name,
                before.controllerState,
                stopError.message
              ));
              return;
            }
            this.inspect(name, (_inspectError, after) => {
              if (after.statusError) {
                done(after.statusError);
                return;
              }
              if (!["NOT_INSTALLED", "STOPPED", "FAILED"].includes(after.controllerState)) {
                done(controllerFailure(
                  "CONTROLLER_OPERATION_FAILED",
                  "package stop \uB4A4 service\uAC00 \uC548\uC804\uD55C \uC815\uC9C0 \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.",
                  name,
                  after.controllerState,
                  after.controllerDetail
                ));
                return;
              }
              done(null, this.view(name, current.config, after));
            });
          });
        });
      }
      delete(name, callback) {
        if (this.isLs) {
          this.deleteLs(name, callback);
          return;
        }
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            this.deleteWithHandle(name, handle, done);
          });
        });
      }
      deleteWithHandle(name, handle, done) {
        this.guardMutable(name, (guardError, _current, state) => {
          if (guardError) {
            done(guardError);
            return;
          }
          const removeConfig = () => {
            try {
              handle.assertOwned();
              done(null, this.repository.remove(name));
            } catch (removeError) {
              done(removeError);
            }
          };
          if (state.controllerState === "NOT_INSTALLED") {
            removeConfig();
            return;
          }
          try {
            handle.assertOwned();
          } catch (ownershipError) {
            done(ownershipError);
            return;
          }
          this.callController("uninstall", [this.serviceName(name)], (uninstallError) => {
            if (uninstallError && !isNotInstalled(uninstallError)) {
              done(controllerFailure(
                "CONTROLLER_UNAVAILABLE",
                "Job service\uB97C \uC815\uB9AC\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.",
                name,
                state.controllerState,
                uninstallError.message
              ));
              return;
            }
            removeConfig();
          });
        });
      }
      // LS keeps the public Job lifecycle but maps it to one daemon service and
      // logical per-Job control commands. Generic deliberately does not use this
      // path until its separate migration branch.
      createLs(payload, callback) {
        this.callback(callback, () => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some((key) => !["name", "config"].includes(key)) || !Object.prototype.hasOwnProperty.call(payload, "config")) {
            throw error("JOB_INVALID", "Job create body\uB294 name\uACFC config\uB9CC \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4.");
          }
          const name = this.validateName(payload.name);
          this.withMutation(name, callback, (handle, done, holdInterfaces) => {
            let config;
            try {
              holdInterfaces(payload.config);
              config = this.validateConfig(payload.config);
            } catch (validationError) {
              done(validationError);
              return;
            }
            try {
              handle.assertOwned();
              const hasDocument = this.repository.exists(name);
              const hasIndex = this.indexRepository.exists(name);
              if (hasDocument && hasIndex) {
                done(error("JOB_ALREADY_EXISTS", "\uAC19\uC740 \uC774\uB984\uC758 Job\uC774 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { name }));
                return;
              }
              if (hasDocument) this.repository.discard(name);
              if (hasIndex) this.indexRepository.remove(name);
            } catch (cleanupError) {
              done(cleanupError);
              return;
            }
            this.database.ensure(config.database, this.databaseOptions(config), (databaseError) => {
              if (databaseError) {
                done(databaseError);
                return;
              }
              let document;
              try {
                handle.assertOwned();
                document = this.repository.createAtomic(name, config);
                this.indexRepository.write(document);
                this.lsRuntime.syncConfig();
              } catch (createError) {
                done(createError);
                return;
              }
              this.lsRuntime.install((installError) => {
                if (installError) {
                  try {
                    this.repository.discard(name);
                    this.indexRepository.remove(name);
                  } catch (_) {
                  }
                  done(controllerFailure("CONTROLLER_UNAVAILABLE", "LS collector daemon\uC744 \uC124\uCE58\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", name, "NOT_INSTALLED", installError.message));
                  return;
                }
                this.inspect(name, (_unused, state) => done(state.statusError, this.view(
                  name,
                  config,
                  state,
                  null,
                  revisionOf(document)
                )));
              });
            });
          });
        });
      }
      installLs(name, callback) {
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            let index;
            try {
              index = this.readIndex(name);
              this.lsRuntime.syncConfig();
            } catch (readError) {
              done(readError);
              return;
            }
            try {
              handle.assertOwned();
            } catch (ownershipError) {
              done(ownershipError);
              return;
            }
            this.lsRuntime.install((installError) => {
              if (installError) {
                done(controllerFailure("CONTROLLER_UNAVAILABLE", "LS collector daemon\uC744 \uC124\uCE58\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", name, "NOT_INSTALLED", installError.message));
                return;
              }
              this.inspect(name, (_unused, state) => done(state.statusError, this.view(
                name,
                this.configFromIndex(index),
                state,
                null,
                index.revision
              )));
            });
          });
        });
      }
      startLs(name, callback) {
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            let index;
            try {
              index = this.readIndex(name);
            } catch (readError) {
              done(readError);
              return;
            }
            try {
              handle.assertOwned();
            } catch (ownershipError) {
              done(ownershipError);
              return;
            }
            this.lsRuntime.ensureRunning((startError) => {
              if (startError) {
                done(controllerFailure("CONTROLLER_UNAVAILABLE", "LS collector daemon\uC744 \uC2DC\uC791\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", name, "UNKNOWN", startError.message));
                return;
              }
              this.lsRuntime.start(name, (controlError) => {
                if (controlError) {
                  done(controllerFailure("CONTROLLER_OPERATION_FAILED", "LS Job \uC2DC\uC791 \uC81C\uC5B4\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", name, "STOPPED", controlError.message));
                  return;
                }
                this.inspect(name, (_ignored, after) => {
                  if (after.statusError || !["STARTING", "RUNNING"].includes(after.controllerState)) {
                    done(after.statusError || controllerFailure("CONTROLLER_OPERATION_FAILED", "LS Job \uC2DC\uC791 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", name, after.controllerState, after.controllerDetail));
                  } else done(null, this.view(name, this.configFromIndex(index), after, null, index.revision));
                });
              });
            });
          });
        });
      }
      stopLs(name, callback) {
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            let index;
            try {
              index = this.readIndex(name);
            } catch (readError) {
              done(readError);
              return;
            }
            try {
              handle.assertOwned();
            } catch (ownershipError) {
              done(ownershipError);
              return;
            }
            this.lsRuntime.stop(name, (stopError) => {
              if (stopError) {
                done(controllerFailure("CONTROLLER_OPERATION_FAILED", "LS Job \uC911\uC9C0 \uC81C\uC5B4\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", name, "RUNNING", stopError.message));
                return;
              }
              this.inspect(name, (_ignored, after) => done(after.statusError, this.view(
                name,
                this.configFromIndex(index),
                after,
                null,
                index.revision
              )));
            });
          });
        });
      }
      stopForPackageLs(name, callback) {
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            let index;
            try {
              index = this.readIndex(name);
            } catch (readError) {
              done(readError);
              return;
            }
            this.inspect(name, (_unused, before) => {
              if (before.statusError) {
                done(before.statusError);
                return;
              }
              try {
                handle.assertOwned();
                done(null, this.view(name, this.configFromIndex(index), before, null, index.revision));
              } catch (ownershipError) {
                done(ownershipError);
              }
            });
          });
        });
      }
      deleteLs(name, callback) {
        this.callback(callback, () => {
          this.validateName(name);
          this.withMutation(name, callback, (handle, done) => {
            let index;
            try {
              index = this.readIndex(name);
            } catch (readError) {
              done(readError);
              return;
            }
            this.inspect(name, (_unused, state) => {
              if (state.statusError) {
                done(state.statusError);
                return;
              }
              if (["RUNNING", "STARTING", "STOPPING"].includes(state.controllerState)) {
                done(error("JOB_RUNNING", "\uC2E4\uD589 \uC911\uC774\uAC70\uB098 \uC804\uD658 \uC911\uC778 Job\uC740 \uBC14\uAFB8\uAC70\uB098 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
                  name,
                  controllerState: state.controllerState
                }));
                return;
              }
              try {
                handle.assertOwned();
                this.repository.discard(name);
                this.indexRepository.remove(name);
                done(null, { name, revision: index.revision });
              } catch (deleteError) {
                done(deleteError);
              }
            });
          });
        });
      }
      installPackageService(callback) {
        if (!this.isLs) {
          callback(null);
          return;
        }
        try {
          this.lsRuntime.installPackage(callback);
        } catch (installError) {
          callback(installError);
        }
      }
      startDaemonForPackage(callback) {
        if (!this.isLs) {
          callback(null);
          return;
        }
        this.lsRuntime.startDaemon(callback);
      }
      stopDaemonForPackage(callback) {
        if (!this.isLs) {
          callback(null);
          return;
        }
        this.lsRuntime.stopDaemon(callback);
      }
      uninstallDaemonForPackage(callback) {
        if (!this.isLs) {
          callback(null);
          return;
        }
        this.lsRuntime.uninstall(callback);
      }
      daemonStatus(callback) {
        if (!this.isLs) {
          callback(null, null);
          return;
        }
        this.lsRuntime.daemonStatus(callback);
      }
      lastRun(name, callback) {
        if (this.isLs) {
          this.status(name, (statusError, value) => callback(statusError, value && { lastRun: value.lastRun }));
          return;
        }
        let current;
        try {
          current = this.readValidated(name);
        } catch (readError) {
          callback(readError);
          return;
        }
        this.inspect(name, (_unused, state) => {
          if (state.statusError) {
            callback(state.statusError);
            return;
          }
          if (state.controllerState === "NOT_INSTALLED") {
            callback(null, { lastRun: null });
            return;
          }
          this.readLastRun(name, this.view(name, current.config, state), (detailsError, lastRun) => {
            if (detailsError) {
              callback(controllerFailure("CONTROLLER_UNAVAILABLE", "service details\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", name, state.controllerState, detailsError.message));
              return;
            }
            callback(null, { lastRun: projectLastRun(lastRun) });
          });
        });
      }
    };
    module2.exports = { JobManager, SERVICE_PREFIX, serviceName };
  }
});

// cgi-bin/src/cgi/job-api.js
var require_job_api = __commonJS({
  "cgi-bin/src/cgi/job-api.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var process = require("process");
    var http = require_http();
    var { JobManager } = require_manager();
    function cgiRoot() {
      const script = String(process.argv[1] || "");
      const marker = `${path.sep}cgi-bin${path.sep}`;
      const index = script.indexOf(marker);
      return index < 0 ? path.resolve(process.cwd(), "cgi-bin") : script.slice(0, index + marker.length - 1);
    }
    function requestMethod() {
      return String(process.env.get && process.env.get("REQUEST_METHOD") || process.env.REQUEST_METHOD || "");
    }
    function manager() {
      return http.createFactory(() => new JobManager({ cgiRoot: cgiRoot() }));
    }
    function result(status) {
      return (operationError, value) => {
        if (operationError) http.fail(operationError);
        else http.reply(status, { ok: true, data: value });
      };
    }
    function requiredName() {
      const query = http.readQuery();
      if (!query.ok) {
        http.fail(query.error, 400);
        return null;
      }
      try {
        return http.requireStringFields(query.value, ["name"]).name;
      } catch (queryError) {
        http.fail(queryError, 400);
        return null;
      }
    }
    function requiredBody(label, maxBytes) {
      const body = http.readBody(void 0, maxBytes ? { maxBytes } : void 0);
      if (!body.ok) {
        http.fail(body.error, 400);
        return null;
      }
      try {
        return http.requireObject(body.value, label);
      } catch (bodyError) {
        http.fail(bodyError, 400);
        return null;
      }
    }
    function methodNotAllowed(allowed) {
      const failure = new Error(`${allowed.join("/")} \uC694\uCCAD\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`);
      failure.code = "METHOD_NOT_ALLOWED";
      http.fail(failure, 405);
    }
    module2.exports = {
      http,
      manager,
      methodNotAllowed,
      requestMethod,
      requiredBody,
      requiredName,
      result
    };
  }
});

// cgi-bin/src/config/provider-profile.js
var require_provider_profile = __commonJS({
  "cgi-bin/src/config/provider-profile.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { error } = require_errors();
    var TOP_LEVEL_FIELDS = [
      "schemaVersion",
      "id",
      "jobMode",
      "interfaceId",
      "methodId",
      "outputSelections",
      "tagGenerator"
    ];
    var OUTPUT_SELECTION_FIELDS = [
      "id",
      "sourceIndex",
      "interpretation",
      "selector",
      "valueType",
      "elementType",
      "tags"
    ];
    var VALUE_TYPES = ["numeric", "string", "json", "array"];
    var ELEMENT_TYPES = ["numeric", "string", "json"];
    var TAG_GENERATOR_KINDS = ["ls-memory-address-v1"];
    function invalid(reason, details) {
      throw error("PROVIDER_PROFILE_INVALID", reason, details);
    }
    function objectValue(value) {
      return value && typeof value === "object" && !Array.isArray(value);
    }
    function assertAllowedFields(value, fields, label) {
      if (!objectValue(value)) invalid(`${label}\uC740 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      const unknown = Object.keys(value).filter((field) => !fields.includes(field));
      if (unknown.length) invalid(`${label}\uC5D0 \uC54C \uC218 \uC5C6\uB294 \uD544\uB4DC\uAC00 \uC788\uC2B5\uB2C8\uB2E4.`, { fields: unknown });
    }
    function nonEmptyString(value) {
      return typeof value === "string" && value.trim().length > 0;
    }
    function validateOutputSelection(selection, index) {
      assertAllowedFields(selection, OUTPUT_SELECTION_FIELDS, "Provider output selection");
      if (!nonEmptyString(selection.id) || !Number.isInteger(selection.sourceIndex) || selection.sourceIndex < 0 || !["native", "json"].includes(selection.interpretation) || !Array.isArray(selection.tags) || selection.tags.length !== 0) {
        invalid("Provider output selection \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { index });
      }
      if (selection.selector !== void 0 && typeof selection.selector !== "string") {
        invalid("Provider output selector\uB294 \uBB38\uC790\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.", { index });
      }
      if (selection.valueType !== void 0 && !VALUE_TYPES.includes(selection.valueType)) {
        invalid("Provider output valueType\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", { index });
      }
      if ((selection.selector !== void 0 || selection.valueType !== void 0) && (typeof selection.selector !== "string" || !VALUE_TYPES.includes(selection.valueType))) {
        invalid("Provider output selector\uC640 valueType\uC740 \uD568\uAED8 \uC788\uC5B4\uC57C \uD569\uB2C8\uB2E4.", { index });
      }
      if (selection.interpretation === "json" && (typeof selection.selector !== "string" || !VALUE_TYPES.includes(selection.valueType))) {
        invalid("JSON Provider output\uC5D0\uB294 selector\uC640 valueType\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.", { index });
      }
      if (selection.valueType === "array") {
        if (!ELEMENT_TYPES.includes(selection.elementType)) {
          invalid("array Provider output\uC5D0\uB294 elementType\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.", { index });
        }
      } else if (selection.elementType !== void 0) {
        invalid("array\uAC00 \uC544\uB2CC Provider output\uC5D0\uB294 elementType\uC744 \uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { index });
      }
      return {
        id: selection.id,
        sourceIndex: selection.sourceIndex,
        interpretation: selection.interpretation,
        ...selection.selector !== void 0 ? { selector: selection.selector } : {},
        ...selection.valueType !== void 0 ? { valueType: selection.valueType } : {},
        ...selection.elementType !== void 0 ? { elementType: selection.elementType } : {},
        tags: []
      };
    }
    function validateProviderProfile(value) {
      assertAllowedFields(value, TOP_LEVEL_FIELDS, "Provider Profile");
      if (value.schemaVersion !== 1 || !nonEmptyString(value.id) || value.jobMode !== "fixed" || !nonEmptyString(value.interfaceId) || !nonEmptyString(value.methodId) || !Array.isArray(value.outputSelections) || value.outputSelections.length === 0) {
        invalid("Provider Profile \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      assertAllowedFields(value.tagGenerator, ["kind"], "Provider tagGenerator");
      if (!TAG_GENERATOR_KINDS.includes(value.tagGenerator.kind)) {
        invalid("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 Provider tagGenerator\uC785\uB2C8\uB2E4.", { kind: value.tagGenerator.kind });
      }
      const outputSelections = value.outputSelections.map(validateOutputSelection);
      const ids = outputSelections.map((selection) => selection.id);
      if (new Set(ids).size !== ids.length) invalid("Provider output selection ID\uB294 \uACE0\uC720\uD574\uC57C \uD569\uB2C8\uB2E4.");
      return {
        schemaVersion: 1,
        id: value.id,
        jobMode: "fixed",
        interfaceId: value.interfaceId,
        methodId: value.methodId,
        outputSelections,
        tagGenerator: { kind: value.tagGenerator.kind }
      };
    }
    function loadProviderProfile(cgiRoot) {
      const file = path.join(cgiRoot, "provider.json");
      if (!fs.existsSync(file)) return null;
      try {
        return validateProviderProfile(JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (failure) {
        if (failure && failure.code === "PROVIDER_PROFILE_INVALID") throw failure;
        invalid("Provider Profile \uD30C\uC77C\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
          message: failure && failure.message ? failure.message : String(failure)
        });
      }
    }
    module2.exports = { loadProviderProfile, validateProviderProfile };
  }
});

// cgi-bin/src/config/settings-manager.js
var require_settings_manager = __commonJS({
  "cgi-bin/src/config/settings-manager.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var { writeJsonAtomic } = require_atomic_json();
    var { loadSettings } = require_settings_loader();
    var { loadProviderProfile } = require_provider_profile();
    var { validateSettings } = require_settings_validator();
    var { createServerStore } = require_server_store();
    var { loadProductPolicy } = require_product_policy();
    var { resolveIntervalPolicy } = require_interval_policy();
    var { error } = require_errors();
    function validateDatabaseDefault(cgiRoot, defaults) {
      const store = createServerStore({ cgiRoot });
      let servers = null;
      let listFailure = null;
      store.list((failure, values) => {
        listFailure = failure;
        servers = values;
      });
      if (listFailure) throw listFailure;
      if (!(servers || []).some((server) => server.name === defaults.database.server)) {
        throw error("SETTINGS_INVALID", "\uAE30\uBCF8 Database Server\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { server: defaults.database.server });
      }
    }
    var SettingsManager = class {
      constructor(options) {
        const settings = options || {};
        this.cgiRoot = settings.cgiRoot;
        this.file = path.join(this.cgiRoot, "conf.d", "settings.json");
      }
      get(callback) {
        try {
          const settings = loadSettings(this.file);
          const productPolicy = loadProductPolicy(this.cgiRoot);
          const provider = loadProviderProfile(this.cgiRoot);
          const { ls, ...publicSettings } = settings;
          callback(null, {
            ...publicSettings,
            provider,
            ...productPolicy.target === "ls" && provider ? { intervalPolicy: resolveIntervalPolicy({ settings, productPolicy }) } : {}
          });
        } catch (loadError) {
          callback(loadError);
        }
      }
      update(patch, callback) {
        try {
          if (patch && Object.prototype.hasOwnProperty.call(patch, "provider")) {
            throw error("SETTINGS_INVALID", "provider\uB294 \uC77D\uAE30 \uC804\uC6A9 build profile\uC785\uB2C8\uB2E4.");
          }
          const current = loadSettings(this.file);
          const productPolicy = loadProductPolicy(this.cgiRoot);
          if (productPolicy.target === "ls" && patch && patch.defaults && patch.defaults.database && patch.defaults.database.server && patch.defaults.database.server !== current.defaults.database.server) {
            throw error("LS_DATABASE_PROFILE_FIXED", "LS\uC5D0\uC11C\uB294 \uAE30\uBCF8 Database Server\uB97C \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uAE30\uC874 Database \uC124\uC815\uC744 \uC218\uC815\uD558\uC2ED\uC2DC\uC624.");
          }
          const candidate = validateSettings({
            schemaVersion: 1,
            limits: patch && patch.limits ? patch.limits : current.limits,
            defaults: patch && patch.defaults ? patch.defaults : current.defaults,
            logging: patch && patch.logging ? patch.logging : current.logging,
            ls: patch && patch.ls ? patch.ls : current.ls
          });
          if (patch && patch.defaults) validateDatabaseDefault(this.cgiRoot, candidate.defaults);
          const next = { ...current, ...candidate };
          if (productPolicy.target !== "ls") delete next.ls;
          writeJsonAtomic(this.file, next);
          const { ls, ...publicSettings } = next;
          const provider = loadProviderProfile(this.cgiRoot);
          callback(null, {
            ...publicSettings,
            ...productPolicy.target === "ls" && provider ? { intervalPolicy: resolveIntervalPolicy({ settings: next, productPolicy }) } : {}
          });
        } catch (updateError) {
          callback(updateError);
        }
      }
    };
    module2.exports = { SettingsManager };
  }
});

// cgi-bin/src/interfaces/references.js
var require_references = __commonJS({
  "cgi-bin/src/interfaces/references.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { JobIndexRepository } = require_index_repository();
    var JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
    var CALL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
    var IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    var MAX_NAME_LENGTH = 100;
    var METHOD_CALL_FIELDS = ["id", "name", "interfaceId", "methodId", "inputs", "tags"];
    function isValidJobName(name) {
      return typeof name === "string" && name.length <= MAX_NAME_LENGTH && JOB_NAME.test(name) && !/[\\/]/.test(name);
    }
    function isIdentifier(value) {
      return typeof value === "string" && value.length <= MAX_NAME_LENGTH && IDENTIFIER.test(value);
    }
    function isObject(value) {
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }
    function validCall(call) {
      return isObject(call) && Object.keys(call).every((key) => METHOD_CALL_FIELDS.includes(key)) && typeof call.id === "string" && CALL_ID.test(call.id) && typeof call.name === "string" && Boolean(call.name.trim()) && isIdentifier(call.interfaceId) && isIdentifier(call.methodId) && isObject(call.inputs) && Array.isArray(call.tags);
    }
    function validCalls(calls) {
      if (!Array.isArray(calls) || calls.length === 0 || !calls.every(validCall)) return false;
      return new Set(calls.map((call) => call.id)).size === calls.length && new Set(calls.map((call) => call.name)).size === calls.length;
    }
    function invalid(name, job) {
      return [{ name, documentName: job && typeof job.name === "string" ? job.name : null, calls: [], methodIds: [], invalidConfig: true }];
    }
    var InterfaceReferenceAnalyzer = class {
      constructor(options) {
        this.jobDir = path.join(options.cgiRoot, "conf.d", "jobs");
        this.useIndex = options.useIndex === true;
        this.indexes = this.useIndex ? new JobIndexRepository({ cgiRoot: options.cgiRoot, jobDirectory: this.jobDir }) : null;
      }
      find(interfaceId, methodId) {
        if (this.indexes) {
          return this.indexes.list().flatMap((record) => {
            if (record.error || !record.index) return invalid(record.name, null);
            const calls = record.index.methodReferences.filter((call) => call.interfaceId === interfaceId && (!methodId || call.methodId === methodId));
            return calls.length ? [{
              name: record.name,
              documentName: record.name,
              calls: calls.map((call) => call.callId),
              methodIds: [...new Set(calls.map((call) => call.methodId))],
              invalidConfig: false
            }] : [];
          });
        }
        if (!fs.existsSync(this.jobDir)) return [];
        return fs.readdirSync(this.jobDir).filter((file) => file.endsWith(".json")).sort().flatMap((file) => {
          const name = file.slice(0, -5);
          let job;
          try {
            job = JSON.parse(fs.readFileSync(path.join(this.jobDir, file), "utf8"));
          } catch (_) {
            return invalid(name, null);
          }
          if (!job || typeof job !== "object" || Array.isArray(job) || job.schemaVersion !== 1 || job.name !== name || !isValidJobName(name) || !validCalls(job.methodCalls)) return invalid(name, job);
          const calls = job.methodCalls.filter((call) => call && call.interfaceId === interfaceId && (!methodId || call.methodId === methodId));
          return calls.length ? [{ name, documentName: job.name, calls: calls.map((call) => call.id), methodIds: [...new Set(calls.map((call) => call.methodId))], invalidConfig: false }] : [];
        });
      }
    };
    module2.exports = { InterfaceReferenceAnalyzer };
  }
});

// cgi-bin/src/interfaces/manager.js
var require_manager2 = __commonJS({
  "cgi-bin/src/interfaces/manager.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { error } = require_errors();
    var { createJobOperationLock } = require_operation_lock();
    var { profileLockKey } = require_profile_lock_key();
    var { createDbusAdapter } = require_adapter();
    var { loadProductPolicy } = require_product_policy();
    var { typeFromSignature } = require_types();
    var { InterfaceStore } = require_store();
    var { InterfaceReferenceAnalyzer } = require_references();
    var { isIdentifier, validateInterface, validateMethod, validateXmlSize, MAX_INTERFACES } = require_validator2();
    function slug(value) {
      return String(value).replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    }
    function same(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }
    function interfaceId(value) {
      if (!isIdentifier(value)) throw error("DBUS_INTERFACE_INVALID", "DBus Interface ID \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { id: value });
      return value;
    }
    function methodId(value) {
      if (!isIdentifier(value)) throw error("DBUS_METHOD_INVALID", "DBus Method ID \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { methodId: value });
      return value;
    }
    var InterfaceManager = class {
      constructor(options) {
        const settings = options || {};
        this.cgiRoot = settings.cgiRoot;
        const productPolicy = settings.productPolicy || loadProductPolicy(this.cgiRoot);
        this.store = settings.store || new InterfaceStore({ cgiRoot: this.cgiRoot });
        this.references = settings.references || new InterfaceReferenceAnalyzer({ cgiRoot: this.cgiRoot, useIndex: productPolicy.target === "ls" });
        this.mutationLock = settings.mutationLock || createJobOperationLock({ directory: path.join(this.cgiRoot, "conf.d", ".interface-mutation-locks") });
        this.jobLock = settings.jobLock || createJobOperationLock({ directory: path.join(this.cgiRoot, "conf.d", ".job-operation-locks") });
        this.readerLock = settings.readerLock || createJobOperationLock({ directory: path.join(this.cgiRoot, "conf.d", ".interface-mutation-readers") });
        this.dbusFactory = settings.dbusFactory || (() => createDbusAdapter());
      }
      execute(callback, action) {
        try {
          callback(null, action());
        } catch (failure) {
          callback(failure);
        }
      }
      required(id) {
        interfaceId(id);
        const found = this.store.find(id);
        if (!found) throw error("DBUS_INTERFACE_NOT_FOUND", "DBus Interface\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { id });
        return found;
      }
      writable(id) {
        const found = this.required(id);
        if (found.builtIn) throw error("DBUS_INTERFACE_READ_ONLY", "Built-in DBus Interface\uB294 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { id });
        return found;
      }
      listInterfaces() {
        return this.store.list().map((item) => ({ id: item.id, name: item.name, busType: item.busType, destination: item.destination, objectPath: item.objectPath, interface: item.interface, builtIn: item.builtIn, methodCount: item.methods.length }));
      }
      getInterface(id, callback) {
        this.execute(callback, () => {
          const item = this.required(id);
          return { interface: item, references: this.references.find(id) };
        });
      }
      guard(id, callback, action) {
        let fence;
        const jobs = [];
        try {
          interfaceId(id);
          fence = this.mutationLock.acquire(profileLockKey(id));
          const readerDir = path.join(this.cgiRoot, "conf.d", ".interface-mutation-readers");
          const prefix = `${profileLockKey(id)}--`;
          if (fs.existsSync(readerDir)) fs.readdirSync(readerDir).filter((entry) => entry.startsWith(prefix) && entry.endsWith(".lock")).forEach((entry) => {
            const reader = this.readerLock.acquire(entry.slice(0, -5));
            reader.release();
          });
          const refs = this.references.find(id);
          [...new Set(refs.map((ref) => ref.name))].sort().forEach((name) => jobs.push(this.jobLock.acquire(name)));
          const refreshed = this.references.find(id);
          return this.execute((failure, value) => {
            [...jobs].reverse().forEach((handle) => handle.release());
            fence.release();
            callback(failure, value);
          }, () => action(refreshed));
        } catch (failure) {
          [...jobs].reverse().forEach((handle) => handle.release());
          if (fence) fence.release();
          callback(failure);
        }
      }
      createInterface(value, callback) {
        let next;
        let allocation;
        try {
          if (typeof value?.name !== "string" || !value.name.trim()) throw error("DBUS_INTERFACE_INVALID", "DBus Interface \uC774\uB984\uC740 \uD544\uC218\uC785\uB2C8\uB2E4.");
          next = validateInterface({ ...value, origin: value.origin || "manual", builtIn: false }, { idOptional: true });
          allocation = this.mutationLock.acquire(profileLockKey("dbus-interface-create"));
          const used = new Set(this.store.list().map((item) => item.id));
          const base = slug(next.name) || slug(next.interface) || "dbus-interface";
          let id = base;
          let suffix = 2;
          while (used.has(id)) {
            id = `${base}-${suffix}`;
            suffix += 1;
          }
          const saved = this.store.save({ ...next, id, builtIn: false });
          allocation.release();
          allocation = null;
          callback(null, saved);
        } catch (failure) {
          if (allocation) allocation.release();
          callback(failure);
        }
      }
      updateInterface(value, callback) {
        let next;
        try {
          next = validateInterface({ ...value, builtIn: false });
        } catch (failure) {
          callback(failure);
          return;
        }
        const id = next.id;
        this.guard(id, callback, (refs) => {
          const current = this.writable(id);
          if (current.origin !== next.origin) throw error("DBUS_INTERFACE_INVALID", "DBus Interface origin\uC740 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: id });
          const callShapeChanged = !same({ ...current, name: "" }, { ...next, name: "" });
          if (refs.length && callShapeChanged) throw error("DBUS_INTERFACE_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 DBus Interface\uB294 \uD638\uCD9C \uAD6C\uC870\uB97C \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          const currentDiscovered = current.methods.filter((method) => method.source === "discovered");
          const nextDiscovered = next.methods.filter((method) => method.source === "discovered");
          if (current.origin !== "manual" && !same(current.methods, next.methods)) throw error("DBUS_METHOD_READ_ONLY", "\uC790\uB3D9 \uBC1C\uACAC DBus Method\uAC00 \uC788\uB294 Interface\uC5D0\uC11C\uB294 Method\uB97C \uC9C1\uC811 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: id });
          if (current.origin === "manual" && !same(currentDiscovered, nextDiscovered)) throw error("DBUS_METHOD_READ_ONLY", "\uC790\uB3D9 \uBC1C\uACAC DBus Method\uB294 \uC9C1\uC811 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: id });
          return this.store.save(next);
        });
      }
      updateDiscoveredInterface(value, callback) {
        let next;
        try {
          next = validateInterface({ ...value, origin: "discovered", builtIn: false });
        } catch (failure) {
          callback(failure);
          return;
        }
        this.guard(next.id, callback, (refs) => {
          const current = this.writable(next.id);
          if (current.origin !== "discovered") throw error("DBUS_INTERFACE_INVALID", "\uC790\uB3D9 \uBC1C\uACAC DBus Interface\uAC00 \uC544\uB2D9\uB2C8\uB2E4.", { interfaceId: next.id });
          if (refs.length) throw error("DBUS_INTERFACE_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 DBus Interface\uB294 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          return this.store.save(next);
        });
      }
      deleteInterface(id, callback) {
        this.guard(id, callback, (refs) => {
          this.writable(id);
          if (refs.length) throw error("DBUS_INTERFACE_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 DBus Interface\uB294 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          this.store.remove(id);
          return { id };
        });
      }
      createMethod(interfaceIdValue, value, callback) {
        let method;
        try {
          interfaceId(interfaceIdValue);
          method = validateMethod(value);
        } catch (failure) {
          callback(failure);
          return;
        }
        this.guard(interfaceIdValue, callback, (refs) => {
          const item = this.writable(interfaceIdValue);
          if (refs.length) throw error("DBUS_INTERFACE_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 DBus Interface\uC5D0\uC11C\uB294 Method\uB97C \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          if (item.origin !== "manual" || method.source !== "manual") throw error("DBUS_METHOD_READ_ONLY", "\uC790\uB3D9 \uBC1C\uACAC DBus Method\uAC00 \uC788\uB294 Interface\uC5D0\uC11C\uB294 Method\uB97C \uC9C1\uC811 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: interfaceIdValue, methodId: method.id });
          if (item.methods.some((candidate) => candidate.id === method.id)) throw error("DBUS_METHOD_IN_USE", "\uAC19\uC740 Method ID\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { interfaceId: interfaceIdValue, methodId: method.id });
          this.store.save({ ...item, methods: item.methods.concat(method) });
          return method;
        });
      }
      updateMethod(interfaceIdValue, methodIdValue, value, callback) {
        let method;
        try {
          interfaceId(interfaceIdValue);
          methodId(methodIdValue);
          method = validateMethod(value);
        } catch (failure) {
          callback(failure);
          return;
        }
        this.guard(interfaceIdValue, callback, (refs) => {
          const item = this.writable(interfaceIdValue);
          if (refs.length) throw error("DBUS_INTERFACE_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 DBus Interface\uC5D0\uC11C\uB294 Method\uB97C \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          const current = item.methods.find((candidate) => candidate.id === methodIdValue);
          if (item.origin !== "manual" || !current || current.source !== "manual" || method.source !== "manual") throw error("DBUS_METHOD_READ_ONLY", "\uC790\uB3D9 \uBC1C\uACAC DBus Method\uAC00 \uC788\uB294 Interface\uC5D0\uC11C\uB294 Method\uB97C \uC9C1\uC811 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: interfaceIdValue, methodId: methodIdValue });
          if (method.id !== methodIdValue) throw error("DBUS_METHOD_INVALID", "\uC694\uCCAD\uC758 Method ID\uAC00 \uC11C\uB85C \uB2E4\uB985\uB2C8\uB2E4.", { methodId: methodIdValue, bodyMethodId: method.id });
          this.store.save({ ...item, methods: item.methods.map((candidate) => candidate.id === methodIdValue ? method : candidate) });
          return method;
        });
      }
      deleteMethod(interfaceIdValue, methodIdValue, callback) {
        try {
          interfaceId(interfaceIdValue);
          methodId(methodIdValue);
        } catch (failure) {
          callback(failure);
          return;
        }
        this.guard(interfaceIdValue, callback, (refs) => {
          const item = this.writable(interfaceIdValue);
          if (refs.length) throw error("DBUS_INTERFACE_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 DBus Interface\uC5D0\uC11C\uB294 Method\uB97C \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          const current = item.methods.find((candidate) => candidate.id === methodIdValue);
          if (item.origin !== "manual" || !current || current.source !== "manual") throw error("DBUS_METHOD_READ_ONLY", "\uC790\uB3D9 \uBC1C\uACAC DBus Method\uAC00 \uC788\uB294 Interface\uC5D0\uC11C\uB294 Method\uB97C \uC9C1\uC811 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: interfaceIdValue, methodId: methodIdValue });
          this.store.save({ ...item, methods: item.methods.filter((candidate) => candidate.id !== methodIdValue) });
          return { interfaceId: interfaceIdValue, methodId: methodIdValue };
        });
      }
      parseIntrospection(node, connection) {
        validateXmlSize(JSON.stringify(node));
        const read = (value, lower, upper) => value && (value[lower] === void 0 ? value[upper] : value[lower]);
        const foundInterfaces = read(node, "interfaces", "Interfaces");
        if (!Array.isArray(foundInterfaces)) throw error("INTROSPECTION_UNSUPPORTED", "Introspection Interface \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
        const interfaces = foundInterfaces.map((discovered) => {
          const interfaceName = read(discovered, "name", "Name");
          const foundMethods = read(discovered, "methods", "Methods");
          if (!discovered || typeof interfaceName !== "string" || !Array.isArray(foundMethods)) throw error("INTROSPECTION_UNSUPPORTED", "Introspection Interface \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
          const methods = foundMethods.map((method) => {
            const member = read(method, "name", "Name");
            const foundArguments = read(method, "args", "Args");
            if (!method || typeof member !== "string" || !Array.isArray(foundArguments)) throw error("INTROSPECTION_UNSUPPORTED", "Introspection Method \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
            const usedNames = /* @__PURE__ */ new Set();
            const inputs = [];
            const outputs = [];
            foundArguments.forEach((argument, index) => {
              const signature = read(argument, "type", "Type");
              const direction = read(argument, "direction", "Direction");
              const type = typeFromSignature(signature);
              if (!type) throw error("INTROSPECTION_UNSUPPORTED", "Introspection parameter type\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { type: signature });
              const target = direction === "out" ? outputs : inputs;
              const prefix = direction === "out" ? "output" : "input";
              let name = read(argument, "name", "Name");
              name = typeof name === "string" && name ? name : `${prefix}${target.length + 1}`;
              if (usedNames.has(name)) name = `${prefix}${index + 1}`;
              while (usedNames.has(name)) name = `${name}_`;
              usedNames.add(name);
              target.push({ name, type });
            });
            return { id: slug(member), source: "discovered", member, inputs, outputs };
          });
          return validateInterface({ schemaVersion: 1, id: slug(interfaceName), name: interfaceName, origin: "discovered", builtIn: false, ...connection, interface: interfaceName, methods });
        });
        if (!interfaces.length || interfaces.length > MAX_INTERFACES) throw error("INTROSPECTION_UNSUPPORTED", "Introspection Interface \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
        return interfaces;
      }
      discover(value, callback) {
        this.execute(callback, () => {
          const connection = { busType: value && value.busType, destination: value && value.destination, objectPath: value && value.objectPath };
          validateInterface({ schemaVersion: 1, id: "temporary-interface", origin: "discovered", builtIn: false, ...connection, interface: "temporary.Interface", methods: [] });
          let dbus;
          try {
            dbus = this.dbusFactory();
            dbus.connect(connection.busType, connection.destination);
            return this.parseIntrospection(dbus.introspect(connection), connection);
          } catch (_) {
            throw error("INTROSPECTION_UNSUPPORTED", "DBus Introspection\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          } finally {
            if (dbus) dbus.close();
          }
        });
      }
    };
    module2.exports = { InterfaceManager };
  }
});

// cgi-bin/src/profiles/version.js
var require_version = __commonJS({
  "cgi-bin/src/profiles/version.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
    function parseSemVer(value, code) {
      const match = SEMVER.exec(String(value || ""));
      if (!match) throw error(code || "RUNTIME_VERSION_INVALID", "Neo version\uC740 \uC5C4\uACA9\uD55C SemVer \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.", { version: value });
      if (match[4] && match[4].split(".").some((identifier) => /^0\d+$/.test(identifier))) {
        throw error(code || "RUNTIME_VERSION_INVALID", "SemVer \uC22B\uC790 prerelease\uC5D0\uB294 \uC55E\uC790\uB9AC 0\uC744 \uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { version: value });
      }
      return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split(".") : []
      };
    }
    function compareIdentifier(left, right) {
      const leftNumber = /^\d+$/.test(left);
      const rightNumber = /^\d+$/.test(right);
      if (leftNumber && rightNumber) return Number(left) - Number(right);
      if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function compareSemVer(left, right) {
      const a = parseSemVer(left);
      const b = parseSemVer(right);
      for (const key of ["major", "minor", "patch"]) {
        if (a[key] !== b[key]) return a[key] - b[key];
      }
      if (!a.prerelease.length && !b.prerelease.length) return 0;
      if (!a.prerelease.length) return 1;
      if (!b.prerelease.length) return -1;
      for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
        if (a.prerelease[index] === void 0) return -1;
        if (b.prerelease[index] === void 0) return 1;
        const compared = compareIdentifier(a.prerelease[index], b.prerelease[index]);
        if (compared) return compared;
      }
      return 0;
    }
    module2.exports = { compareSemVer, parseSemVer };
  }
});

// cgi-bin/src/profiles/validator.js
var require_validator3 = __commonJS({
  "cgi-bin/src/profiles/validator.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var { parseSemVer } = require_version();
    var MAX_PROFILE_JSON_BYTES = 256 * 1024;
    var MAX_METHODS_PER_PROFILE = 128;
    var MAX_INPUTS_PER_METHOD = 64;
    var MAX_PROFILE_ID_LENGTH = 100;
    var DBUS_TYPES = /* @__PURE__ */ new Set([
      "byte",
      "uint8",
      "uint16",
      "uint32",
      "uint64",
      "int16",
      "int32",
      "int64",
      "float32",
      "float64",
      "double",
      "bool",
      "string",
      "objectpath",
      "path",
      "signature"
    ]);
    var INTEGER_TYPES = /* @__PURE__ */ new Set(["byte", "uint8", "uint16", "uint32", "uint64", "int16", "int32", "int64"]);
    var WIDE_INTEGER_TYPES = /* @__PURE__ */ new Set(["uint64", "int64"]);
    var INTEGER_RANGES = {
      byte: [0n, 255n],
      uint8: [0n, 255n],
      uint16: [0n, 65535n],
      uint32: [0n, 4294967295n],
      uint64: [0n, 18446744073709551615n],
      int16: [-32768n, 32767n],
      int32: [-2147483648n, 2147483647n],
      int64: [-9223372036854775808n, 9223372036854775807n]
    };
    var DECODERS = /* @__PURE__ */ new Set(["raw", "json"]);
    var SHAPES = /* @__PURE__ */ new Set(["scalar", "array", "object"]);
    var SUCCESS_OPERATORS = /* @__PURE__ */ new Set(["equals"]);
    var TAG_CAPABILITIES = /* @__PURE__ */ new Set(["ls-get-device-data"]);
    var ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    var INPUT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
    var OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;
    var INTERFACE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
    var MEMBER = /^[A-Za-z_][A-Za-z0-9_]*$/;
    var SIMPLE_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/;
    function invalid(code, reason, details) {
      throw error(code, reason, details);
    }
    function assertObject(value, code, label) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        invalid(code, `${label}\uC740(\uB294) \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      }
    }
    function assertKnownFields(value, allowed, code, label) {
      const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
      if (unknown.length) invalid(code, `${label}\uC5D0 \uC54C \uC218 \uC5C6\uB294 \uD544\uB4DC\uAC00 \uC788\uC2B5\uB2C8\uB2E4.`, { fields: unknown });
    }
    function utf8Bytes(value) {
      let bytes = 0;
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 128) bytes += 1;
        else if (code < 2048) bytes += 2;
        else if (code >= 55296 && code <= 56319) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      }
      return bytes;
    }
    function validateProfileJsonSize(source) {
      if (utf8Bytes(String(source)) > MAX_PROFILE_JSON_BYTES) {
        invalid("PROFILE_INVALID", `Profile JSON\uC740 ${MAX_PROFILE_JSON_BYTES} bytes \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      }
    }
    function integerValidationBound(input, value, errorCode, label) {
      let bound;
      try {
        if (WIDE_INTEGER_TYPES.has(input.type)) {
          if (typeof value === "number" && Number.isSafeInteger(value)) bound = BigInt(value);
          else if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) bound = BigInt(value);
          else invalid(errorCode, `input validation ${label}\uC740 \uC815\uD655\uD55C 64-bit \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
        } else if (typeof value === "number" && Number.isInteger(value)) bound = BigInt(value);
        else invalid(errorCode, `input validation ${label}\uC740 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      } catch (_) {
        invalid(errorCode, `input validation ${label} \uC815\uC218 \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`);
      }
      const range = INTEGER_RANGES[input.type];
      if (bound < range[0] || bound > range[1]) {
        invalid(errorCode, `input validation ${label}\uC774 ${input.type} \uBC94\uC704\uB97C \uBC97\uC5B4\uB0AC\uC2B5\uB2C8\uB2E4.`);
      }
      return bound;
    }
    function validateInput(input, errorCode) {
      assertObject(input, errorCode, "Method input");
      assertKnownFields(input, ["id", "type", "required", "validation"], errorCode, "Method input");
      if (!INPUT_ID.test(input.id || "") || !DBUS_TYPES.has(input.type)) {
        invalid(errorCode, "Method input ID \uB610\uB294 type\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      if (typeof input.required !== "boolean") invalid(errorCode, "Method input required\uB294 boolean\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      if (input.validation !== void 0) {
        assertObject(input.validation, errorCode, "Method input validation");
        assertKnownFields(input.validation, ["minimum", "maximum", "pattern"], errorCode, "Method input validation");
        const { minimum, maximum, pattern } = input.validation;
        let comparableMinimum = minimum;
        let comparableMaximum = maximum;
        if (INTEGER_TYPES.has(input.type)) {
          if (minimum !== void 0) comparableMinimum = integerValidationBound(input, minimum, errorCode, "minimum");
          if (maximum !== void 0) comparableMaximum = integerValidationBound(input, maximum, errorCode, "maximum");
        } else {
          if (minimum !== void 0 && (typeof minimum !== "number" || !Number.isFinite(minimum))) {
            invalid(errorCode, "input validation minimum\uC740 \uC720\uD55C\uD55C \uC22B\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
          }
          if (maximum !== void 0 && (typeof maximum !== "number" || !Number.isFinite(maximum))) {
            invalid(errorCode, "input validation maximum\uC740 \uC720\uD55C\uD55C \uC22B\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
          }
        }
        if (minimum !== void 0 && maximum !== void 0 && comparableMinimum > comparableMaximum) {
          invalid(errorCode, "input validation minimum\uC740 maximum\uBCF4\uB2E4 \uD074 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        }
        if (pattern !== void 0) {
          if (typeof pattern !== "string") invalid(errorCode, "input validation pattern\uC740 \uBB38\uC790\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
          try {
            new RegExp(pattern);
          } catch (_) {
            invalid(errorCode, "input validation pattern \uC815\uADDC\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
          }
        }
      }
      return input.validation === void 0 ? { id: input.id, type: input.type, required: input.required } : { id: input.id, type: input.type, required: input.required, validation: { ...input.validation } };
    }
    function validateOutput(output, inputIds, errorCode) {
      assertObject(output, errorCode, "Method output");
      assertKnownFields(
        output,
        ["decoder", "shape", "path", "success", "returnedCountPath", "expectedCount"],
        errorCode,
        "Method output"
      );
      if (!DECODERS.has(output.decoder) || !SHAPES.has(output.shape)) {
        invalid(errorCode, "Method output decoder \uB610\uB294 shape\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      if (output.path !== void 0 && !SIMPLE_PATH.test(output.path)) {
        invalid(errorCode, "Method output path\uB294 \uB2E8\uC21C path \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      }
      if (output.success !== void 0) {
        assertObject(output.success, errorCode, "Method output success");
        assertKnownFields(output.success, ["path", "operator", "value"], errorCode, "Method output success");
        if (!SIMPLE_PATH.test(output.success.path || "") || !SUCCESS_OPERATORS.has(output.success.operator) || !Object.prototype.hasOwnProperty.call(output.success, "value")) {
          invalid(errorCode, "Method output success \uC870\uAC74\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        }
      }
      if (output.returnedCountPath !== void 0 && !SIMPLE_PATH.test(output.returnedCountPath)) {
        invalid(errorCode, "returnedCountPath\uB294 \uB2E8\uC21C path \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      }
      if (output.expectedCount !== void 0) {
        assertObject(output.expectedCount, errorCode, "Method output expectedCount");
        assertKnownFields(output.expectedCount, ["source", "inputId"], errorCode, "Method output expectedCount");
        if (output.expectedCount.source !== "input" || !inputIds.has(output.expectedCount.inputId)) {
          invalid(errorCode, "Method output expectedCount \uC785\uB825 \uC5F0\uACB0\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        }
      }
      return {
        ...output,
        ...output.success === void 0 ? {} : { success: { ...output.success } },
        ...output.expectedCount === void 0 ? {} : { expectedCount: { ...output.expectedCount } }
      };
    }
    function validateMethod(value, code) {
      const errorCode = code || "METHOD_INVALID";
      assertObject(value, errorCode, "Method");
      assertKnownFields(
        value,
        ["id", "displayName", "objectPath", "interface", "methodName", "inputs", "output", "tagGeneration"],
        errorCode,
        "Method"
      );
      if (!ID.test(value.id || "")) invalid(errorCode, "Method ID\uB294 \uC18C\uBB38\uC790 kebab-case\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
      if (typeof value.displayName !== "string" || !value.displayName.trim()) invalid(errorCode, "Method \uD45C\uC2DC \uC774\uB984\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
      if (!OBJECT_PATH.test(value.objectPath || "")) invalid(errorCode, "DBus objectPath \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (!INTERFACE.test(value.interface || "")) invalid(errorCode, "DBus interface \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (!MEMBER.test(value.methodName || "")) invalid(errorCode, "DBus methodName \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (!Array.isArray(value.inputs) || value.inputs.length > MAX_INPUTS_PER_METHOD) {
        invalid(errorCode, `Method inputs\uB294 ${MAX_INPUTS_PER_METHOD}\uAC1C \uC774\uD558\uC758 \uBC30\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.`);
      }
      const inputIds = /* @__PURE__ */ new Set();
      const inputs = value.inputs.map((input) => {
        const valid = validateInput(input, errorCode);
        if (inputIds.has(valid.id)) invalid(errorCode, "Method input ID\uAC00 \uC911\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { id: valid.id });
        inputIds.add(valid.id);
        return valid;
      });
      const output = validateOutput(value.output, inputIds, errorCode);
      let tagGeneration;
      if (value.tagGeneration !== void 0) {
        assertObject(value.tagGeneration, errorCode, "tagGeneration");
        assertKnownFields(
          value.tagGeneration,
          ["capability", "countInputId", "addressInputId"],
          errorCode,
          "tagGeneration"
        );
        if (!TAG_CAPABILITIES.has(value.tagGeneration.capability)) {
          invalid(errorCode, "\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 tagGeneration capability\uC785\uB2C8\uB2E4.");
        }
        const countInput = inputs.find((input) => input.id === value.tagGeneration.countInputId);
        const addressInput = inputs.find((input) => input.id === value.tagGeneration.addressInputId);
        if (!countInput || countInput.type !== "uint16" || !addressInput || addressInput.type !== "string") {
          invalid(errorCode, "tagGeneration \uC785\uB825 \uC5F0\uACB0\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        }
        tagGeneration = { ...value.tagGeneration };
      }
      return {
        id: value.id,
        displayName: value.displayName,
        objectPath: value.objectPath,
        interface: value.interface,
        methodName: value.methodName,
        inputs,
        output,
        ...tagGeneration === void 0 ? {} : { tagGeneration }
      };
    }
    function validateProfile(value) {
      assertObject(value, "PROFILE_INVALID", "Profile");
      validateProfileJsonSize(JSON.stringify(value));
      assertKnownFields(
        value,
        ["schemaVersion", "id", "profileVersion", "displayName", "vendor", "builtIn", "compatibility", "defaults", "methods"],
        "PROFILE_INVALID",
        "Profile"
      );
      if (value.schemaVersion !== 1) invalid("PROFILE_INVALID", "Profile schemaVersion\uC740 1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      if (!ID.test(value.id || "") || value.id.length > MAX_PROFILE_ID_LENGTH) {
        invalid("PROFILE_INVALID", `Profile ID\uB294 \uCD5C\uB300 ${MAX_PROFILE_ID_LENGTH}\uC790\uC758 \uC18C\uBB38\uC790 kebab-case\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
      }
      if (!Number.isInteger(value.profileVersion) || value.profileVersion < 1) invalid("PROFILE_INVALID", "profileVersion\uC740 1 \uC774\uC0C1\uC758 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
      if (typeof value.builtIn !== "boolean") invalid("PROFILE_INVALID", "Profile builtIn\uC740 boolean\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      if (typeof value.displayName !== "string" || !value.displayName.trim()) invalid("PROFILE_INVALID", "Profile \uD45C\uC2DC \uC774\uB984\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
      if (typeof value.vendor !== "string" || !value.vendor.trim()) invalid("PROFILE_INVALID", "Profile vendor\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
      assertObject(value.compatibility, "PROFILE_INVALID", "Profile compatibility");
      assertKnownFields(value.compatibility, ["minNeoVersion"], "PROFILE_INVALID", "Profile compatibility");
      try {
        parseSemVer(value.compatibility.minNeoVersion);
      } catch (_) {
        invalid("PROFILE_INVALID", "\uCD5C\uC18C Neo \uBC84\uC804\uC740 \uC5C4\uACA9\uD55C SemVer \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
      }
      assertObject(value.defaults, "PROFILE_INVALID", "Profile defaults");
      assertKnownFields(value.defaults, ["busType", "destination"], "PROFILE_INVALID", "Profile defaults");
      if (!["system", "session"].includes(value.defaults.busType) || !INTERFACE.test(value.defaults.destination || "")) {
        invalid("PROFILE_INVALID", "Profile DBus \uAE30\uBCF8\uAC12\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      }
      if (!Array.isArray(value.methods) || value.methods.length > MAX_METHODS_PER_PROFILE) {
        invalid("PROFILE_INVALID", `Profile methods\uB294 ${MAX_METHODS_PER_PROFILE}\uAC1C \uC774\uD558\uC758 \uBC30\uC5F4\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.`);
      }
      const methodIds = /* @__PURE__ */ new Set();
      const methods = value.methods.map((method) => {
        const valid = validateMethod(method, "PROFILE_INVALID");
        if (methodIds.has(valid.id)) invalid("PROFILE_INVALID", "Method ID\uAC00 \uC911\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { id: valid.id });
        methodIds.add(valid.id);
        return valid;
      });
      return {
        schemaVersion: 1,
        id: value.id,
        profileVersion: value.profileVersion,
        displayName: value.displayName,
        vendor: value.vendor,
        builtIn: value.builtIn,
        compatibility: { minNeoVersion: value.compatibility.minNeoVersion },
        defaults: { busType: value.defaults.busType, destination: value.defaults.destination },
        methods
      };
    }
    module2.exports = {
      MAX_INPUTS_PER_METHOD,
      MAX_METHODS_PER_PROFILE,
      MAX_PROFILE_ID_LENGTH,
      MAX_PROFILE_JSON_BYTES,
      validateMethod,
      validateProfile,
      validateProfileJsonSize
    };
  }
});

// cgi-bin/src/profiles/store.js
var require_store2 = __commonJS({
  "cgi-bin/src/profiles/store.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var process = require("process");
    var { writeJsonAtomic } = require_atomic_json();
    var { error } = require_errors();
    var { validateProfile, validateProfileJsonSize } = require_validator3();
    var { compareSemVer, parseSemVer } = require_version();
    function environmentValue(name) {
      if (process.env && typeof process.env.get === "function") return process.env.get(name);
      return process.env && process.env[name];
    }
    function resolveRuntimeNeoVersion(cgiRoot, explicit) {
      let value = explicit || environmentValue("MACHBASE_NEO_VERSION") || environmentValue("NEO_VERSION");
      if (!value) {
        try {
          value = JSON.parse(fs.readFileSync(path.join(cgiRoot, "package.json"), "utf8")).minServerVersion;
        } catch (_) {
          value = "8.5.8";
        }
      }
      const normalized = String(value).replace(/^v(?=\d)/, "");
      parseSemVer(normalized, "RUNTIME_VERSION_INVALID");
      return normalized;
    }
    var ProfileStore = class {
      constructor(options) {
        const settings = options || {};
        this.cgiRoot = settings.cgiRoot;
        this.builtInDir = path.join(this.cgiRoot, "profiles.d");
        this.customDir = path.join(this.cgiRoot, "conf.d", "profiles");
        this.runtimeNeoVersion = resolveRuntimeNeoVersion(this.cgiRoot, settings.runtimeNeoVersion);
      }
      readDirectory(directory, builtIn) {
        if (!fs.existsSync(directory)) return [];
        return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => {
          let value;
          try {
            const source = fs.readFileSync(path.join(directory, name), "utf8");
            validateProfileJsonSize(source);
            value = JSON.parse(source);
          } catch (readError) {
            throw error("PROFILE_INVALID", "Profile \uD30C\uC77C\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { file: name, message: readError.message });
          }
          const profile = validateProfile(value);
          if (`${profile.id}.json` !== name) throw error("PROFILE_INVALID", "Profile ID\uC640 \uD30C\uC77C\uBA85\uC774 \uB2E4\uB985\uB2C8\uB2E4.", { file: name });
          return { ...profile, builtIn };
        });
      }
      list() {
        const profiles = [...this.readDirectory(this.builtInDir, true), ...this.readDirectory(this.customDir, false)];
        const seen = /* @__PURE__ */ new Set();
        profiles.forEach((profile) => {
          if (seen.has(profile.id)) throw error("PROFILE_INVALID", "Profile ID\uAC00 \uC911\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.", { id: profile.id });
          seen.add(profile.id);
        });
        return profiles;
      }
      find(id) {
        return this.list().find((profile) => profile.id === id) || null;
      }
      isCompatible(profile) {
        return compareSemVer(profile.compatibility.minNeoVersion, this.runtimeNeoVersion) <= 0;
      }
      save(profile) {
        const value = { ...validateProfile(profile), builtIn: false };
        writeJsonAtomic(path.join(this.customDir, `${value.id}.json`), value);
        return value;
      }
      remove(id) {
        fs.unlinkSync(path.join(this.customDir, `${id}.json`));
      }
    };
    module2.exports = { ProfileStore, resolveRuntimeNeoVersion };
  }
});

// cgi-bin/src/profiles/references.js
var require_references2 = __commonJS({
  "cgi-bin/src/profiles/references.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { classifyControllerState } = require_controller_state();
    var { isNotInstalled } = require_controller_adapter();
    var { JobIndexRepository } = require_index_repository();
    var JOB_ID = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
    var PROFILE_METHOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    function executionState(controllerState) {
      if (["RUNNING", "STARTING", "STOPPING"].includes(controllerState)) return "running";
      if (["STOPPED", "FAILED", "NOT_INSTALLED"].includes(controllerState)) return "stopped";
      return "unknown";
    }
    function validMethodCalls(methodCalls) {
      if (!Array.isArray(methodCalls) || methodCalls.length === 0) return false;
      const callIds = /* @__PURE__ */ new Set();
      return methodCalls.every((call) => {
        if (!call || typeof call !== "object" || Array.isArray(call) || !JOB_ID.test(call.id || "") || !PROFILE_METHOD_ID.test(call.methodId || "") || callIds.has(call.id)) return false;
        callIds.add(call.id);
        return true;
      });
    }
    function invalidRecord(stem, value, reason, global) {
      return {
        stem,
        value: value && typeof value === "object" && !Array.isArray(value) ? value : {},
        invalidConfig: true,
        global: Boolean(global),
        reason
      };
    }
    var ReferenceAnalyzer = class {
      constructor(options) {
        this.jobDir = path.join(options.cgiRoot, "conf.d", "jobs");
        this.controller = options.controller;
        this.stateInspector = options.stateInspector || null;
        this.indexes = options.useIndex === true ? new JobIndexRepository({ cgiRoot: options.cgiRoot, jobDirectory: this.jobDir }) : null;
      }
      documents() {
        if (this.indexes) {
          return this.indexes.list().map((record) => {
            if (record.error || !record.index) {
              return invalidRecord(record.name, null, record.error && record.error.message, true);
            }
            return {
              stem: record.name,
              value: {
                name: record.name,
                profileId: record.index.profileId,
                methodCalls: record.index.methodReferences.map((reference) => ({
                  id: reference.callId,
                  methodId: reference.methodId
                }))
              },
              invalidConfig: false,
              global: false,
              reason: null
            };
          });
        }
        if (!fs.existsSync(this.jobDir)) return [];
        const documents = [];
        fs.readdirSync(this.jobDir).filter((name) => name.endsWith(".json")).sort().forEach((file) => {
          const stem = file.slice(0, -5);
          let value;
          try {
            value = JSON.parse(fs.readFileSync(path.join(this.jobDir, file), "utf8"));
          } catch (readError) {
            documents.push(invalidRecord(stem, null, `Job JSON\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${readError.message}`, true));
            return;
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            documents.push(invalidRecord(stem, value, "Job document\uB294 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.", true));
            return;
          }
          const profileIdValid = PROFILE_METHOD_ID.test(value.profileId || "");
          const identityValid = JOB_ID.test(stem) && typeof value.name === "string" && JOB_ID.test(value.name) && value.name === stem;
          const schemaValid = value.schemaVersion === 1;
          const callsValid = validMethodCalls(value.methodCalls);
          if (!profileIdValid || !identityValid || !schemaValid || !callsValid) {
            const reasons = [];
            if (!schemaValid) reasons.push("schemaVersion\uC740 1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
            if (!identityValid) reasons.push("\uD30C\uC77C\uBA85\uACFC Job name\uC774 \uC720\uD6A8\uD558\uACE0 \uAC19\uC544\uC57C \uD569\uB2C8\uB2E4.");
            if (!profileIdValid) reasons.push("profileId\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
            if (!callsValid) reasons.push("methodCalls \uAD6C\uC870\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
            documents.push(invalidRecord(stem, value, reasons.join(" "), !profileIdValid));
            return;
          }
          documents.push({ stem, value, invalidConfig: false, global: false, reason: null });
        });
        return documents;
      }
      find(profileId, methodId) {
        const references = [];
        this.documents().filter((record) => record.global || record.value.profileId === profileId).forEach((record) => {
          if (record.invalidConfig || !methodId) {
            references.push({
              name: record.stem,
              documentName: record.value.name,
              calls: [],
              invalidConfig: record.invalidConfig,
              global: record.global,
              invalidReason: record.reason
            });
            return;
          }
          const calls = record.value.methodCalls.filter((call) => call.methodId === methodId).map((call) => call.id);
          if (calls.length) references.push({
            name: record.stem,
            documentName: record.value.name,
            calls,
            invalidConfig: false,
            global: false,
            invalidReason: null
          });
        });
        return references;
      }
      withStates(references, callback) {
        if (!references.length) {
          callback(null, []);
          return;
        }
        let pending = references.length;
        const results = new Array(references.length);
        references.forEach((reference, index) => {
          if (reference.invalidConfig) {
            results[index] = {
              ...reference,
              controllerState: "UNKNOWN",
              controllerDetail: reference.invalidReason || "Job config\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
              executionState: "unknown"
            };
            pending -= 1;
            if (pending === 0) callback(null, results);
            return;
          }
          let finished = false;
          const done = (statusError, info) => {
            if (finished) return;
            finished = true;
            const classified = statusError ? isNotInstalled(statusError) ? classifyControllerState(null, { notInstalled: true }) : { state: "UNKNOWN", known: false, activeForStop: false, detail: statusError.message } : classifyControllerState(info);
            results[index] = {
              ...reference,
              controllerState: classified.state,
              controllerDetail: classified.detail || null,
              executionState: executionState(classified.state)
            };
            pending -= 1;
            if (pending === 0) callback(null, results);
          };
          try {
            if (this.stateInspector) {
              this.stateInspector(reference.name, (statusError, state) => {
                if (statusError) {
                  done(statusError);
                  return;
                }
                const controllerState = state && state.controllerState;
                const known = ["RUNNING", "STARTING", "STOPPING", "STOPPED", "FAILED", "NOT_INSTALLED"].includes(controllerState);
                if (!known) {
                  done(new Error(state && state.controllerDetail || "LS collector Job state is unknown."));
                  return;
                }
                results[index] = {
                  ...reference,
                  controllerState,
                  controllerDetail: state.controllerDetail || null,
                  executionState: executionState(controllerState)
                };
                pending -= 1;
                if (pending === 0) callback(null, results);
              });
            } else this.controller.status(`_dbu_${reference.name}`, done);
          } catch (statusError) {
            done(statusError);
          }
        });
      }
    };
    module2.exports = { ReferenceAnalyzer };
  }
});

// cgi-bin/src/profiles/manager.js
var require_manager3 = __commonJS({
  "cgi-bin/src/profiles/manager.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var { profileLockKey } = require_profile_lock_key();
    var fs = require("fs");
    var path = require("path");
    var { loadSettings } = require_settings_loader();
    var { createControllerAdapter } = require_controller_adapter();
    var { createLsRuntime } = require_ls_runtime();
    var { loadProductPolicy } = require_product_policy();
    var { validateMethod, validateProfile } = require_validator3();
    var { ProfileStore } = require_store2();
    var { ReferenceAnalyzer } = require_references2();
    var { createJobOperationLock } = require_operation_lock();
    var ProfileManager = class {
      constructor(options) {
        const settings = options || {};
        const productPolicy = settings.productPolicy || loadProductPolicy(settings.cgiRoot);
        this.store = settings.store || new ProfileStore({
          cgiRoot: settings.cgiRoot,
          runtimeNeoVersion: settings.runtimeNeoVersion
        });
        this.controller = settings.controller || createControllerAdapter(settings.serviceModule);
        const lsRuntime = productPolicy.target === "ls" ? createLsRuntime({
          cgiRoot: settings.cgiRoot,
          controller: this.controller,
          // Profile guards only call inspect(), but retain a complete adapter
          // shape so the data-plane implementation remains encapsulated here.
          repository: { list: () => [] }
        }) : null;
        this.references = settings.references || new ReferenceAnalyzer({
          cgiRoot: settings.cgiRoot,
          controller: this.controller,
          stateInspector: lsRuntime && lsRuntime.inspect,
          useIndex: productPolicy.target === "ls"
        });
        this.profileMutationLock = settings.profileMutationLock || createJobOperationLock({
          directory: path.join(settings.cgiRoot, "conf.d", ".profile-mutation-locks")
        });
        this.jobOperationLock = settings.jobOperationLock || createJobOperationLock({
          directory: path.join(settings.cgiRoot, "conf.d", ".job-operation-locks")
        });
        this.profileReaderLock = settings.profileReaderLock || createJobOperationLock({
          directory: path.join(settings.cgiRoot, "conf.d", ".profile-mutation-readers")
        });
      }
      execute(callback, operation) {
        try {
          callback(null, operation());
        } catch (operationError) {
          callback(operationError);
        }
      }
      requiredProfile(id) {
        const profile = this.store.find(id);
        if (!profile) throw error("PROFILE_NOT_FOUND", "Profile\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { id });
        return profile;
      }
      writableProfile(id) {
        const profile = this.requiredProfile(id);
        if (profile.builtIn) throw error("PROFILE_READ_ONLY", "Built-in Profile\uC740 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { id });
        return profile;
      }
      listProfiles(callback) {
        this.execute(callback, () => {
          const settings = loadSettings(path.join(this.store.cgiRoot, "conf.d", "settings.json"));
          return this.store.list().map((profile) => ({
            id: profile.id,
            displayName: profile.displayName,
            vendor: profile.vendor,
            builtIn: profile.builtIn,
            profileVersion: profile.profileVersion,
            methodCount: profile.methods.length,
            compatible: this.store.isCompatible(profile),
            compatibilityReason: this.store.isCompatible(profile) ? null : `Neo ${this.store.runtimeNeoVersion}\uC5D0\uC11C\uB294 \uCD5C\uC18C ${profile.compatibility.minNeoVersion} Profile\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
            default: settings.defaultProfileId === profile.id
          }));
        });
      }
      getProfile(id, callback) {
        let profile;
        let refs;
        try {
          profile = this.requiredProfile(id);
          refs = this.references.find(id);
        } catch (getError) {
          callback(getError);
          return;
        }
        this.references.withStates(refs, (_error, references) => callback(null, {
          profile,
          compatible: this.store.isCompatible(profile),
          compatibilityReason: this.store.isCompatible(profile) ? null : `Neo ${this.store.runtimeNeoVersion}\uC5D0\uC11C\uB294 \uCD5C\uC18C ${profile.compatibility.minNeoVersion} Profile\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.`,
          references
        }));
      }
      createProfile(value, callback) {
        let profileId;
        try {
          profileId = validateProfile({ ...value, builtIn: false, profileVersion: 1 }).id;
        } catch (createError) {
          callback(createError);
          return;
        }
        this.guardMutation(profileId, "PROFILE_IN_USE_BY_RUNNING_JOB", [], callback, () => {
          const valid = validateProfile({ ...value, builtIn: false, profileVersion: 1 });
          if (this.store.find(valid.id)) throw error("PROFILE_ALREADY_EXISTS", "\uAC19\uC740 Profile ID\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { id: valid.id });
          return this.store.save({ ...valid, builtIn: false });
        }, () => this.references.find(profileId));
      }
      guardMutation(profileId, code, references, callback, operation, refreshReferences) {
        let fence;
        const handles = [];
        let completed = false;
        const done = (failure, value) => {
          if (completed) return;
          completed = true;
          let releaseFailure = null;
          [...handles].reverse().forEach((handle) => {
            try {
              handle.release();
            } catch (cleanupError) {
              if (!releaseFailure) releaseFailure = cleanupError;
            }
          });
          try {
            if (fence) fence.release();
          } catch (cleanupError) {
            if (!releaseFailure) releaseFailure = cleanupError;
          }
          if (failure && releaseFailure && typeof failure === "object") failure.cleanupError = releaseFailure;
          callback(failure || releaseFailure, value);
        };
        try {
          fence = this.profileMutationLock.acquire(profileLockKey(profileId));
          const readerPrefix = `${profileLockKey(profileId)}--`;
          fs.readdirSync(path.join(this.store.cgiRoot, "conf.d", ".profile-mutation-readers")).filter((entry) => entry.startsWith(readerPrefix) && entry.endsWith(".lock")).forEach((entry) => {
            const reader = this.profileReaderLock.acquire(entry.slice(0, -5));
            reader.release();
          });
          references = refreshReferences ? refreshReferences() : references;
          const invalidJob = references.find((reference) => reference.invalidConfig);
          if (invalidJob) throw error("JOB_INVALID_CONFIG", "Job \uD30C\uC77C\uBA85\uACFC document name\uC774 \uB2EC\uB77C \uC548\uC804\uD558\uAC8C \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
            fileName: invalidJob.name,
            documentName: invalidJob.documentName
          });
          [...new Set(references.map((reference) => reference.name))].sort().forEach((name) => handles.push(this.jobOperationLock.acquire(name)));
        } catch (acquireError) {
          done(acquireError);
          return;
        }
        try {
          references = refreshReferences ? refreshReferences() : references;
          const invalidJob = references.find((reference) => reference.invalidConfig);
          if (invalidJob) throw error("JOB_INVALID_CONFIG", "Job \uD30C\uC77C\uBA85\uACFC document name\uC774 \uB2EC\uB77C \uC548\uC804\uD558\uAC8C \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
            fileName: invalidJob.name,
            documentName: invalidJob.documentName
          });
        } catch (refreshError) {
          done(refreshError);
          return;
        }
        this.references.withStates(references, (_stateError, values) => {
          const invalidJob = values.find((reference) => reference.invalidConfig);
          if (invalidJob) {
            done(error("JOB_INVALID_CONFIG", "Job \uD30C\uC77C\uBA85\uACFC document name\uC774 \uB2EC\uB77C \uC548\uC804\uD558\uAC8C \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
              fileName: invalidJob.name,
              documentName: invalidJob.documentName
            }));
            return;
          }
          const blocking = values.filter((reference) => ["RUNNING", "STARTING", "STOPPING", "UNKNOWN"].includes(reference.controllerState));
          if (blocking.length) {
            done(error(code, "\uC2E4\uD589 \uC911\uC774\uAC70\uB098 \uC0C1\uD0DC\uB97C \uC54C \uC218 \uC5C6\uB294 \uCC38\uC870 Job \uB54C\uBB38\uC5D0 \uBC14\uAFC0 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: blocking }));
            return;
          }
          this.execute(done, operation);
        });
      }
      withProfileFence(profileId, callback, operation) {
        let fence;
        try {
          fence = this.profileMutationLock.acquire(profileLockKey(profileId));
          const readerPrefix = `${profileLockKey(profileId)}--`;
          fs.readdirSync(path.join(this.store.cgiRoot, "conf.d", ".profile-mutation-readers")).filter((entry) => entry.startsWith(readerPrefix) && entry.endsWith(".lock")).forEach((entry) => {
            const reader = this.profileReaderLock.acquire(entry.slice(0, -5));
            reader.release();
          });
        } catch (failure) {
          let releaseFailure = null;
          try {
            if (fence) fence.release();
          } catch (cleanupError) {
            releaseFailure = cleanupError;
          }
          if (releaseFailure && failure && typeof failure === "object") failure.cleanupError = releaseFailure;
          callback(failure || releaseFailure);
          return;
        }
        let finished = false;
        const done = (failure, value) => {
          if (finished) return;
          finished = true;
          let releaseFailure = null;
          try {
            fence.release();
          } catch (cleanupError) {
            releaseFailure = cleanupError;
          }
          if (failure && releaseFailure && typeof failure === "object") failure.cleanupError = releaseFailure;
          callback(failure || releaseFailure, value);
        };
        this.execute(done, operation);
      }
      updateProfile(value, callback) {
        let profileId;
        try {
          profileId = validateProfile({ ...value, builtIn: false }).id;
        } catch (updateError) {
          callback(updateError);
          return;
        }
        this.guardMutation(profileId, "PROFILE_IN_USE_BY_RUNNING_JOB", [], callback, () => {
          const current = this.writableProfile(profileId);
          const valid = validateProfile({ ...value, builtIn: false });
          const nextMethodIds = new Set(valid.methods.map((method) => method.id));
          const removed = current.methods.filter((method) => !nextMethodIds.has(method.id));
          for (const removedMethod of removed) {
            const methodRefs = this.references.find(current.id, removedMethod.id);
            if (methodRefs.length) throw error("METHOD_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 Method\uB294 Profile PUT\uC73C\uB85C \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
              profileId: current.id,
              id: removedMethod.id,
              jobs: methodRefs
            });
          }
          return this.store.save({
            ...valid,
            builtIn: false,
            profileVersion: current.profileVersion + 1
          });
        }, () => this.references.find(profileId));
      }
      deleteProfile(id, callback) {
        this.withProfileFence(id, callback, () => {
          this.writableProfile(id);
          const settings = loadSettings(path.join(this.store.cgiRoot, "conf.d", "settings.json"));
          if (settings.defaultProfileId === id) {
            throw error("PROFILE_DEFAULT", "\uAE30\uBCF8 Profile\uC740 \uB2E4\uB978 \uAE30\uBCF8\uAC12\uC744 \uC120\uD0DD\uD558\uAE30 \uC804\uC5D0 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
              id,
              defaultProfileId: settings.defaultProfileId
            });
          }
          const refs = this.references.find(id);
          const invalidJob = refs.find((reference) => reference.invalidConfig);
          if (invalidJob) throw error("JOB_INVALID_CONFIG", "Job \uD30C\uC77C\uBA85\uACFC document name\uC774 \uB2EC\uB77C \uC548\uC804\uD558\uAC8C \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
            fileName: invalidJob.name,
            documentName: invalidJob.documentName
          });
          if (refs.length) throw error("PROFILE_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 Profile\uC740 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          this.store.remove(id);
          return { id };
        });
      }
      listMethods(profileId, callback) {
        this.execute(callback, () => this.requiredProfile(profileId).methods.map((method) => ({
          id: method.id,
          displayName: method.displayName,
          inputCount: method.inputs.length,
          outputShape: method.output.shape
        })));
      }
      getMethod(profileId, id, callback) {
        let profile;
        let method;
        let refs;
        try {
          profile = this.requiredProfile(profileId);
          method = profile.methods.find((item) => item.id === id);
          if (!method) throw error("METHOD_NOT_FOUND", "Method\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { profileId, id });
          refs = this.references.find(profileId, id);
        } catch (getError) {
          callback(getError);
          return;
        }
        this.references.withStates(refs, (_error, references) => callback(null, { method, references }));
      }
      createMethod(profileId, value, callback) {
        this.guardMutation(profileId, "METHOD_IN_USE_BY_RUNNING_JOB", [], callback, () => {
          const profile = this.writableProfile(profileId);
          const method = validateMethod(value);
          if (profile.methods.some((item) => item.id === method.id)) {
            throw error("METHOD_ALREADY_EXISTS", "\uAC19\uC740 Method ID\uAC00 \uC774\uBBF8 \uC788\uC2B5\uB2C8\uB2E4.", { profileId, id: method.id });
          }
          this.store.save({ ...profile, profileVersion: profile.profileVersion + 1, methods: [...profile.methods, method] });
          return method;
        }, () => this.references.find(profileId));
      }
      updateMethod(profileId, value, callback) {
        let methodId;
        try {
          methodId = validateMethod(value).id;
        } catch (updateError) {
          callback(updateError);
          return;
        }
        this.guardMutation(profileId, "METHOD_IN_USE_BY_RUNNING_JOB", [], callback, () => {
          const profile = this.writableProfile(profileId);
          const method = validateMethod(value);
          const index = profile.methods.findIndex((item) => item.id === method.id);
          if (index < 0) throw error("METHOD_NOT_FOUND", "Method\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { profileId, id: method.id });
          const methods = profile.methods.slice();
          methods[index] = method;
          this.store.save({ ...profile, profileVersion: profile.profileVersion + 1, methods });
          return method;
        }, () => this.references.find(profileId, methodId));
      }
      deleteMethod(profileId, id, callback) {
        this.withProfileFence(profileId, callback, () => {
          const profile = this.writableProfile(profileId);
          const index = profile.methods.findIndex((item) => item.id === id);
          if (index < 0) throw error("METHOD_NOT_FOUND", "Method\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { profileId, id });
          const invalidProfileJob = this.references.find(profileId).find((reference) => reference.invalidConfig);
          if (invalidProfileJob) throw error("JOB_INVALID_CONFIG", "Job \uD30C\uC77C\uBA85\uACFC document name\uC774 \uB2EC\uB77C \uC548\uC804\uD558\uAC8C \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
            fileName: invalidProfileJob.name,
            documentName: invalidProfileJob.documentName
          });
          const refs = this.references.find(profileId, id);
          const invalidJob = refs.find((reference) => reference.invalidConfig);
          if (invalidJob) throw error("JOB_INVALID_CONFIG", "Job \uD30C\uC77C\uBA85\uACFC document name\uC774 \uB2EC\uB77C \uC548\uC804\uD558\uAC8C \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", {
            fileName: invalidJob.name,
            documentName: invalidJob.documentName
          });
          if (refs.length) throw error("METHOD_IN_USE", "Job\uC774 \uCC38\uC870\uD558\uB294 Method\uB294 \uC9C0\uC6B8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { jobs: refs });
          const methods = profile.methods.slice();
          methods.splice(index, 1);
          this.store.save({ ...profile, profileVersion: profile.profileVersion + 1, methods });
          return { profileId, id };
        });
      }
    };
    module2.exports = { ProfileManager };
  }
});

// cgi-bin/src/dbus/arguments.js
var require_arguments = __commonJS({
  "cgi-bin/src/dbus/arguments.js"(exports2, module2) {
    "use strict";
    var { error } = require_errors();
    var { neoArgument, normalizeType, typeName, validSignature } = require_types();
    function inputId(input) {
      return input && (input.id || input.name);
    }
    function invalid(input, reason) {
      throw error("DBUS_ARGUMENT_INVALID", reason, { inputId: inputId(input), type: input && input.type });
    }
    function typedValue(input, value) {
      if (!input || typeof inputId(input) !== "string" || normalizeType(input.type) === null) invalid(input, "DBus input \uC815\uC758\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      const pattern = input.validation && input.validation.pattern;
      if (pattern !== void 0) {
        let matches = false;
        try {
          matches = typeof value === "string" && new RegExp(pattern).test(value);
        } catch (_) {
          invalid(input, "DBus input pattern \uC815\uC758\uAC00 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
        }
        if (!matches) invalid(input, `input ${inputId(input)} \uAC12\uC774 pattern\uACFC \uB9DE\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.`);
      }
      const encoded = neoArgument(input.type, value);
      if (encoded === null) invalid(input, `input ${inputId(input)} \uAC12\uC774 ${typeName(input.type)} \uD615\uC2DD\uC774 \uC544\uB2D9\uB2C8\uB2E4.`);
      if (encoded.unsupported) throw error("DBUS_ARGUMENT_UNSUPPORTED", "\uD604\uC7AC Neo DBus \uBAA8\uB4C8\uC740 \uC774 DBus type \uD638\uCD9C\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.", { inputId: inputId(input), type: encoded.unsupported });
      return encoded.value;
    }
    function buildTypedArguments(inputs, values) {
      if (!Array.isArray(inputs) || !values || typeof values !== "object" || Array.isArray(values)) invalid(null, "DBus inputs\uC640 values \uD615\uC2DD\uC774 \uC798\uBABB\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      return inputs.map((input) => {
        const id = inputId(input);
        if (!Object.prototype.hasOwnProperty.call(values, id) || values[id] === null || values[id] === void 0) invalid(input, `input ${id} \uAC12\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.`);
        return typedValue(input, values[id]);
      });
    }
    module2.exports = { buildTypedArguments, typedValue, validSignature };
  }
});

// cgi-bin/src/dbus/test-call.js
var require_test_call = __commonJS({
  "cgi-bin/src/dbus/test-call.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var { error } = require_errors();
    var { loadSettings } = require_settings_loader();
    var { buildTypedArguments } = require_arguments();
    var { createDbusAdapter } = require_adapter();
    var { InterfaceStore } = require_store();
    function invalid(reason, details) {
      throw error("REQUEST_INVALID", reason, details);
    }
    var TestCallManager = class {
      constructor(options) {
        const settings = options || {};
        this.cgiRoot = settings.cgiRoot;
        this.interfaceStore = settings.interfaceStore || (this.cgiRoot ? new InterfaceStore({ cgiRoot: this.cgiRoot }) : null);
        this.settings = settings.settings || (this.cgiRoot ? loadSettings(path.join(this.cgiRoot, "conf.d", "settings.json")) : null);
        this.dbusFactory = settings.dbusFactory || (() => createDbusAdapter());
        this.now = settings.now || (() => /* @__PURE__ */ new Date());
      }
      resolve(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid("Test Call body\uB294 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
        if (Object.keys(payload).some((key) => !["interfaceId", "methodId", "inputs"].includes(key))) invalid("Test Call\uC740 interfaceId, methodId, inputs\uB9CC \uBC1B\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
        if (typeof payload.interfaceId !== "string" || !payload.interfaceId) invalid("Test Call interfaceId\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
        if (typeof payload.methodId !== "string" || !payload.methodId) invalid("Test Call methodId\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
        if (!payload.inputs || typeof payload.inputs !== "object" || Array.isArray(payload.inputs)) invalid("Test Call inputs\uB294 \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
        if (!this.interfaceStore) invalid("DBus Interface \uC800\uC7A5\uC18C\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        const dbusInterface = this.interfaceStore.find(payload.interfaceId);
        if (!dbusInterface) throw error("DBUS_INTERFACE_NOT_FOUND", "Test Call DBus Interface\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { id: payload.interfaceId });
        const method = dbusInterface.methods.find((item) => item.id === payload.methodId);
        if (!method) throw error("DBUS_METHOD_NOT_FOUND", "Test Call DBus Method\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", { interfaceId: payload.interfaceId, methodId: payload.methodId });
        if (!this.settings || !this.settings.limits) invalid("Test Call settings limits\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        return {
          dbusInterface,
          method,
          dbus: { busType: dbusInterface.busType, destination: dbusInterface.destination },
          callMethod: { objectPath: dbusInterface.objectPath, interface: dbusInterface.interface, methodName: method.member },
          inputs: payload.inputs
        };
      }
      call(payload, callback) {
        let dbus = null;
        try {
          const request = this.resolve(payload);
          const requested = this.now();
          const args = buildTypedArguments(request.method.inputs, request.inputs);
          try {
            dbus = this.dbusFactory();
            dbus.connect(request.dbus.busType);
          } catch (_) {
            throw error("DBUS_UNAVAILABLE", "DBus\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
          }
          let response;
          try {
            response = dbus.call(request.dbus, request.callMethod, args);
          } catch (_) {
            throw error("DBUS_CALL_FAILED", "DBus Method \uD638\uCD9C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
          }
          const completed = this.now();
          callback(null, { requestedAt: requested.toISOString(), durationMs: Math.max(0, completed.getTime() - requested.getTime()), success: true, valueCount: response.body.length, values: response.body, body: response.body });
        } catch (failure) {
          callback(failure);
        } finally {
          if (dbus) dbus.close();
        }
      }
    };
    module2.exports = { TestCallManager };
  }
});

// cgi-bin/src/cgi/runtime.js
module.exports = {
  bootstrap: require_bootstrap(),
  http: require_http(),
  jobApi: require_job_api(),
  SettingsManager: require_settings_manager().SettingsManager,
  InterfaceManager: require_manager2().InterfaceManager,
  ProfileManager: require_manager3().ProfileManager,
  TestCallManager: require_test_call().TestCallManager
};
