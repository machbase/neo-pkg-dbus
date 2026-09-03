'use strict';

const { createDbusAdapter } = require('../dbus/adapter.js');

const TASK_NUMBER = 0;

function fallback(source) { return { cycleMs: 1, source }; }

function resolveIntervalPolicy(options) {
  const settings = options?.settings || {};
  const policy = options?.productPolicy || {};
  if (policy.target !== 'ls') return fallback('not-ls');
  // The setting was introduced after existing LS configurations.  Missing
  // means the package default (enabled); only an explicit false disables it.
  if (settings.ls?.interval?.useTaskCycle === false) return fallback('disabled');

  let dbus;
  try {
    dbus = (options?.dbusFactory || (() => createDbusAdapter()))();
    const response = dbus.call(
      { busType: 'system', destination: 'ls.plc' },
      { objectPath: '/ls/plc/program', interface: 'ls.plc.program', methodName: 'GetTaskCycleInfo' },
      [`uint16:${TASK_NUMBER}`],
    );
    const body = response?.body;
    const value = Array.isArray(body) && typeof body[0] === 'string' ? JSON.parse(body[0]) : null;
    const cycleMs = value && value.rtn === 1 ? Number(value['period-ms']) : NaN;
    if (!Number.isInteger(cycleMs) || cycleMs < 1 || cycleMs > 86400000) return fallback('invalid-response');
    return { cycleMs, source: 'plc' };
  } catch (_) {
    return fallback('unavailable');
  } finally {
    if (dbus) dbus.close();
  }
}

function defaultIntervalMs(cycleMs) {
  const cycle = Number.isInteger(cycleMs) && cycleMs > 0 ? cycleMs : 1;
  return Math.ceil(10 / cycle) * cycle;
}

module.exports = { TASK_NUMBER, resolveIntervalPolicy, defaultIntervalMs };
