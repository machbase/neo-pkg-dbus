'use strict';

const { error } = require('../config/errors.js');
const { buildTypedArguments } = require('../dbus/arguments.js');
const { decodeOutput, decodeSelection } = require('../output/decoder.js');
const { transformValue } = require('../tag/transform.js');

const LAST_RUN_FIELDS = ['startedAt', 'completedAt', 'status', 'lastRunAt', 'lastSuccessfulRunAt', 'lastStoredAt', 'lastError'];
const METHOD_FIELDS = ['id', 'name', 'interfaceId', 'methodId', 'requestedAt', 'completedAt', 'status', 'storedCount', 'error'];
const NUMERIC_OUTPUT_TYPES = new Set(['byte', 'uint16', 'uint32', 'uint64', 'int16', 'int32', 'int64', 'double']);
const STRING_OUTPUT_TYPES = new Set(['string', 'object-path', 'signature']);

function pick(source, fields) { const result = {}; fields.forEach((field) => { if (source && Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field]; }); return result; }
function sanitizeLastRun(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const result = pick(value, LAST_RUN_FIELDS); if (Array.isArray(value.methodCalls)) result.methodCalls = value.methodCalls.map((method) => pick(method, METHOD_FIELDS)); return result; }
function iso(value) { return (value instanceof Date ? value : new Date(value)).toISOString(); }
function shortError(source) { const message = source && source.message ? source.message : String(source || 'unknown error'); return message.length > 500 ? `${message.slice(0, 497)}...` : message; }
function outputDefinition() { return { decoder: 'raw', shape: 'auto' }; }

function rowsFor(call, values, requestTime) {
  return call.tags.map((tag, index) => {
    const value = transformValue(values[index], tag);
    return { name: tag.name, requestTime, value, stringValue: typeof value === 'string' ? value : null };
  });
}

function selectionValueType(selection, outputType) {
  if (selection.valueType === 'array') return selection.elementType;
  if (selection.valueType) return selection.valueType;
  if (NUMERIC_OUTPUT_TYPES.has(outputType)) return 'numeric';
  if (STRING_OUTPUT_TYPES.has(outputType)) return 'string';
  return 'json';
}

function rowsForSelection(selection, values, requestTime, outputType) {
  const valueType = selectionValueType(selection, outputType);
  if (valueType === 'numeric') return rowsFor({ tags: selection.tags }, values, requestTime);
  return selection.tags.map((tag, index) => ({
    name: tag.name,
    requestTime,
    value: 0,
    stringValue: valueType === 'string' ? values[index] : JSON.stringify(values[index]),
  }));
}

function rowsForSelections(call, body, requestTime, method) {
  return call.outputSelections.flatMap((selection) => {
    const outputType = method.outputs[selection.sourceIndex]?.type;
    const values = decodeSelection(body, selection, outputType);
    const legacySelection = Object.prototype.hasOwnProperty.call(selection, 'path')
      || Object.prototype.hasOwnProperty.call(selection, 'mode');
    return legacySelection
      ? rowsFor({ tags: selection.tags }, values, requestTime)
      : rowsForSelection(selection, values, requestTime, outputType);
  });
}

function writableRows(job, rows) {
  if (String(job.database && job.database.stringValueColumn || '').trim()) return rows;
  return rows.filter((row) => row.stringValue === null || row.stringValue === undefined);
}

function requiredMethod(interfaceStore, interfaceId, methodId) {
  const dbusInterface = interfaceStore && interfaceStore.find(interfaceId);
  if (!dbusInterface) throw error('DBUS_INTERFACE_NOT_FOUND', 'Collector DBus Interface를 찾을 수 없습니다.', { interfaceId });
  const method = dbusInterface.methods.find((candidate) => candidate.id === methodId);
  if (!method) throw error('DBUS_METHOD_NOT_FOUND', 'Collector DBus Method를 찾을 수 없습니다.', { interfaceId, methodId });
  return { dbusInterface, method };
}

function runCycle(context) {
  const now = context.now || (() => new Date());
  const startedAt = iso(now());
  const previous = sanitizeLastRun(context.previous) || {};
  const methodResults = []; const buffered = []; const pendingCounts = [];
  let stored = 0; let cycleError = null;
  for (let index = 0; index < context.job.methodCalls.length; index += 1) {
    const call = context.job.methodCalls[index]; const requestedTime = now();
    const methodResult = { id: call.id, name: call.name, interfaceId: call.interfaceId, methodId: call.methodId, requestedAt: iso(requestedTime), completedAt: null, status: 'failed', storedCount: 0, error: null };
    methodResults.push(methodResult);
    try {
      const { dbusInterface, method } = requiredMethod(context.interfaceStore, call.interfaceId, call.methodId);
      const args = buildTypedArguments(method.inputs, call.inputs);
      let response;
      try {
        response = context.dbus.call({ busType: dbusInterface.busType, destination: dbusInterface.destination }, { objectPath: dbusInterface.objectPath, interface: dbusInterface.interface, methodName: method.member }, args);
      } catch (_) { throw error('DBUS_CALL_FAILED', 'DBus Method 호출에 실패했습니다.'); }
      if (!response || !Array.isArray(response.body)) throw error('DBUS_CALL_FAILED', 'DBus call body가 없습니다.');
      const rows = Array.isArray(call.outputSelections)
        ? rowsForSelections(call, response.body, requestedTime, method)
        : rowsFor(call, decodeOutput(response.body, outputDefinition(dbusInterface, method), call.inputs, call.tags.length).values, requestedTime);
      const rowsToStore = writableRows(context.job, rows);
      if (context.job.execution.savePolicy === 'afterAllMethods') {
        if (buffered.length + rowsToStore.length > context.limits.maxBufferedRowsPerCycle) throw error('DB_APPEND_FAILED', 'afterAllMethods buffer가 maxBufferedRowsPerCycle을 넘었습니다.');
        buffered.push(...rowsToStore); pendingCounts.push({ methodResult, count: rowsToStore.length }); methodResult.status = 'success';
      } else {
        if (rowsToStore.length) context.database.append(rowsToStore);
        stored += rowsToStore.length; methodResult.status = 'success'; methodResult.storedCount = rowsToStore.length;
      }
    } catch (methodError) { cycleError = methodError; methodResult.error = shortError(methodError); } finally { methodResult.completedAt = iso(now()); }
    if (cycleError) break;
  }
  if (!cycleError && context.job.execution.savePolicy === 'afterAllMethods') {
    try { if (buffered.length) context.database.append(buffered); stored = buffered.length; pendingCounts.forEach(({ methodResult, count }) => { methodResult.storedCount = count; }); }
    catch (appendError) { cycleError = appendError; pendingCounts.forEach(({ methodResult }) => { methodResult.status = 'failed'; methodResult.error = shortError(appendError); }); }
  }
  const completedAt = iso(now()); const status = cycleError ? (stored > 0 ? 'partial' : 'failed') : 'success';
  return sanitizeLastRun({ startedAt, completedAt, status, methodCalls: methodResults, lastRunAt: completedAt, lastSuccessfulRunAt: status === 'success' ? completedAt : (previous.lastSuccessfulRunAt || null), lastStoredAt: stored > 0 ? completedAt : (previous.lastStoredAt || null), lastError: cycleError ? shortError(cycleError) : null });
}

module.exports = { runCycle, sanitizeLastRun, requiredMethod };
