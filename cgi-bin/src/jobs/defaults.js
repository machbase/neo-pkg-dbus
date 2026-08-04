'use strict';

function jobDefaults(profileId, profile) {
  const defaults = (profile && profile.defaults) || {};
  return {
    schemaVersion: 1,
    profileId,
    dbus: {
      busType: defaults.busType || 'system',
      destination: defaults.destination || '',
    },
    schedule: { intervalMs: 1000 },
    retry: { initialDelayMs: 5000, maximumDelayMs: 30000, multiplier: 2 },
    execution: { savePolicy: 'perMethod', onMethodError: 'stop' },
    methodCalls: [],
    database: { server: '', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' },
    log: { level: 'info', maxFiles: 10 },
  };
}

module.exports = { jobDefaults };
