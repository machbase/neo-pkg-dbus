'use strict';

const { error } = require('../config/errors.js');

const MAX_JOB_JSON_BYTES = 512 * 1024;
const MAX_METHOD_CALLS = 128;
const MAX_JOB_NAME_LENGTH = 100;
const MAX_TAG_NAME_LENGTH = 100;
const JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const CALL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;
const DBUS_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const INTEGER_TYPES = new Set(['byte', 'uint8', 'uint16', 'uint32', 'uint64', 'int16', 'int32', 'int64']);
const WIDE_INTEGER_TYPES = new Set(['uint64', 'int64']);
const NUMBER_TYPES = new Set([...INTEGER_TYPES, 'float32', 'float64', 'double']);
const STRING_TYPES = new Set(['string', 'objectpath', 'path', 'signature']);
const INTEGER_RANGES = {
  byte: [0, 255],
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
};
const WIDE_INTEGER_RANGES = {
  uint64: [0n, 18446744073709551615n],
  int64: [-9223372036854775808n, 9223372036854775807n],
};
const SAVE_POLICIES = new Set(['perMethod', 'afterAllMethods']);
const METHOD_ERROR_POLICIES = new Set(['stop']);
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error']);

function invalid(reason, details) {
  throw error('JOB_INVALID', reason, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) invalid(`${label}은(는) JSON 객체여야 합니다.`);
}

function assertFields(value, fields, label) {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) invalid(`${label}에 알 수 없는 필드가 있습니다.`, { fields: unknown });
}

function utf8Bytes(value) {
  return unescape(encodeURIComponent(value)).length;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateJobName(name) {
  if (typeof name !== 'string' || name.length > MAX_JOB_NAME_LENGTH || !JOB_NAME.test(name) || /[\\/]/.test(name)) {
    invalid(`Job name은 최대 ${MAX_JOB_NAME_LENGTH}자의 영문 소문자, 숫자, _, -만 사용하고 처음과 끝은 영문 소문자 또는 숫자여야 합니다.`);
  }
  return name;
}

function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return clone(patch);
  const result = clone(base);
  Object.keys(patch).forEach((key) => {
    const next = patch[key];
    result[key] = isObject(next) && isObject(result[key])
      ? deepMerge(result[key], next)
      : clone(next);
  });
  return result;
}

function validateInputValue(input, value) {
  if (value === undefined || value === null) {
    if (input.required) invalid(`필수 input ${input.id} 값이 없습니다.`, { inputId: input.id });
    return;
  }
  function wideBound(source, label) {
    let result;
    try {
      if (typeof source === 'number' && Number.isSafeInteger(source)) result = BigInt(source);
      else if (typeof source === 'string' && /^-?(?:0|[1-9]\d*)$/.test(source)) result = BigInt(source);
      else invalid(`input ${input.id} ${label}의 ${input.type} 정수 형식이 잘못되었습니다.`, { inputId: input.id });
    } catch (_) {
      invalid(`input ${input.id} ${label}의 ${input.type} 정수 형식이 잘못되었습니다.`, { inputId: input.id });
    }
    const range = WIDE_INTEGER_RANGES[input.type];
    if (result < range[0] || result > range[1]) {
      invalid(`input ${input.id} ${label}이 ${input.type} 범위를 벗어났습니다.`, { inputId: input.id });
    }
    return result;
  }

  let wideInteger = null;
  if (WIDE_INTEGER_TYPES.has(input.type)) {
    wideInteger = wideBound(value, '값');
  } else if (NUMBER_TYPES.has(input.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (INTEGER_TYPES.has(input.type) && !Number.isInteger(value))) {
      invalid(`input ${input.id} 값의 type이 ${input.type}이 아닙니다.`, { inputId: input.id });
    }
    const range = INTEGER_RANGES[input.type];
    if (range && (value < range[0] || value > range[1])) {
      invalid(`input ${input.id} 값이 ${input.type} 범위를 벗어났습니다.`, { inputId: input.id });
    }
  } else if (input.type === 'bool') {
    if (typeof value !== 'boolean') invalid(`input ${input.id} 값은 boolean이어야 합니다.`, { inputId: input.id });
  } else if (STRING_TYPES.has(input.type)) {
    if (typeof value !== 'string') invalid(`input ${input.id} 값은 문자열이어야 합니다.`, { inputId: input.id });
  }
  const rules = input.validation || {};
  if (wideInteger !== null) {
    const minimum = rules.minimum === undefined ? null : wideBound(rules.minimum, 'minimum');
    const maximum = rules.maximum === undefined ? null : wideBound(rules.maximum, 'maximum');
    if (minimum !== null && maximum !== null && minimum > maximum) invalid(`input ${input.id} minimum은 maximum보다 클 수 없습니다.`, { inputId: input.id });
    if (minimum !== null && wideInteger < minimum) invalid(`input ${input.id} 값이 minimum보다 작습니다.`, { inputId: input.id });
    if (maximum !== null && wideInteger > maximum) invalid(`input ${input.id} 값이 maximum보다 큽니다.`, { inputId: input.id });
  } else {
    if (rules.minimum !== undefined && value < rules.minimum) invalid(`input ${input.id} 값이 minimum보다 작습니다.`, { inputId: input.id });
    if (rules.maximum !== undefined && value > rules.maximum) invalid(`input ${input.id} 값이 maximum보다 큽니다.`, { inputId: input.id });
  }
  if (rules.pattern !== undefined && !new RegExp(rules.pattern).test(value)) {
    invalid(`input ${input.id} 값이 pattern과 맞지 않습니다.`, { inputId: input.id });
  }
}

function validateTag(tag, expectedIndex, names) {
  assertObject(tag, 'Tag');
  assertFields(tag, ['outputIndex', 'sourceAddress', 'name', 'bias', 'multiplier', 'calcOrder'], 'Tag');
  if (tag.outputIndex !== expectedIndex) invalid('Tag outputIndex는 0부터 빠짐없이 이어져야 합니다.');
  if (typeof tag.sourceAddress !== 'string' || !tag.sourceAddress.trim()
    || typeof tag.name !== 'string' || !tag.name.trim()) {
    invalid('Tag sourceAddress와 name이 필요합니다.');
  }
  if (tag.name.length > MAX_TAG_NAME_LENGTH) invalid(`Tag name은 ${MAX_TAG_NAME_LENGTH}자 이하여야 합니다.`, { name: tag.name });
  if (names.has(tag.name)) invalid('Job 안에서 Tag name은 중복될 수 없습니다.', { name: tag.name });
  names.add(tag.name);
  if (typeof tag.bias !== 'number' || !Number.isFinite(tag.bias)
    || typeof tag.multiplier !== 'number' || !Number.isFinite(tag.multiplier)) {
    invalid('Tag bias와 multiplier는 유한한 숫자여야 합니다.');
  }
  if (!['bm', 'mb'].includes(tag.calcOrder)) invalid('Tag calcOrder는 bm 또는 mb여야 합니다.');
  return { ...tag };
}

function validateMethodCall(call, profile, options, callIds, callNames, tagNames) {
  assertObject(call, 'Method Call');
  assertFields(call, ['id', 'name', 'methodId', 'inputs', 'tags'], 'Method Call');
  if (!CALL_ID.test(call.id || '') || callIds.has(call.id)) invalid('Method Call ID는 유효하고 유일해야 합니다.', { id: call.id });
  callIds.add(call.id);
  if (typeof call.name !== 'string' || !call.name.trim() || callNames.has(call.name)) {
    invalid('Method Call name은 비어 있지 않고 유일해야 합니다.', { name: call.name });
  }
  callNames.add(call.name);
  const method = profile.methods.find((item) => item.id === call.methodId);
  if (!method) invalid('Profile에서 Method를 찾을 수 없습니다.', { methodId: call.methodId });
  assertObject(call.inputs, 'Method Call inputs');
  const allowedInputs = new Set(method.inputs.map((input) => input.id));
  const unknownInputs = Object.keys(call.inputs).filter((id) => !allowedInputs.has(id));
  if (unknownInputs.length) invalid('정의되지 않은 Method input이 있습니다.', { inputs: unknownInputs });
  method.inputs.forEach((input) => validateInputValue(input, call.inputs[input.id]));
  if (!Array.isArray(call.tags)) invalid('Method Call tags는 배열이어야 합니다.');
  if (call.tags.length > options.limits.maxGeneratedTagsPerCall) {
    invalid('Method Call Tag 개수가 maxGeneratedTagsPerCall을 넘었습니다.');
  }
  if (method.output.expectedCount && method.output.expectedCount.source === 'input') {
    const expected = call.inputs[method.output.expectedCount.inputId];
    if (call.tags.length !== expected) invalid('Tag 개수가 Method의 expected count와 다릅니다.');
  }
  return {
    id: call.id,
    name: call.name,
    methodId: call.methodId,
    inputs: clone(call.inputs),
    tags: call.tags.map((tag, index) => validateTag(tag, index, tagNames)),
  };
}

function validateJobConfig(value, options) {
  const settings = options || {};
  assertObject(value, 'Job config');
  if (Object.prototype.hasOwnProperty.call(value, 'name')) invalid('config에는 name을 넣을 수 없습니다.');
  if (utf8Bytes(JSON.stringify(value)) > MAX_JOB_JSON_BYTES) invalid(`Job JSON은 ${MAX_JOB_JSON_BYTES} bytes 이하여야 합니다.`);
  assertFields(value, [
    'schemaVersion', 'profileId', 'dbus', 'schedule', 'retry', 'execution',
    'methodCalls', 'database', 'log',
  ], 'Job config');
  if (value.schemaVersion !== 1) invalid('Job schemaVersion은 1이어야 합니다.');
  const profile = settings.profileStore && settings.profileStore.find(value.profileId);
  if (!profile) invalid('Job Profile을 찾을 수 없습니다.', { profileId: value.profileId });
  if (!settings.profileStore.isCompatible(profile)) invalid('현재 Neo에서 Job Profile을 사용할 수 없습니다.', { profileId: value.profileId });
  const limits = settings.limits || {};
  if (!Number.isInteger(limits.maxGeneratedTagsPerCall) || limits.maxGeneratedTagsPerCall < 1
    || !Number.isInteger(limits.maxBufferedRowsPerCycle) || limits.maxBufferedRowsPerCycle < 1) {
    invalid('Job validation limits가 잘못되었습니다.');
  }

  assertObject(value.dbus, 'dbus');
  assertFields(value.dbus, ['busType', 'destination'], 'dbus');
  if (!['system', 'session'].includes(value.dbus.busType) || !DBUS_NAME.test(value.dbus.destination || '')) invalid('DBus 설정이 잘못되었습니다.');
  assertObject(value.schedule, 'schedule');
  assertFields(value.schedule, ['intervalMs'], 'schedule');
  if (!Number.isInteger(value.schedule.intervalMs) || value.schedule.intervalMs < 1000 || value.schedule.intervalMs > 86400000) invalid('schedule.intervalMs는 1000~86400000 정수여야 합니다.');
  assertObject(value.retry, 'retry');
  assertFields(value.retry, ['initialDelayMs', 'maximumDelayMs', 'multiplier'], 'retry');
  if (!Number.isInteger(value.retry.initialDelayMs) || value.retry.initialDelayMs < 1
    || !Number.isInteger(value.retry.maximumDelayMs) || value.retry.maximumDelayMs < value.retry.initialDelayMs
    || value.retry.maximumDelayMs > 86400000 || typeof value.retry.multiplier !== 'number'
    || !Number.isFinite(value.retry.multiplier) || value.retry.multiplier < 1 || value.retry.multiplier > 100) {
    invalid('retry 설정 범위가 잘못되었습니다.');
  }
  assertObject(value.execution, 'execution');
  assertFields(value.execution, ['savePolicy', 'onMethodError'], 'execution');
  if (!SAVE_POLICIES.has(value.execution.savePolicy) || !METHOD_ERROR_POLICIES.has(value.execution.onMethodError)) invalid('execution policy가 잘못되었습니다.');
  if (!Array.isArray(value.methodCalls) || value.methodCalls.length < 1 || value.methodCalls.length > MAX_METHOD_CALLS) {
    invalid(`methodCalls는 1~${MAX_METHOD_CALLS}개여야 합니다.`);
  }
  const callIds = new Set();
  const callNames = new Set();
  const tagNames = new Set();
  const methodCalls = value.methodCalls.map((call) => validateMethodCall(
    call, profile, { limits }, callIds, callNames, tagNames,
  ));
  const rowCount = methodCalls.reduce((sum, call) => sum + call.tags.length, 0);
  if (rowCount > limits.maxBufferedRowsPerCycle) invalid('Job Tag 전체 개수가 maxBufferedRowsPerCycle을 넘었습니다.');

  assertObject(value.database, 'database');
  assertFields(value.database, ['server', 'table', 'valueColumn', 'stringValueColumn'], 'database');
  if (!SAFE_NAME.test(value.database.server || '') || !SQL_IDENTIFIER.test(value.database.table || '')
    || !SQL_IDENTIFIER.test(value.database.valueColumn || '')
    || (value.database.stringValueColumn !== ''
      && !SQL_IDENTIFIER.test(value.database.stringValueColumn || ''))) invalid('database 이름 또는 column 형식이 잘못되었습니다.');
  assertObject(value.log, 'log');
  assertFields(value.log, ['level', 'maxFiles'], 'log');
  if (!LOG_LEVELS.has(value.log.level) || !Number.isInteger(value.log.maxFiles)
    || value.log.maxFiles < 1 || value.log.maxFiles > 1000) invalid('log 설정이 잘못되었습니다.');

  return clone(value);
}

module.exports = {
  JOB_NAME,
  MAX_JOB_JSON_BYTES,
  MAX_JOB_NAME_LENGTH,
  MAX_METHOD_CALLS,
  MAX_TAG_NAME_LENGTH,
  deepMerge,
  validateJobConfig,
  validateJobName,
};
