'use strict';

const { error } = require('../config/errors.js');
const { normalizeType } = require('../dbus/types.js');

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBJECT_PATH = /^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/;
const DBUS_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const MEMBER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAMETER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 100;
const MAX_INTERFACES = 128;
const MAX_METHODS = 128;
const MAX_PARAMETERS = 64;
const MAX_XML_BYTES = 256 * 1024;

function fail(code, reason, details) { throw error(code, reason, details); }
function object(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${label}은(는) 객체여야 합니다.`);
}
function fields(value, allowed, code, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code, `${label}에 알 수 없는 필드가 있습니다.`);
}
function isIdentifier(value) {
  return typeof value === 'string' && value.length <= MAX_IDENTIFIER_LENGTH && ID.test(value);
}
function identifier(value, code, label) {
  if (!isIdentifier(value)) fail(code, `${label} 형식이 잘못되었습니다.`);
  return value;
}
function parameter(value, code) {
  object(value, code, 'parameter');
  fields(value, ['name', 'type', 'required', 'validation'], code, 'parameter');
  const type = normalizeType(value.type);
  if (typeof value.name !== 'string' || !PARAMETER.test(value.name) || type === null) {
    fail(code, 'parameter name 또는 type이 잘못되었습니다.');
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') fail(code, 'parameter required 값이 잘못되었습니다.');
  if (value.validation !== undefined) {
    object(value.validation, code, 'parameter validation');
    const validation = value.validation;
    if (Object.keys(validation).some((key) => !['minimum', 'maximum', 'pattern'].includes(key))
      || (validation.minimum !== undefined && typeof validation.minimum !== 'number')
      || (validation.maximum !== undefined && typeof validation.maximum !== 'number')
      || (validation.pattern !== undefined && typeof validation.pattern !== 'string')) fail(code, 'parameter validation 값이 잘못되었습니다.');
  }
  return {
    name: value.name,
    type,
    ...(value.required === undefined ? {} : { required: value.required }),
    ...(value.validation === undefined ? {} : { validation: { ...value.validation } }),
  };
}
function validateMethod(value) {
  const code = 'DBUS_METHOD_INVALID';
  object(value, code, 'Method');
  fields(value, ['id', 'source', 'member', 'inputs', 'outputs'], code, 'Method');
  identifier(value.id, code, 'Method ID');
  if (!['discovered', 'manual'].includes(value.source)) fail(code, 'Method source가 잘못되었습니다.');
  if (typeof value.member !== 'string' || !MEMBER.test(value.member)) fail(code, 'Method member가 잘못되었습니다.');
  if (!Array.isArray(value.inputs) || !Array.isArray(value.outputs) || value.inputs.length > MAX_PARAMETERS || value.outputs.length > MAX_PARAMETERS) fail(code, 'Method parameter 수가 잘못되었습니다.');
  const inputs = value.inputs.map((item) => parameter(item, code));
  const outputs = value.outputs.map((item) => parameter(item, code));
  const names = new Set();
  inputs.concat(outputs).forEach((item) => { if (names.has(item.name)) fail(code, 'Method parameter name이 중복되었습니다.'); names.add(item.name); });
  return { id: value.id, source: value.source, member: value.member, inputs, outputs };
}
function validateInterface(value, options) {
  const settings = options || {};
  const code = 'DBUS_INTERFACE_INVALID';
  object(value, code, 'DBus Interface');
  fields(value, ['schemaVersion', 'id', 'name', 'origin', 'builtIn', 'busType', 'destination', 'objectPath', 'interface', 'methods'], code, 'DBus Interface');
  if (value.id !== undefined || !settings.idOptional) identifier(value.id, code, 'Interface ID');
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : value.interface;
  if (value.schemaVersion !== 1 || !['discovered', 'manual'].includes(value.origin) || typeof value.builtIn !== 'boolean' || !['system', 'session'].includes(value.busType)
    || typeof value.destination !== 'string' || !DBUS_NAME.test(value.destination)
    || typeof value.objectPath !== 'string' || !OBJECT_PATH.test(value.objectPath)
    || typeof value.interface !== 'string' || !DBUS_NAME.test(value.interface)
    || !Array.isArray(value.methods) || value.methods.length > MAX_METHODS) fail(code, 'DBus Interface 값이 잘못되었습니다.');
  const methods = value.methods.map(validateMethod);
  const ids = new Set();
  methods.forEach((method) => {
    if (ids.has(method.id)) fail(code, 'Method ID가 중복되었습니다.');
    if (method.source !== value.origin && !(settings.allowLegacyMixedOrigin && value.origin === 'manual')) fail(code, 'DBus Interface origin과 Method source가 맞지 않습니다.');
    ids.add(method.id);
  });
  if (typeof name !== 'string' || name.length > MAX_IDENTIFIER_LENGTH) fail(code, 'DBus Interface 이름이 잘못되었습니다.');
  return { schemaVersion: 1, ...(value.id === undefined ? {} : { id: value.id }), name, origin: value.origin, builtIn: value.builtIn, busType: value.busType, destination: value.destination, objectPath: value.objectPath, interface: value.interface, methods };
}
function utf8ByteLength(value) {
  const text = String(value);
  let size = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { size += 4; index += 1; }
    else size += 3;
  }
  return size;
}
function validateXmlSize(xml) {
  if (utf8ByteLength(xml) > MAX_XML_BYTES) fail('INTROSPECTION_UNSUPPORTED', 'Introspection XML이 너무 큽니다.');
}
module.exports = { isIdentifier, validateInterface, validateMethod, validateXmlSize, MAX_IDENTIFIER_LENGTH, MAX_INTERFACES, MAX_METHODS, MAX_PARAMETERS };
