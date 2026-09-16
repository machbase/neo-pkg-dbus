'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../config/atomic-json.js');
const { error } = require('../config/errors.js');
const { validateJobName } = require('./validator.js');

const INDEX_SCHEMA_VERSION = 1;

function tagsForCall(call) {
  if (Array.isArray(call && call.outputSelections)) {
    return call.outputSelections.flatMap((selection) => Array.isArray(selection.tags) ? selection.tags : []);
  }
  return Array.isArray(call && call.tags) ? call.tags : [];
}

function fromDocument(document) {
  const calls = Array.isArray(document && document.methodCalls) ? document.methodCalls : [];
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    name: document.name,
    profileId: document.profileId || '',
    revision: document.revision,
    intervalMs: document.schedule && document.schedule.intervalMs,
    methodCallCount: calls.length,
    tagCount: calls.reduce((total, call) => total + tagsForCall(call).length, 0),
    interfaceIds: [...new Set(calls.map((call) => call.interfaceId).filter(Boolean))].sort(),
    methodReferences: calls.map((call) => ({
      interfaceId: call.interfaceId,
      methodId: call.methodId,
      callId: call.id,
    })),
    database: {
      server: document.database && document.database.server,
      table: document.database && document.database.table,
      valueColumn: document.database && document.database.valueColumn,
      stringValueColumn: document.database && document.database.stringValueColumn || '',
    },
    execution: {
      savePolicy: document.execution && document.execution.savePolicy,
      onMethodError: document.execution && document.execution.onMethodError,
    },
    logLevel: document.log && document.log.level || 'info',
  };
}

function validateIndex(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== INDEX_SCHEMA_VERSION || value.name !== name
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isInteger(value.methodCallCount) || value.methodCallCount < 0
    || !Number.isInteger(value.tagCount) || value.tagCount < 0
    || typeof value.profileId !== 'string'
    || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1
    || !Array.isArray(value.interfaceIds) || !Array.isArray(value.methodReferences)
    || value.interfaceIds.some((item) => typeof item !== 'string' || !item)
    || value.methodReferences.length !== value.methodCallCount
    || value.methodReferences.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.interfaceId !== 'string' || !item.interfaceId
      || typeof item.methodId !== 'string' || !item.methodId
      || typeof item.callId !== 'string' || !item.callId)
    || !value.database || typeof value.database !== 'object' || Array.isArray(value.database)
    || ['server', 'table', 'valueColumn', 'stringValueColumn'].some((field) => typeof value.database[field] !== 'string')
    || !value.execution || typeof value.execution !== 'object' || Array.isArray(value.execution)
    || typeof value.execution.savePolicy !== 'string' || typeof value.execution.onMethodError !== 'string'
    || typeof value.logLevel !== 'string' || !value.logLevel) {
    throw error('JOB_INVALID_CONFIG', 'Job summary를 읽을 수 없습니다. Job을 다시 저장하십시오.', {
      name,
      summaryUnavailable: true,
    });
  }
  return value;
}

class JobIndexRepository {
  constructor(options) {
    const settings = options || {};
    this.directory = settings.directory || path.join(settings.cgiRoot, 'conf.d', 'job-index');
    this.jobDirectory = settings.jobDirectory || path.join(settings.cgiRoot, 'conf.d', 'jobs');
    fs.mkdirSync(this.directory, { recursive: true });
  }

  file(name) { return path.join(this.directory, `${validateJobName(name)}.json`); }

  jobFile(name) { return path.join(this.jobDirectory, `${validateJobName(name)}.json`); }

  exists(name) { return fs.existsSync(this.file(name)); }

  registered(name) { return fs.existsSync(this.jobFile(name)) && this.exists(name); }

  read(name) {
    validateJobName(name);
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch (failure) {
      if (failure && failure.code === 'ENOENT') {
        throw error('JOB_NOT_FOUND', 'Job summary를 찾을 수 없습니다.', { name, summaryUnavailable: true });
      }
      throw error('JOB_INVALID_CONFIG', 'Job summary를 읽을 수 없습니다. Job을 다시 저장하십시오.', {
        name,
        summaryUnavailable: true,
      });
    }
    return validateIndex(name, value);
  }

  write(document) {
    validateJobName(document && document.name);
    const value = validateIndex(document.name, fromDocument(document));
    writeJsonAtomic(this.file(document.name), value);
    return value;
  }

  remove(name) {
    const target = this.file(name);
    try { fs.unlinkSync(target); }
    catch (failure) { if (!failure || failure.code !== 'ENOENT') throw failure; }
  }

  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter((entry) => entry.endsWith('.json')).sort().flatMap((entry) => {
      const name = entry.slice(0, -5);
      try {
        validateJobName(name);
        // An index is only a registration marker while its canonical Job file
        // exists. A delete interrupted between the two unlinks must not leave a
        // ghost Job in the UI or package lifecycle.
        if (!fs.existsSync(this.jobFile(name))) return [];
        return [{ name, index: this.read(name), error: null }];
      } catch (failure) {
        return [{ name, index: null, error: failure }];
      }
    });
  }
}

module.exports = { INDEX_SCHEMA_VERSION, JobIndexRepository, fromDocument, validateIndex };
