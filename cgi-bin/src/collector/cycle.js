'use strict';

const { error } = require('../config/errors.js');
const { buildTypedArguments } = require('../dbus/arguments.js');
const { decodeOutput } = require('../output/decoder.js');
const { transformValue } = require('../tag/transform.js');

const LAST_RUN_FIELDS = [
  'startedAt', 'completedAt', 'status', 'profileId', 'profileVersion',
  'lastRunAt', 'lastSuccessfulRunAt', 'lastStoredAt', 'lastError',
];
const METHOD_FIELDS = ['id', 'name', 'requestedAt', 'completedAt', 'status', 'storedCount', 'error'];

function pick(source, fields) {
  const result = {};
  fields.forEach((field) => {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) result[field] = source[field];
  });
  return result;
}

function sanitizeLastRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = pick(value, LAST_RUN_FIELDS);
  if (Array.isArray(value.methodCalls)) result.methodCalls = value.methodCalls.map((method) => pick(method, METHOD_FIELDS));
  return result;
}

function iso(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function shortError(source) {
  const message = source && source.message ? source.message : String(source || 'unknown error');
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function rowsFor(call, values, requestTime) {
  return call.tags.map((tag, index) => {
    const value = transformValue(values[index], tag);
    return {
      name: tag.name,
      sourceAddress: tag.sourceAddress,
      requestTime,
      value,
      stringValue: typeof value === 'string' ? value : null,
    };
  });
}

function requiredMethod(profile, id) {
  const method = profile.methods.find((candidate) => candidate.id === id);
  if (!method) throw error('METHOD_NOT_FOUND', 'Collector Profile에서 Method를 찾을 수 없습니다.', { id });
  return method;
}

function runCycle(context) {
  const now = context.now || (() => new Date());
  const startedAt = iso(now());
  const previous = sanitizeLastRun(context.previous) || {};
  const methodResults = [];
  const buffered = [];
  const pendingCounts = [];
  let stored = 0;
  let cycleError = null;

  for (let index = 0; index < context.job.methodCalls.length; index += 1) {
    const call = context.job.methodCalls[index];
    const requestedTime = now();
    const methodResult = {
      id: call.id,
      name: call.name,
      requestedAt: iso(requestedTime),
      completedAt: null,
      status: 'failed',
      storedCount: 0,
      error: null,
    };
    methodResults.push(methodResult);
    try {
      const method = requiredMethod(context.profile, call.methodId);
      const args = buildTypedArguments(method.inputs, call.inputs);
      let response;
      try {
        response = context.dbus.call(context.job.dbus, method, args);
      } catch (_) {
        throw error('DBUS_CALL_FAILED', 'DBus Method 호출에 실패했습니다.');
      }
      if (!response || !Array.isArray(response.body)) throw error('DBUS_CALL_FAILED', 'DBus call body가 없습니다.');
      const decoded = decodeOutput(response.body, method.output, call.inputs, call.tags.length);
      const rows = rowsFor(call, decoded.values, requestedTime);
      if (context.job.execution.savePolicy === 'afterAllMethods') {
        if (buffered.length + rows.length > context.limits.maxBufferedRowsPerCycle) {
          throw error('DB_APPEND_FAILED', 'afterAllMethods buffer가 maxBufferedRowsPerCycle을 넘었습니다.');
        }
        buffered.push(...rows);
        pendingCounts.push({ methodResult, count: rows.length });
        methodResult.status = 'success';
      } else {
        context.database.append(rows);
        stored += rows.length;
        methodResult.status = 'success';
        methodResult.storedCount = rows.length;
      }
    } catch (methodError) {
      cycleError = methodError;
      methodResult.error = shortError(methodError);
    } finally {
      methodResult.completedAt = iso(now());
    }
    if (cycleError) break;
  }

  if (!cycleError && context.job.execution.savePolicy === 'afterAllMethods') {
    try {
      context.database.append(buffered);
      stored = buffered.length;
      pendingCounts.forEach(({ methodResult, count }) => { methodResult.storedCount = count; });
    } catch (appendError) {
      cycleError = appendError;
      pendingCounts.forEach(({ methodResult }) => {
        methodResult.status = 'failed';
        methodResult.error = shortError(appendError);
      });
    }
  }

  const completedAt = iso(now());
  const status = cycleError ? (stored > 0 ? 'partial' : 'failed') : 'success';
  const result = {
    startedAt,
    completedAt,
    status,
    profileId: context.profile.id,
    profileVersion: context.profile.profileVersion,
    methodCalls: methodResults,
    lastRunAt: completedAt,
    lastSuccessfulRunAt: status === 'success' ? completedAt : (previous.lastSuccessfulRunAt || null),
    lastStoredAt: stored > 0 ? completedAt : (previous.lastStoredAt || null),
    lastError: cycleError ? shortError(cycleError) : null,
  };
  return sanitizeLastRun(result);
}

module.exports = { runCycle, sanitizeLastRun };
