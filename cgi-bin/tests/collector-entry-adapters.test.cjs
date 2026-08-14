'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jobConfig } = require('./job-fixture.cjs');
const { startCollector } = require('../src/collector/entry.js');
const { createScheduler } = require('../src/collector/scheduler.js');
const { createMachbaseAppender } = require('../src/db/appender.js');
const { createDatabaseValidationAdapter } = require('../src/db/validation-adapter.js');
const { Logger } = require('../src/log/logger.js');
const { createLogReader } = require('../src/log/reader.js');

function outputSelectionJobConfig() {
  const config = jobConfig();
  const call = config.methodCalls[0];
  const tags = call.tags;
  delete call.tags;
  call.outputSelections = [{ id: 'output-1', sourceIndex: 0, path: '', mode: 'each', tags }];
  return config;
}

function interfaceStore() {
  return { find(id) {
    if (id !== 'device-status') return null;
    return {
      id, busType: 'system', destination: 'ls.plc', objectPath: '/ls/plc/device', interface: 'ls.plc.device',
      methods: [{ id: 'get-device-data', member: 'GetDeviceData', inputs: [{ name: 'dataCount', type: 'uint16' }, { name: 'memoryAddress', type: 'string' }], outputs: [] }],
    };
  } };
}

function testMachbaseAppender() {
  const appended = [];
  let flushed = 0;
  let appenderClosed = 0;
  let connectionClosed = 0;
  let clientClosed = 0;
  const appender = {
    append(...values) { appended.push(values); },
    flush() { flushed += 1; },
    close() { appenderClosed += 1; },
  };
  const connection = {
    query() {
      return [
        { NAME: 'NAME', FLAG: 0x8000000 },
        { NAME: 'TIME', FLAG: 0x1000000 },
        { NAME: 'VALUE', FLAG: 0 },
        { NAME: 'STR_VALUE', FLAG: 0 },
      ];
    },
    append(table) { assert.equal(table, 'TAG'); return appender; },
    close() { connectionClosed += 1; },
  };
  const database = createMachbaseAppender({
    serverStore: { get(name, callback) { assert.equal(name, 'local-db'); callback(null, {
      schemaVersion: 1, name, host: 'localhost', port: 5656, user: 'sys', password: 'secret',
    }); } },
    clientFactory(config) {
      assert.deepEqual(config, { host: 'localhost', port: 5656, user: 'sys', password: 'secret' });
      return { connect() { return connection; }, close() { clientClosed += 1; } };
    },
  });
  database.open({ server: 'local-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' });
  const requestTime = new Date('2026-08-03T00:00:00.000Z');
  database.append([
    { name: 'NUM', requestTime, value: 1.5, stringValue: null },
    { name: 'TEXT', requestTime, value: 'READY', stringValue: 'READY' },
  ]);
  assert.deepEqual(appended, [
    ['NUM', requestTime, 1.5, null],
    ['TEXT', requestTime, 0, 'READY'],
  ]);
  assert.equal(flushed, 1);
  database.close();
  assert.deepEqual([appenderClosed, connectionClosed, clientClosed], [1, 1, 1]);
}

function testMachbaseAppenderWithoutStringColumn() {
  const appended = [];
  const requestTime = new Date('2026-08-03T00:00:00.000Z');
  const database = createMachbaseAppender({
    serverStore: { get(_name, callback) { callback(null, {
      host: 'localhost', port: 5656, user: 'sys', password: 'secret',
    }); } },
    clientFactory() {
      return {
        connect() {
          return {
            query() { return [
              { NAME: 'NAME', FLAG: 0x8000000 },
              { NAME: 'TIME', FLAG: 0x1000000 },
              { NAME: 'VALUE', FLAG: 0 },
              { NAME: 'STR_VALUE', FLAG: 0 },
            ]; },
            append() { return { append(...values) { appended.push(values); }, flush() {}, close() {} }; },
            close() {},
          };
        },
        close() {},
      };
    },
  });
  database.open({ server: 'local-db', table: 'TAG', valueColumn: 'VALUE', stringValueColumn: '' });
  const stored = database.append([
    { name: 'NUM', requestTime, value: 1.5, stringValue: null },
    { name: 'TEXT', requestTime, value: 'READY', stringValue: 'READY' },
  ]);
  assert.equal(stored, 1);
  assert.deepEqual(appended, [['NUM', requestTime, 1.5, null]]);
  assert.equal(database.append([
    { name: 'TEXT_ONLY', requestTime, value: 0, stringValue: 'READY' },
  ]), 0);
  assert.deepEqual(appended, [['NUM', requestTime, 1.5, null]]);
  database.close();
}

function testAppenderUsesCanonicalColumnNamesCaseInsensitively() {
  const appended = [];
  const mapping = { server: 'local-db', table: 'TAG', valueColumn: 'value', stringValueColumn: 'str_value' };
  const validation = createDatabaseValidationAdapter({
    serverStore: { get(_name, callback) { callback(null, { name: 'local-db' }); } },
    metadataReader: { columns(_server, table, callback) { callback(null, { table, tableType: 'TAG', columns: [
      { name: 'NAME', type: 'varchar', primaryKey: true },
      { name: 'TIME', type: 'datetime', basetime: true },
      { name: 'VALUE', type: 'double' },
      { name: 'STR_VALUE', type: 'varchar' },
    ] }); } },
  });
  let validationError;
  let canonical;
  validation.validate(mapping, (error, value) => { validationError = error; canonical = value; });
  assert.equal(validationError, null);
  assert.equal(canonical.valueColumn, 'VALUE');
  assert.equal(canonical.stringValueColumn, 'STR_VALUE');
  const database = createMachbaseAppender({
    serverStore: { get(_name, callback) { callback(null, {
      host: 'localhost', port: 5656, user: 'sys', password: 'manager',
    }); } },
    clientFactory() {
      return {
        connect() {
          return {
            query() { return [
              { NAME: 'NAME', FLAG: 0x8000000 }, { NAME: 'TIME', FLAG: 0x1000000 },
              { NAME: 'VALUE', FLAG: 0 }, { NAME: 'STR_VALUE', FLAG: 0 },
            ]; },
            append() { return { append(...row) { appended.push(row); }, flush() {}, close() {} }; },
            close() {},
          };
        },
        close() {},
      };
    },
  });
  database.open(mapping);
  database.append([{ name: 'A', requestTime: new Date(0), value: 3, stringValue: null }]);
  assert.equal(appended[0][2], 3);
  assert.equal(appended[0][3], null);
  database.close();
}

function testEntryStartupAndShutdown() {
  const events = [];
  const listeners = {};
  const processApi = {
    on(signal, listener) { listeners[signal] = listener; events.push(`on:${signal}`); },
    removeListener(signal, listener) {
      assert.equal(listeners[signal], listener);
      delete listeners[signal];
      events.push(`off:${signal}`);
    },
  };
  const database = {
    open(mapping) { events.push(`db:open:${mapping.table}`); },
    append() {},
    close() { events.push('db:close'); },
  };
  const dbus = {
    call(config) { events.push(`dbus:call:${config.busType}`); return { body: ['{"rtn":1,"data-count":2,"data":[1,2]}'] }; },
    close() { events.push('dbus:close'); },
  };
  const details = { setLastRun(_value, callback) { events.push('details:set'); callback(null); } };
  let scheduledOptions;
  const runtime = startCollector({ name: 'alpha', ...jobConfig() }, {
    cgiRoot: '/tmp/cgi-bin',
    jobName: 'alpha',
    interfaceStore: interfaceStore(),
    settings: { limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } },
    validateConfig(config) { return config; },
    database,
    dbus,
    details,
    process: processApi,
    schedulerFactory(options) {
      scheduledOptions = options;
      return { start() { events.push('scheduler:start'); options.onResult(options.run()); }, stop() { events.push('scheduler:stop'); } };
    },
  });
  assert.deepEqual(events.slice(0, 2), ['on:SIGINT', 'on:SIGTERM']);
  assert.equal(events.indexOf('db:open:TAG') < events.indexOf('dbus:call:system'), true);
  assert.equal(events.includes('scheduler:start'), true);
  assert.equal(events.includes('details:set'), true);
  assert.equal(scheduledOptions.intervalMs, 1000);
  runtime.stop();
  assert.deepEqual(events.slice(-5), [
    'scheduler:stop', 'dbus:close', 'db:close', 'off:SIGINT', 'off:SIGTERM',
  ]);
  runtime.stop();
  assert.equal(events.filter((event) => event === 'db:close').length, 1, 'shutdown은 한 번만 정리해야 합니다.');
}

function testStartupFailuresStayAliveAndBackoff() {
  const scheduled = [];
  let openAttempts = 0;
  let appendAttempts = 0;
  let databaseCloses = 0;
  let dbusCalls = 0;
  const database = {
    open() {
      openAttempts += 1;
      if (openAttempts === 1) throw new Error('db secret must not escape');
    },
    append() {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error('append failed');
    },
    close() { databaseCloses += 1; },
  };
  const dbus = {
    call() {
      dbusCalls += 1;
      if (dbusCalls === 1) throw new Error('initial dbus connect failed');
      return { body: [[1, 2]] };
    },
    close() {},
  };
  let runtime;
  assert.doesNotThrow(() => {
    runtime = startCollector({ name: 'alpha', ...outputSelectionJobConfig() }, {
      cgiRoot: '/tmp/cgi-bin', jobName: 'alpha', database, dbus,
      interfaceStore: interfaceStore(),
      settings: { limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } },
      validateConfig(config) { return config; },
      details: { setLastRun() {} },
      process: { on() {}, removeListener() {} },
      schedulerFactory(options) {
        return createScheduler({
          ...options,
          setTimer(callback, delay) { scheduled.push({ callback, delay }); return scheduled.length; },
          clearTimer() {},
        });
      },
    });
  });
  let next = scheduled.shift();
  assert.equal(next.delay, 5000, 'DB open 실패는 첫 backoff로 재시도해야 합니다.');
  next.callback();
  next = scheduled.shift();
  assert.equal(next.delay, 10000, 'DBus 초기 연결 실패도 service를 끝내지 않아야 합니다.');
  next.callback();
  next = scheduled.shift();
  assert.equal(next.delay, 20000, 'append 실패는 stream을 닫고 다음 cycle에 다시 열어야 합니다.');
  assert.equal(databaseCloses >= 2, true);
  assert.equal(openAttempts, 2);
  next.callback();
  assert.equal(scheduled.shift().delay, 1000);
  assert.equal(openAttempts, 3, 'append 실패 뒤 DB stream을 다시 열어야 합니다.');
  runtime.stop();
}

function testCollectorLoggerAndLogApiIntegration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbus-collector-log-'));
  try {
    const logDir = path.join(root, 'logs');
    const scheduled = [];
    let loggerInit = null;
    const runtime = startCollector({ name: 'alpha', ...outputSelectionJobConfig() }, {
      cgiRoot: path.join(root, 'cgi-bin'),
      jobName: 'alpha',
      interfaceStore: interfaceStore(),
      settings: { limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } },
      validateConfig(config) { return config; },
      database: {
        open() { throw new Error('password=database-secret token: db-token %MB3'); },
        append() {},
        close() {},
      },
      dbus: { call() { throw new Error('raw body with tag value'); }, close() {} },
      details: { setLastRun() {} },
      process: { on() {}, removeListener() {} },
      loggerFactory(config, options) {
        loggerInit = { config, options };
        return new Logger(config, { ...options, logDir });
      },
      schedulerFactory(options) {
        return createScheduler({
          ...options,
          setTimer(callback, delay) { scheduled.push({ callback, delay }); return scheduled.length; },
          clearTimer() {},
        });
      },
    });
    assert.deepEqual(loggerInit, {
      config: { level: 'info', maxFiles: 10 },
      options: { name: 'alpha', cgiRoot: path.join(root, 'cgi-bin') },
    });
    assert.equal(scheduled[0].delay, 5000);
    runtime.stop();

    const reader = createLogReader({ logDir });
    let readError;
    let content;
    reader.contentAll({ name: 'alpha' }, (failure, value) => { readError = failure; content = value; });
    assert.equal(readError, null);
    assert.match(content.content, /collector started/);
    assert.match(content.content, /database open failed/);
    assert.match(content.content, /cycle failed/);
    assert.match(content.content, /retry scheduled/);
    assert.match(content.content, /collector stopped/);
    assert.equal(content.content.includes('database-secret'), false);
    assert.equal(content.content.includes('db-token'), false);
    assert.equal(content.content.includes('%MB3'), false);
    assert.equal(content.content.includes('raw body'), false);

    const loggingFailures = [];
    assert.doesNotThrow(() => {
      const failingRuntime = startCollector({ name: 'alpha', ...outputSelectionJobConfig() }, {
        cgiRoot: path.join(root, 'cgi-bin'), jobName: 'alpha',
        interfaceStore: interfaceStore(),
        settings: { limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } },
        validateConfig(config) { return config; },
        database: { open() {}, append() {}, close() {} },
        dbus: { call() { return { body: [[1, 2]] }; }, close() {} },
        details: { setLastRun() {} }, process: { on() {}, removeListener() {} },
        loggerFactory() {
          return {
            info() { loggingFailures.push('info'); throw new Error('logger failed'); },
            warn() { loggingFailures.push('warn'); throw new Error('logger failed'); },
            error() { loggingFailures.push('error'); throw new Error('logger failed'); },
            close() { loggingFailures.push('close'); throw new Error('logger failed'); },
          };
        },
        schedulerFactory(options) {
          return createScheduler({ ...options, setTimer() { return 1; }, clearTimer() {} });
        },
      });
      failingRuntime.stop();
    });
    assert.equal(loggingFailures.length > 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testMachbaseAppender();
testMachbaseAppenderWithoutStringColumn();
testAppenderUsesCanonicalColumnNamesCaseInsensitively();
testEntryStartupAndShutdown();
testStartupFailuresStayAliveAndBackoff();
testCollectorLoggerAndLogApiIntegration();
console.log('Collector entry and adapters: ok');
