'use strict';

function jobDefaults() {
  return {
    schemaVersion: 1,
    schedule: { intervalMs: 1000 },
    retry: { initialDelayMs: 5000, maximumDelayMs: 30000, multiplier: 2 },
    execution: { savePolicy: 'perMethod', onMethodError: 'stop' },
    methodCalls: [],
    database: { server: '', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' },
    // maxFiles is retained in Job documents for backward compatibility.
    // Actual PLC rotation is the global settings.logging policy.
    log: { level: 'info', maxFiles: 3 },
  };
}

module.exports = { jobDefaults };
