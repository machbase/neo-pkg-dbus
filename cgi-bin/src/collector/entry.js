'use strict';

const path = require('path');
const process = require('process');
const { loadSettings } = require('../config/settings-loader.js');
const { createMachbaseAppender } = require('../db/appender.js');
const { createDbusAdapter } = require('../dbus/adapter.js');
const { validateJobConfig } = require('../jobs/validator.js');
const { InterfaceStore } = require('../interfaces/store.js');
const { createServiceDetailsAdapter } = require('../service/details-adapter.js');
const { serviceName } = require('../jobs/manager.js');
const { init: initLogger } = require('../log/logger.js');
const { runCycle, sanitizeLastRun } = require('./cycle.js');
const { createScheduler } = require('./scheduler.js');

function stripName(document) {
  const value = { ...document };
  delete value.name;
  delete value.revision;
  return value;
}

function setupFailure(previous, now) {
  const completedAt = now().toISOString();
  return sanitizeLastRun({
    startedAt: completedAt,
    completedAt,
    status: 'failed',
    methodCalls: [],
    lastRunAt: completedAt,
    lastSuccessfulRunAt: previous && previous.lastSuccessfulRunAt || null,
    lastStoredAt: previous && previous.lastStoredAt || null,
    lastError: 'Machbase append stream을 열 수 없습니다.',
  });
}

function createLogSummary(log, intervalMs, now) {
  const interval = Number.isInteger(intervalMs) && intervalMs >= 60000 ? intervalMs : 60 * 60 * 1000;
  let startedAt = now().getTime();
  let cycles = 0;
  let succeeded = 0;
  let failed = 0;
  let stored = 0;
  let retries = 0;
  let lastError = null;

  function flush(force) {
    const current = now().getTime();
    if (!force && current - startedAt < interval) return;
    if (!cycles && !retries) { startedAt = current; return; }
    const fields = {
      msg: 'cycle summary', durationMs: Math.max(0, current - startedAt), cycles, succeeded, failed, stored, retries,
      ...(lastError ? { lastError } : {}),
    };
    if (failed > 1 || retries > 1) log('warn', 'collector', fields);
    log('debug', 'collector', fields);
    startedAt = current;
    cycles = 0;
    succeeded = 0;
    failed = 0;
    stored = 0;
    retries = 0;
    lastError = null;
  }

  return {
    result(result) {
      const methodCalls = result && Array.isArray(result.methodCalls) ? result.methodCalls : [];
      const status = result && result.status || 'failed';
      cycles += 1;
      stored += methodCalls.reduce((sum, method) => sum + (Number(method && method.storedCount) || 0), 0);
      if (status === 'success') succeeded += 1;
      else {
        failed += 1;
        lastError = result && result.lastError || 'cycle failed';
        if (failed === 1) log('error', 'collector', { msg: 'cycle failed', status, lastError });
      }
      flush(false);
    },
    retry() { retries += 1; },
    flush,
  };
}

function startCollector(document, context) {
  const settings = context || {};
  const cgiRoot = settings.cgiRoot || path.resolve(__dirname, '..', '..');
  const jobName = settings.jobName || document.name;
  if (!document || document.name !== jobName) throw new Error('Collector Job name과 document name이 다릅니다.');
  const interfaceStore = settings.interfaceStore || new InterfaceStore({ cgiRoot });
  const runtimeSettings = settings.settings || loadSettings(path.join(cgiRoot, 'conf.d', 'settings.json'));
  const validate = settings.validateConfig || ((config) => validateJobConfig(config, {
    interfaceStore, limits: runtimeSettings.limits,
  }));
  const job = { name: jobName, ...validate(stripName(document)) };
  const loggerFactory = settings.loggerFactory || initLogger;
  let logger = null;
  try { logger = loggerFactory(job.log, { name: jobName, cgiRoot, ...runtimeSettings.logging }); } catch (_) {}
  const log = (level, stage, fields) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](stage, fields);
    } catch (_) {}
  };
  const database = settings.database || createMachbaseAppender({ cgiRoot });
  const dbus = settings.dbus || createDbusAdapter();
  const details = settings.details || createServiceDetailsAdapter(undefined, serviceName(jobName));
  const schedulerFactory = settings.schedulerFactory || createScheduler;
  const processApi = settings.process || process;
  const now = settings.now || (() => new Date());
  let previous = null;
  let stopped = false;
  let scheduler = null;
  let databaseReady = false;
  const summary = createLogSummary(log, runtimeSettings.logging && runtimeSettings.logging.summaryIntervalMs, now);

  const cycleDatabase = {
    append(rows) {
      try { database.append(rows); } catch (_) {
        databaseReady = false;
        database.close();
        const appendError = new Error('Machbase TAG append에 실패했습니다.');
        appendError.code = 'DB_APPEND_FAILED';
        throw appendError;
      }
    },
  };

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    if (scheduler) scheduler.stop();
    dbus.close();
    database.close();
    summary.flush(true);
    log('info', 'collector', { msg: 'collector stopped', job: jobName });
    try { if (logger && typeof logger.close === 'function') logger.close(); } catch (_) {}
    if (processApi && typeof processApi.removeListener === 'function') {
      processApi.removeListener('SIGINT', shutdown);
      processApi.removeListener('SIGTERM', shutdown);
    }
  };

  if (processApi && typeof processApi.on === 'function') {
    processApi.on('SIGINT', shutdown);
    processApi.on('SIGTERM', shutdown);
  }
  log('info', 'collector', {
    msg: 'collector started', job: jobName, intervalMs: job.schedule.intervalMs,
  });
  scheduler = schedulerFactory({
    intervalMs: job.schedule.intervalMs,
    retry: job.retry,
    run() {
      if (!databaseReady) {
        try {
          database.open(job.database);
          databaseReady = true;
        } catch (_) {
          databaseReady = false;
          database.close();
          log('error', 'database', { msg: 'database open failed', code: 'DB_UNAVAILABLE' });
          const result = setupFailure(previous, now);
          previous = result;
          return result;
        }
      }
      const result = runCycle({
        job, interfaceStore, limits: runtimeSettings.limits, dbus, database: cycleDatabase, previous, now,
      });
      previous = result;
      return result;
    },
    onResult(result) {
      details.setLastRun(result, () => {});
      summary.result(result);
    },
    onSchedule(schedule) {
      if (schedule && schedule.consecutiveFailures > 0) {
        summary.retry();
      }
    },
  });
  scheduler.start();
  return { stop: shutdown };
}

module.exports = { startCollector };
