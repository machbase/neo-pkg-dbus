'use strict';

const { error } = require('./errors.js');

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function loggingPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !positiveInteger(value.maxFileBytes) || value.maxFileBytes < 64 * 1024 || value.maxFileBytes > 10 * 1024 * 1024
    || !positiveInteger(value.maxFiles) || value.maxFiles > 10
    || !positiveInteger(value.summaryIntervalMs) || value.summaryIntervalMs < 60 * 1000 || value.summaryIntervalMs > 24 * 60 * 60 * 1000) {
    throw error('SETTINGS_INVALID', 'logging 설정이 잘못되었습니다.');
  }
  return {
    maxFileBytes: value.maxFileBytes,
    maxFiles: value.maxFiles,
    summaryIntervalMs: value.summaryIntervalMs,
  };
}

function lsPolicy(value) {
  if (value === undefined) return null;
  const interval = value?.interval;
  const timer = value?.timer === undefined
    ? { showAbsoluteTimerOption: true, defaultUseAbsoluteTimer: false } : value.timer;
  const writer = value?.writer;
  const scheduler = value?.scheduler === undefined
    ? { mode: 'conditional', fifoPriority: 50, nice: -10, gomaxprocs: 0 } : value.scheduler;
  const performance = value?.performance;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !interval || typeof interval !== 'object' || Array.isArray(interval)
    || typeof interval.useTaskCycle !== 'boolean'
    || !timer || typeof timer !== 'object' || Array.isArray(timer)
    || typeof timer.showAbsoluteTimerOption !== 'boolean'
    || typeof timer.defaultUseAbsoluteTimer !== 'boolean'
    || !scheduler || typeof scheduler !== 'object' || Array.isArray(scheduler)
    || !['off', 'conditional', 'force'].includes(scheduler.mode)
    || !['fifoPriority', 'nice', 'gomaxprocs'].every((key) => Number.isSafeInteger(scheduler[key]))
    || !writer || typeof writer !== 'object' || Array.isArray(writer)
    || !positiveInteger(writer.queueCapacity) || writer.queueCapacity > 1024
    || !positiveInteger(writer.flushMaxRows) || writer.flushMaxRows > 65535
    || !positiveInteger(writer.flushIntervalMs) || writer.flushIntervalMs > 60 * 60 * 1000
    || !performance || typeof performance !== 'object' || Array.isArray(performance)
    || typeof performance.enabled !== 'boolean'
    || (performance.overrunDetailEnabled !== undefined && typeof performance.overrunDetailEnabled !== 'boolean')
    || !positiveInteger(performance.jobSampleCount)
    || !positiveInteger(performance.writerSummaryIntervalMs)) {
    throw error('SETTINGS_INVALID', 'LS interval 설정이 잘못되었습니다.');
  }
  return {
    interval: { useTaskCycle: interval.useTaskCycle },
    timer: { showAbsoluteTimerOption: timer.showAbsoluteTimerOption, defaultUseAbsoluteTimer: timer.defaultUseAbsoluteTimer },
    // FIFO 0..99 (0=OTHER), nice -20..19, GOMAXPROCS 0..64 (0=Go default).
    // Bounds are applied by Go at daemon restart so configured->applied
    // corrections remain visible. Modes/types are configuration errors.
    scheduler: { mode: scheduler.mode, fifoPriority: scheduler.fifoPriority, nice: scheduler.nice, gomaxprocs: scheduler.gomaxprocs },
    // Shared writer settings; users do not edit them in the frontend.
    writer: {
      queueCapacity: writer.queueCapacity,
      flushMaxRows: writer.flushMaxRows,
      flushIntervalMs: writer.flushIntervalMs,
    },
    // Go applies the operational floors and records a correction in the Job
    // log. Preserve the requested values here so that audit message can show
    // both the configured and applied values.
    performance: {
      enabled: performance.enabled,
      jobSampleCount: performance.jobSampleCount,
      writerSummaryIntervalMs: performance.writerSummaryIntervalMs,
      overrunDetailEnabled: performance.overrunDetailEnabled !== false,
    },
  };
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error('SETTINGS_INVALID', 'settings는 JSON 객체여야 합니다.');
  }
  if (value.schemaVersion !== 1) {
    throw error('SETTINGS_INVALID', 'settings schemaVersion은 1이어야 합니다.');
  }
  if (!value.limits || !positiveInteger(value.limits.maxGeneratedTagsPerCall)
    || !positiveInteger(value.limits.maxBufferedRowsPerCycle)) {
    throw error('SETTINGS_INVALID', 'limits 값은 0보다 큰 정수여야 합니다.');
  }
  const defaults = value.defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
    || !defaults.database || typeof defaults.database !== 'object' || Array.isArray(defaults.database)
    || typeof defaults.database.server !== 'string' || !defaults.database.server) {
    throw error('SETTINGS_INVALID', '기본 Database 설정이 잘못되었습니다.');
  }
  return {
    schemaVersion: 1,
    limits: {
      maxGeneratedTagsPerCall: value.limits.maxGeneratedTagsPerCall,
      maxBufferedRowsPerCycle: value.limits.maxBufferedRowsPerCycle,
    },
    defaults: {
      database: { server: defaults.database.server },
    },
    logging: loggingPolicy(value.logging),
    ...(lsPolicy(value.ls) ? { ls: lsPolicy(value.ls) } : {}),
  };
}

module.exports = { validateSettings };
