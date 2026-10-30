'use strict';

const { error } = require('../config/errors.js');

const DEFAULT_DBUS_DESTINATION = 'ls.plc';
const DEFAULT_DBUS_INTERFACE_PREFIX = DEFAULT_DBUS_DESTINATION;
const MAX_DBUS_DESTINATION_LENGTH = 255;
// Well-known bus names may contain hyphens. Unique connection names begin
// with ':' and may also start a component with a digit.
const WELL_KNOWN_DBUS_DESTINATION = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/;
const UNIQUE_DBUS_DESTINATION = /^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
// The suffix ".program" is eight bytes, and a complete DBus interface name
// cannot exceed 255 bytes.  A prefix may contain one or more name components.
const MAX_DBUS_INTERFACE_PREFIX_LENGTH = 247;
const DBUS_INTERFACE_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function resolveJobDestination(value, code = 'JOB_INVALID') {
  if (value === undefined) return DEFAULT_DBUS_DESTINATION;
  if (typeof value !== 'string' || value.length > MAX_DBUS_DESTINATION_LENGTH
    || !(WELL_KNOWN_DBUS_DESTINATION.test(value) || UNIQUE_DBUS_DESTINATION.test(value))) {
    throw error(code, 'LS DBus Service Name은 유효한 DBus bus name이어야 합니다.');
  }
  return value;
}

function resolveJobInterfacePrefix(value, code = 'JOB_INVALID') {
  if (value === undefined) return DEFAULT_DBUS_INTERFACE_PREFIX;
  if (typeof value !== 'string' || value.length > MAX_DBUS_INTERFACE_PREFIX_LENGTH || !DBUS_INTERFACE_PREFIX.test(value)) {
    throw error(code, 'LS DBus Interface prefix는 영문자·숫자·밑줄과 점으로 구성된 유효한 DBus 이름이어야 합니다.');
  }
  return value;
}

function interfaceForPrefix(value, component, code = 'JOB_INVALID') {
  return `${resolveJobInterfacePrefix(value, code)}.${component}`;
}

module.exports = {
  DEFAULT_DBUS_DESTINATION, MAX_DBUS_DESTINATION_LENGTH, resolveJobDestination,
  DEFAULT_DBUS_INTERFACE_PREFIX, MAX_DBUS_INTERFACE_PREFIX_LENGTH, resolveJobInterfacePrefix, interfaceForPrefix,
};
