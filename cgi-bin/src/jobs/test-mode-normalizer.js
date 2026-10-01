'use strict';

const path = require('path');
const { createJobOperationLock } = require('./operation-lock.js');
const { JobIndexRepository } = require('./index-repository.js');
const { JobRepository, revisionOf } = require('./repository.js');

function createTestModeNormalizer(options) {
  const settings = options || {};
  const policy = settings.productPolicy;
  const repository = settings.repository || new JobRepository({
    cgiRoot: settings.cgiRoot,
    jobDir: settings.jobDir,
  });
  const indexRepository = settings.indexRepository || new JobIndexRepository({
    cgiRoot: settings.cgiRoot,
    jobDirectory: repository.directory,
    directory: settings.jobIndexDir,
  });
  const operationLock = settings.operationLock || createJobOperationLock({
    directory: path.join(settings.cgiRoot, 'conf.d', '.job-operation-locks'),
  });

  function disableForDatabase(serverName, effectiveTable) {
    if (!policy || policy.target !== 'ls' || typeof policy.normalizeTestMode !== 'function') return [];
    const table = String(effectiveTable || '').trim().toUpperCase();
    if (table === policy.testTable) return [];
    const changed = [];
    repository.list().forEach((record) => {
      if (record.error || !record.document || !indexRepository.registered(record.name)) return;
      if (record.document.database?.server !== serverName || record.document.execution?.test !== true) return;
      const handle = operationLock.acquire(record.name);
      try {
        const current = repository.read(record.name);
        if (current.database?.server !== serverName || current.execution?.test !== true) return;
        const effective = {
          ...current,
          database: { ...current.database, table },
          execution: { ...current.execution },
        };
        policy.normalizeTestMode(effective);
        if (effective.execution.test === true) return;
        // A database profile change can restart running Jobs without passing
        // through the public Job Start endpoint. Persist false before reload
        // so returning to the benchmark table can never re-enable TEST.
        const revision = revisionOf(current);
        const document = repository.save(record.name, {
          ...current,
          execution: { ...current.execution, test: false },
          revision: revision + 1,
        }, revision);
        indexRepository.write(document);
        changed.push(record.name);
      } finally {
        handle.release();
      }
    });
    return changed;
  }

  return { disableForDatabase };
}

module.exports = { createTestModeNormalizer };
