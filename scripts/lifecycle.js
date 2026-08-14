'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const { writeJsonAtomic } = require('../cgi-bin/src/config/atomic-json.js');

function defaultPrint(message) {
  if (console.println) console.println(message);
  else console.log(message);
}

function eachSeries(values, operation, callback) {
  let index = 0;
  const next = (operationError) => {
    if (operationError || index >= values.length) {
      callback(operationError || null);
      return;
    }
    const value = values[index];
    index += 1;
    operation(value, next);
  };
  next(null);
}

function eachSeriesCollect(values, operation, callback) {
  const failures = [];
  eachSeries(values, (value, next) => operation(value, (operationError) => {
    if (operationError) failures.push({
      name: value,
      code: operationError.code || 'INTERNAL_ERROR',
      reason: operationError.message || String(operationError),
      details: operationError.details || {},
    });
    next(null);
  }), () => callback(failures));
}

function aggregateFailure(failures) {
  if (!failures.length) return null;
  const failure = new Error(`${failures.length}개 Job의 package lifecycle 작업이 실패했습니다.`);
  failure.code = 'PACKAGE_LIFECYCLE_FAILED';
  failure.details = { errors: failures };
  return failure;
}

function failureRecord(failure, fallbackName) {
  return {
    name: failure && failure.details && failure.details.name || fallbackName || 'package-lifecycle',
    code: failure && failure.code || 'INTERNAL_ERROR',
    reason: failure && failure.message ? failure.message : String(failure),
    details: failure && failure.details || {},
  };
}

function createLifecycle(manager, statePath, options) {
  const settings = options || {};
  const print = settings.print || defaultPrint;
  const exit = settings.exit || process.exit.bind(process);

  function packageFailure(failure) {
    if (failure && failure.code === 'PACKAGE_LIFECYCLE_FAILED') return failure;
    return aggregateFailure([failureRecord(failure)]);
  }

  function printFailure(failure) {
    print(JSON.stringify({
      ok: false,
      code: failure.code || 'PACKAGE_LIFECYCLE_FAILED',
      reason: failure.message || String(failure),
      details: failure.details || { errors: [] },
    }));
  }

  function finish(callback, error, names, verb) {
    if (callback) { callback(error, names); return; }
    if (error) {
      printFailure((verb === 'stopped' || verb === 'uninstalled') ? packageFailure(error) : error);
      exit(1);
      return;
    }
    print(`[INFO] ${verb} ${names.length} job service(s)`);
  }

  function readCheckpoint() {
    try {
      const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!value || !Array.isArray(value.names)) throw new Error('package stop checkpoint 형식이 잘못되었습니다.');
      return value.names;
    } catch (readError) {
      if (readError && readError.code === 'ENOENT') return null;
      throw readError;
    }
  }

  function clearCheckpoint() {
    try { fs.unlinkSync(statePath); } catch (unlinkError) {
      if (!unlinkError || unlinkError.code !== 'ENOENT') throw unlinkError;
    }
  }

  function acquireLifecycleSession(names) {
    if (typeof manager.acquirePackageLifecycle === 'function') {
      return manager.acquirePackageLifecycle(names);
    }
    return {
      acquire() {},
      stopForPackage: typeof manager.stopForPackage === 'function'
        ? manager.stopForPackage.bind(manager) : manager.stop.bind(manager),
      delete: manager.delete.bind(manager),
      release() {},
    };
  }

  function finishLifecycleSession(session, callback, operationError, names, verb) {
    let releaseError = null;
    try { session.release(); } catch (failure) { releaseError = failure; }
    if (operationError && releaseError
      && (typeof operationError === 'object' || typeof operationError === 'function')) {
      operationError.cleanupError = releaseError;
    }
    finish(callback, operationError || releaseError, names, verb);
  }

  function install(callback) {
    manager.list((listError, jobs) => {
      if (listError) { finish(callback, listError, [], 'installed'); return; }
      const names = jobs.filter((job) => job.configState === 'config-only').map((job) => job.name);
      eachSeries(names, (name, next) => manager.install(name, next), (installError) => {
        finish(callback, installError, names, 'installed');
      });
    });
  }

  function stop(callback) {
    let session;
    try { session = acquireLifecycleSession([]); } catch (acquireError) {
      finish(callback, aggregateFailure([failureRecord(acquireError)]), [], 'stopped');
      return;
    }
    manager.list((listError, jobs) => {
      if (listError) {
        finishLifecycleSession(session, callback, packageFailure(listError), [], 'stopped');
        return;
      }
      const restartNames = jobs.filter((job) => ['RUNNING', 'STARTING', 'STOPPING'].includes(job.controllerState))
        .map((job) => job.name).sort();
      const targetNames = jobs.filter((job) => job.statusKnown === true)
        .map((job) => job.name).sort();
      const unsafe = jobs.filter((job) => job.statusKnown === false || job.controllerState === 'UNKNOWN')
        .map((job) => ({
          name: job.name,
          code: job.controllerError && job.controllerError.code || 'CONTROLLER_UNKNOWN',
          reason: job.controllerError && job.controllerError.reason || job.controllerDetail || 'Controller 상태를 알 수 없습니다.',
          details: job.controllerError && job.controllerError.details || {},
        }));
      try { session.acquire(targetNames); } catch (acquireError) {
        finishLifecycleSession(
          session, callback, aggregateFailure([failureRecord(acquireError)]), targetNames, 'stopped',
        );
        return;
      }
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        writeJsonAtomic(statePath, {
          names: [...new Set(restartNames)].sort(), savedAt: new Date().toISOString(),
        });
      } catch (writeError) {
        finishLifecycleSession(session, callback, writeError, targetNames, 'stopped');
        return;
      }
      eachSeriesCollect(targetNames, session.stopForPackage, (stopFailures) => {
        finishLifecycleSession(
          session, callback, aggregateFailure([...unsafe, ...stopFailures]), targetNames, 'stopped',
        );
      });
    });
  }

  function start(callback) {
    manager.list((listError, jobs) => {
      if (listError) { finish(callback, listError, [], 'started'); return; }
      let checkpoint;
      try { checkpoint = readCheckpoint(); } catch (readError) {
        finish(callback, readError, [], 'started');
        return;
      }
      const startable = new Set(jobs.filter((job) => job.configState === 'installed'
        && ['STOPPED', 'FAILED'].includes(job.controllerState)).map((job) => job.name));
      const names = checkpoint === null
        ? [...startable].sort()
        : checkpoint.filter((name) => startable.has(name)).sort();
      eachSeries(names, (name, next) => manager.start(name, next), (startError) => {
        if (!startError) {
          try { clearCheckpoint(); } catch (clearError) {
            finish(callback, clearError, names, 'started');
            return;
          }
        }
        finish(callback, startError, names, 'started');
      });
    });
  }

  function uninstall(callback) {
    let session;
    try { session = acquireLifecycleSession([]); } catch (acquireError) {
      finish(callback, aggregateFailure([failureRecord(acquireError)]), [], 'uninstalled');
      return;
    }
    manager.list((listError, jobs) => {
      if (listError) {
        finishLifecycleSession(session, callback, packageFailure(listError), [], 'uninstalled');
        return;
      }
      const running = jobs.filter((job) => ['RUNNING', 'STARTING', 'STOPPING'].includes(job.controllerState))
        .map((job) => job.name).sort();
      const names = jobs.map((job) => job.name).sort();
      try { session.acquire(names); } catch (acquireError) {
        finishLifecycleSession(
          session, callback, aggregateFailure([failureRecord(acquireError)]), names, 'uninstalled',
        );
        return;
      }
      eachSeriesCollect(running, session.stopForPackage, (stopFailures) => {
        const stopError = aggregateFailure(stopFailures);
        if (stopError) {
          finishLifecycleSession(session, callback, stopError, names, 'uninstalled');
          return;
        }
        eachSeriesCollect(names, session.delete, (deleteFailures) => {
          const deleteError = aggregateFailure(deleteFailures);
          if (!deleteError) {
            try { clearCheckpoint(); } catch (clearError) {
              finishLifecycleSession(session, callback, clearError, names, 'uninstalled');
              return;
            }
          }
          finishLifecycleSession(session, callback, deleteError, names, 'uninstalled');
        });
      });
    });
  }

  return { install, start, stop, uninstall };
}

function defaultLifecycle() {
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  const cgiRoot = path.join(root, 'cgi-bin');
  const { JobManager } = require(path.join(cgiRoot, 'src', 'jobs', 'manager.js'));
  return createLifecycle(
    new JobManager({ cgiRoot }),
    path.join(cgiRoot, 'data', 'package-stop-state.json'),
  );
}

module.exports = {
  createLifecycle,
  install(callback) { defaultLifecycle().install(callback); },
  start(callback) { defaultLifecycle().start(callback); },
  stop(callback) { defaultLifecycle().stop(callback); },
  uninstall(callback) { defaultLifecycle().uninstall(callback); },
};
