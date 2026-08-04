'use strict';

const path = require('path');
const process = require('process');
const { loadSettings } = require('../config/settings-loader.js');
const { createMachbaseAppender } = require('../db/appender.js');
const { createDbusAdapter } = require('../dbus/adapter.js');
const { validateJobConfig } = require('../jobs/validator.js');
const { ProfileStore } = require('../profiles/store.js');
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

function setupFailure(profile, previous, now) {
  const completedAt = now().toISOString();
  return sanitizeLastRun({
    startedAt: completedAt,
    completedAt,
    status: 'failed',
    profileId: profile.id,
    profileVersion: profile.profileVersion,
    methodCalls: [],
    lastRunAt: completedAt,
    lastSuccessfulRunAt: previous && previous.lastSuccessfulRunAt || null,
    lastStoredAt: previous && previous.lastStoredAt || null,
    lastError: 'Machbase append stream을 열 수 없습니다.',
  });
}

function startCollector(document, context) {
  const settings = context || {};
  const cgiRoot = settings.cgiRoot || path.resolve(__dirname, '..', '..');
  const jobName = settings.jobName || document.name;
  if (!document || document.name !== jobName) throw new Error('Collector Job name과 document name이 다릅니다.');
  const profileStore = settings.profileStore || new ProfileStore({ cgiRoot });
  const runtimeSettings = settings.settings || loadSettings(path.join(cgiRoot, 'conf.d', 'settings.json'));
  const profile = profileStore.find(document.profileId);
  if (!profile || !profileStore.isCompatible(profile)) throw new Error('Collector Profile을 사용할 수 없습니다.');
  const validate = settings.validateConfig || ((config) => validateJobConfig(config, {
    profileStore, limits: runtimeSettings.limits,
  }));
  const job = { name: jobName, ...validate(stripName(document)) };
  const loggerFactory = settings.loggerFactory || initLogger;
  let logger = null;
  try { logger = loggerFactory(job.log, { name: jobName, cgiRoot }); } catch (_) {}
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
    msg: 'collector started', job: jobName, profileId: profile.id, intervalMs: job.schedule.intervalMs,
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
          const result = setupFailure(profile, previous, now);
          previous = result;
          return result;
        }
      }
      const result = runCycle({
        job, profile, limits: runtimeSettings.limits, dbus, database: cycleDatabase, previous, now,
      });
      previous = result;
      return result;
    },
    onResult(result) {
      details.setLastRun(result, () => {});
      const methodCalls = result && Array.isArray(result.methodCalls) ? result.methodCalls : [];
      const storedCount = methodCalls.reduce((sum, method) => sum + (Number(method && method.storedCount) || 0), 0);
      const status = result && result.status || 'failed';
      log(status === 'success' ? 'info' : 'warn', 'cycle', {
        msg: `cycle ${status}`,
        status,
        methodCallCount: methodCalls.length,
        storedCount,
        errorCode: status === 'success' ? null : 'CYCLE_FAILED',
      });
    },
    onSchedule(schedule) {
      if (schedule && schedule.consecutiveFailures > 0) {
        log('warn', 'scheduler', {
          msg: 'retry scheduled',
          delayMs: schedule.delayMs,
          consecutiveFailures: schedule.consecutiveFailures,
        });
      }
    },
  });
  scheduler.start();
  return { stop: shutdown };
}

module.exports = { startCollector };
