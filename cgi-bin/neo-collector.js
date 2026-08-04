'use strict';

const path = require('path');
const process = require('process');
const { JobRepository } = require('./src/jobs/repository.js');

function defaultCgiRoot() {
  return typeof __dirname === 'string' ? __dirname : path.dirname(process.argv[1]);
}

function loadCollectorEntry() {
  try {
    return require('./src/collector/entry.js');
  } catch (loadError) {
    const failure = new Error('Collector 실행 모듈이 아직 준비되지 않았습니다: src/collector/entry.js');
    failure.code = 'COLLECTOR_ENTRY_NOT_AVAILABLE';
    failure.cause = loadError;
    throw failure;
  }
}

function runCollectorEntry(args, options) {
  const settings = options || {};
  const argument = args && args[0];
  if (typeof argument !== 'string' || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.json$/.test(argument)
    || /[\\/]/.test(argument)) {
    throw new Error('neo-collector.js에는 안전한 Job 설정 파일 이름 하나가 필요합니다.');
  }
  const cgiRoot = settings.cgiRoot || defaultCgiRoot();
  const name = argument.slice(0, -5);
  const repository = settings.repository || new JobRepository({ cgiRoot });
  const document = repository.read(name);
  const entry = settings.loadEntry ? settings.loadEntry() : loadCollectorEntry();
  if (!entry || typeof entry.startCollector !== 'function') {
    throw new Error('Collector 실행 모듈은 startCollector(document, context)를 제공해야 합니다.');
  }
  return entry.startCollector(document, {
    cgiRoot,
    configPath: repository.file(name),
    jobName: name,
  });
}

const commonJsModule = typeof module !== 'undefined' && module && module.exports ? module : null;
if (!commonJsModule || (require.main && require.main === commonJsModule)) runCollectorEntry(process.argv.slice(2));
if (commonJsModule) commonJsModule.exports = { loadCollectorEntry, runCollectorEntry };
