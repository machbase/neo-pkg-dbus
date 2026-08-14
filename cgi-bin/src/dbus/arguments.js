'use strict';

const { error } = require('../config/errors.js');
const { neoArgument, normalizeType, typeName, validSignature } = require('./types.js');

function inputId(input) { return input && (input.id || input.name); }
function invalid(input, reason) { throw error('DBUS_ARGUMENT_INVALID', reason, { inputId: inputId(input), type: input && input.type }); }

function typedValue(input, value) {
  if (!input || typeof inputId(input) !== 'string' || normalizeType(input.type) === null) invalid(input, 'DBus input 정의가 잘못되었습니다.');
  const pattern = input.validation && input.validation.pattern;
  if (pattern !== undefined) {
    let matches = false;
    try { matches = typeof value === 'string' && new RegExp(pattern).test(value); } catch (_) { invalid(input, 'DBus input pattern 정의가 잘못되었습니다.'); }
    if (!matches) invalid(input, `input ${inputId(input)} 값이 pattern과 맞지 않습니다.`);
  }
  const encoded = neoArgument(input.type, value);
  if (encoded === null) invalid(input, `input ${inputId(input)} 값이 ${typeName(input.type)} 형식이 아닙니다.`);
  if (encoded.unsupported) throw error('DBUS_ARGUMENT_UNSUPPORTED', '현재 Neo DBus 모듈은 이 DBus type 호출을 지원하지 않습니다.', { inputId: inputId(input), type: encoded.unsupported });
  return encoded.value;
}

function buildTypedArguments(inputs, values) {
  if (!Array.isArray(inputs) || !values || typeof values !== 'object' || Array.isArray(values)) invalid(null, 'DBus inputs와 values 형식이 잘못되었습니다.');
  return inputs.map((input) => {
    const id = inputId(input);
    if (!Object.prototype.hasOwnProperty.call(values, id) || values[id] === null || values[id] === undefined) invalid(input, `input ${id} 값이 없습니다.`);
    return typedValue(input, values[id]);
  });
}

module.exports = { buildTypedArguments, typedValue, validSignature };
