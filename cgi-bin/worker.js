'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60000;

function scriptDirectory() {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(process.argv[1]);
}

function loadCounterStore() {
  const root = scriptDirectory();
  const generatedPath = path.join(root, 'src', 'example', 'counter.js');
  if (fs.existsSync(generatedPath)) return require(generatedPath).CounterStore;
  return require(path.resolve(
    root,
    '..', '..', '..', 'template-common', 'cgi-bin', 'src', 'example', 'counter.js',
  )).CounterStore;
}

function intervalMsFor(document) {
  const config = document && document.config && typeof document.config === 'object'
    ? document.config
    : {};
  const intervalMs = config.intervalMs === undefined ? DEFAULT_INTERVAL_MS : config.intervalMs;
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error(`intervalMs는 ${MIN_INTERVAL_MS}~${MAX_INTERVAL_MS} 사이의 정수여야 합니다.`);
  }
  return intervalMs;
}

function jobNameFor(configPath, document) {
  const jobName = String((document && document.name) || '');
  const configName = path.basename(String(configPath || ''), '.json');
  if (!configPath || !jobName || configName !== jobName) {
    throw new Error(
      `설정 파일 이름과 작업 이름이 일치해야 합니다: ${configName || '(없음)'} != ${jobName || '(없음)'}`,
    );
  }
  return jobName;
}

function startWorker(configPath, options) {
  const settings = options || {};
  const document = settings.document || (() => {
    if (!configPath) throw new Error('worker.js <job-config.json> 형식으로 실행하세요.');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  })();
  const jobName = jobNameFor(configPath, document);
  const intervalMs = intervalMsFor(document);
  const dataDir = settings.dataDir || path.resolve(path.dirname(configPath || '.'), '..', '..', 'data');
  const CounterStore = loadCounterStore();
  const counter = settings.counter || new CounterStore(dataDir);
  const tick = () => counter.increment(jobName);
  tick();
  const setTimer = settings.setInterval || setInterval;
  const clearTimer = settings.clearInterval || clearInterval;
  const timer = setTimer(tick, intervalMs);
  return {
    intervalMs,
    stop() { clearTimer(timer); },
  };
}

const hasCommonJsModule = typeof module !== 'undefined';
if (!hasCommonJsModule || require.main === module) {
  const runOnce = process.argv[3] === '--once';
  const worker = startWorker(
    process.argv[2],
    runOnce
      ? { setInterval: () => null, clearInterval: () => {} }
      : undefined,
  );
  if (!runOnce && process.addShutdownHook) process.addShutdownHook(() => worker.stop());
}

if (hasCommonJsModule) {
  module.exports = {
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
    intervalMsFor,
    jobNameFor,
    startWorker,
  };
}
