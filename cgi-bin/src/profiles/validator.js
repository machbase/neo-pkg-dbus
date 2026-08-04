'use strict';

const { error } = require('../config/errors.js');
const { parseSemVer } = require('./version.js');

const MAX_PROFILE_JSON_BYTES = 256 * 1024;
const MAX_METHODS_PER_PROFILE = 128;
const MAX_INPUTS_PER_METHOD = 64;
const MAX_PROFILE_ID_LENGTH = 100;
const DBUS_TYPES = new Set([
  'byte', 'uint8', 'uint16', 'uint32', 'uint64', 'int16', 'int32', 'int64',
  'float32', 'float64', 'double', 'bool', 'string', 'objectpath', 'path', 'signature',
]);
const INTEGER_TYPES = new Set(['byte', 'uint8', 'uint16', 'uint32', 'uint64', 'int16', 'int32', 'int64']);
const WIDE_INTEGER_TYPES = new Set(['uint64', 'int64']);
const INTEGER_RANGES = {
  byte: [0n, 255n],
  uint8: [0n, 255n],
  uint16: [0n, 65535n],
  uint32: [0n, 4294967295n],
  uint64: [0n, 18446744073709551615n],
  int16: [-32768n, 32767n],
  int32: [-2147483648n, 2147483647n],
  int64: [-9223372036854775808n, 9223372036854775807n],
};
const DECODERS = new Set(['raw', 'json']);
const SHAPES = new Set(['scalar', 'array', 'object']);
const SUCCESS_OPERATORS = new Set(['equals']);
const TAG_CAPABILITIES = new Set(['ls-get-device-data']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INPUT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;
const INTERFACE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MEMBER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIMPLE_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/;

function invalid(code, reason, details) {
  throw error(code, reason, details);
}

function assertObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(code, `${label}은(는) 객체여야 합니다.`);
  }
}

function assertKnownFields(value, allowed, code, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) invalid(code, `${label}에 알 수 없는 필드가 있습니다.`, { fields: unknown });
}

function utf8Bytes(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function validateProfileJsonSize(source) {
  if (utf8Bytes(String(source)) > MAX_PROFILE_JSON_BYTES) {
    invalid('PROFILE_INVALID', `Profile JSON은 ${MAX_PROFILE_JSON_BYTES} bytes 이하여야 합니다.`);
  }
}

function integerValidationBound(input, value, errorCode, label) {
  let bound;
  try {
    if (WIDE_INTEGER_TYPES.has(input.type)) {
      if (typeof value === 'number' && Number.isSafeInteger(value)) bound = BigInt(value);
      else if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value)) bound = BigInt(value);
      else invalid(errorCode, `input validation ${label}은 정확한 64-bit 정수여야 합니다.`);
    } else if (typeof value === 'number' && Number.isInteger(value)) bound = BigInt(value);
    else invalid(errorCode, `input validation ${label}은 정수여야 합니다.`);
  } catch (_) {
    invalid(errorCode, `input validation ${label} 정수 형식이 잘못되었습니다.`);
  }
  const range = INTEGER_RANGES[input.type];
  if (bound < range[0] || bound > range[1]) {
    invalid(errorCode, `input validation ${label}이 ${input.type} 범위를 벗어났습니다.`);
  }
  return bound;
}

function validateInput(input, errorCode) {
  assertObject(input, errorCode, 'Method input');
  assertKnownFields(input, ['id', 'type', 'required', 'validation'], errorCode, 'Method input');
  if (!INPUT_ID.test(input.id || '') || !DBUS_TYPES.has(input.type)) {
    invalid(errorCode, 'Method input ID 또는 type이 잘못되었습니다.');
  }
  if (typeof input.required !== 'boolean') invalid(errorCode, 'Method input required는 boolean이어야 합니다.');
  if (input.validation !== undefined) {
    assertObject(input.validation, errorCode, 'Method input validation');
    assertKnownFields(input.validation, ['minimum', 'maximum', 'pattern'], errorCode, 'Method input validation');
    const { minimum, maximum, pattern } = input.validation;
    let comparableMinimum = minimum;
    let comparableMaximum = maximum;
    if (INTEGER_TYPES.has(input.type)) {
      if (minimum !== undefined) comparableMinimum = integerValidationBound(input, minimum, errorCode, 'minimum');
      if (maximum !== undefined) comparableMaximum = integerValidationBound(input, maximum, errorCode, 'maximum');
    } else {
      if (minimum !== undefined && (typeof minimum !== 'number' || !Number.isFinite(minimum))) {
        invalid(errorCode, 'input validation minimum은 유한한 숫자여야 합니다.');
      }
      if (maximum !== undefined && (typeof maximum !== 'number' || !Number.isFinite(maximum))) {
        invalid(errorCode, 'input validation maximum은 유한한 숫자여야 합니다.');
      }
    }
    if (minimum !== undefined && maximum !== undefined && comparableMinimum > comparableMaximum) {
      invalid(errorCode, 'input validation minimum은 maximum보다 클 수 없습니다.');
    }
    if (pattern !== undefined) {
      if (typeof pattern !== 'string') invalid(errorCode, 'input validation pattern은 문자열이어야 합니다.');
      try {
        new RegExp(pattern);
      } catch (_) {
        invalid(errorCode, 'input validation pattern 정규식이 잘못되었습니다.');
      }
    }
  }
  return input.validation === undefined
    ? { id: input.id, type: input.type, required: input.required }
    : { id: input.id, type: input.type, required: input.required, validation: { ...input.validation } };
}

function validateOutput(output, inputIds, errorCode) {
  assertObject(output, errorCode, 'Method output');
  assertKnownFields(
    output,
    ['decoder', 'shape', 'path', 'success', 'returnedCountPath', 'expectedCount'],
    errorCode,
    'Method output',
  );
  if (!DECODERS.has(output.decoder) || !SHAPES.has(output.shape)) {
    invalid(errorCode, 'Method output decoder 또는 shape이 잘못되었습니다.');
  }
  if (output.path !== undefined && !SIMPLE_PATH.test(output.path)) {
    invalid(errorCode, 'Method output path는 단순 path 형식이어야 합니다.');
  }
  if (output.success !== undefined) {
    assertObject(output.success, errorCode, 'Method output success');
    assertKnownFields(output.success, ['path', 'operator', 'value'], errorCode, 'Method output success');
    if (!SIMPLE_PATH.test(output.success.path || '') || !SUCCESS_OPERATORS.has(output.success.operator)
      || !Object.prototype.hasOwnProperty.call(output.success, 'value')) {
      invalid(errorCode, 'Method output success 조건이 잘못되었습니다.');
    }
  }
  if (output.returnedCountPath !== undefined && !SIMPLE_PATH.test(output.returnedCountPath)) {
    invalid(errorCode, 'returnedCountPath는 단순 path 형식이어야 합니다.');
  }
  if (output.expectedCount !== undefined) {
    assertObject(output.expectedCount, errorCode, 'Method output expectedCount');
    assertKnownFields(output.expectedCount, ['source', 'inputId'], errorCode, 'Method output expectedCount');
    if (output.expectedCount.source !== 'input' || !inputIds.has(output.expectedCount.inputId)) {
      invalid(errorCode, 'Method output expectedCount 입력 연결이 잘못되었습니다.');
    }
  }
  return {
    ...output,
    ...(output.success === undefined ? {} : { success: { ...output.success } }),
    ...(output.expectedCount === undefined ? {} : { expectedCount: { ...output.expectedCount } }),
  };
}

function validateMethod(value, code) {
  const errorCode = code || 'METHOD_INVALID';
  assertObject(value, errorCode, 'Method');
  assertKnownFields(
    value,
    ['id', 'displayName', 'objectPath', 'interface', 'methodName', 'inputs', 'output', 'tagGeneration'],
    errorCode,
    'Method',
  );
  if (!ID.test(value.id || '')) invalid(errorCode, 'Method ID는 소문자 kebab-case여야 합니다.');
  if (typeof value.displayName !== 'string' || !value.displayName.trim()) invalid(errorCode, 'Method 표시 이름이 필요합니다.');
  if (!OBJECT_PATH.test(value.objectPath || '')) invalid(errorCode, 'DBus objectPath 형식이 잘못되었습니다.');
  if (!INTERFACE.test(value.interface || '')) invalid(errorCode, 'DBus interface 형식이 잘못되었습니다.');
  if (!MEMBER.test(value.methodName || '')) invalid(errorCode, 'DBus methodName 형식이 잘못되었습니다.');
  if (!Array.isArray(value.inputs) || value.inputs.length > MAX_INPUTS_PER_METHOD) {
    invalid(errorCode, `Method inputs는 ${MAX_INPUTS_PER_METHOD}개 이하의 배열이어야 합니다.`);
  }
  const inputIds = new Set();
  const inputs = value.inputs.map((input) => {
    const valid = validateInput(input, errorCode);
    if (inputIds.has(valid.id)) invalid(errorCode, 'Method input ID가 중복되었습니다.', { id: valid.id });
    inputIds.add(valid.id);
    return valid;
  });
  const output = validateOutput(value.output, inputIds, errorCode);
  let tagGeneration;
  if (value.tagGeneration !== undefined) {
    assertObject(value.tagGeneration, errorCode, 'tagGeneration');
    assertKnownFields(
      value.tagGeneration,
      ['capability', 'countInputId', 'addressInputId'],
      errorCode,
      'tagGeneration',
    );
    if (!TAG_CAPABILITIES.has(value.tagGeneration.capability)) {
      invalid(errorCode, '지원하지 않는 tagGeneration capability입니다.');
    }
    const countInput = inputs.find((input) => input.id === value.tagGeneration.countInputId);
    const addressInput = inputs.find((input) => input.id === value.tagGeneration.addressInputId);
    if (!countInput || countInput.type !== 'uint16' || !addressInput || addressInput.type !== 'string') {
      invalid(errorCode, 'tagGeneration 입력 연결이 잘못되었습니다.');
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
    ...(tagGeneration === undefined ? {} : { tagGeneration }),
  };
}

function validateProfile(value) {
  assertObject(value, 'PROFILE_INVALID', 'Profile');
  validateProfileJsonSize(JSON.stringify(value));
  assertKnownFields(
    value,
    ['schemaVersion', 'id', 'profileVersion', 'displayName', 'vendor', 'builtIn', 'compatibility', 'defaults', 'methods'],
    'PROFILE_INVALID',
    'Profile',
  );
  if (value.schemaVersion !== 1) invalid('PROFILE_INVALID', 'Profile schemaVersion은 1이어야 합니다.');
  if (!ID.test(value.id || '') || value.id.length > MAX_PROFILE_ID_LENGTH) {
    invalid('PROFILE_INVALID', `Profile ID는 최대 ${MAX_PROFILE_ID_LENGTH}자의 소문자 kebab-case여야 합니다.`);
  }
  if (!Number.isInteger(value.profileVersion) || value.profileVersion < 1) invalid('PROFILE_INVALID', 'profileVersion은 1 이상의 정수여야 합니다.');
  if (typeof value.builtIn !== 'boolean') invalid('PROFILE_INVALID', 'Profile builtIn은 boolean이어야 합니다.');
  if (typeof value.displayName !== 'string' || !value.displayName.trim()) invalid('PROFILE_INVALID', 'Profile 표시 이름이 필요합니다.');
  if (typeof value.vendor !== 'string' || !value.vendor.trim()) invalid('PROFILE_INVALID', 'Profile vendor가 필요합니다.');
  assertObject(value.compatibility, 'PROFILE_INVALID', 'Profile compatibility');
  assertKnownFields(value.compatibility, ['minNeoVersion'], 'PROFILE_INVALID', 'Profile compatibility');
  try {
    parseSemVer(value.compatibility.minNeoVersion);
  } catch (_) {
    invalid('PROFILE_INVALID', '최소 Neo 버전은 엄격한 SemVer 형식이어야 합니다.');
  }
  assertObject(value.defaults, 'PROFILE_INVALID', 'Profile defaults');
  assertKnownFields(value.defaults, ['busType', 'destination'], 'PROFILE_INVALID', 'Profile defaults');
  if (!['system', 'session'].includes(value.defaults.busType) || !INTERFACE.test(value.defaults.destination || '')) {
    invalid('PROFILE_INVALID', 'Profile DBus 기본값이 잘못되었습니다.');
  }
  if (!Array.isArray(value.methods) || value.methods.length > MAX_METHODS_PER_PROFILE) {
    invalid('PROFILE_INVALID', `Profile methods는 ${MAX_METHODS_PER_PROFILE}개 이하의 배열이어야 합니다.`);
  }
  const methodIds = new Set();
  const methods = value.methods.map((method) => {
    const valid = validateMethod(method, 'PROFILE_INVALID');
    if (methodIds.has(valid.id)) invalid('PROFILE_INVALID', 'Method ID가 중복되었습니다.', { id: valid.id });
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
    methods,
  };
}

module.exports = {
  MAX_INPUTS_PER_METHOD,
  MAX_METHODS_PER_PROFILE,
  MAX_PROFILE_ID_LENGTH,
  MAX_PROFILE_JSON_BYTES,
  validateMethod,
  validateProfile,
  validateProfileJsonSize,
};
