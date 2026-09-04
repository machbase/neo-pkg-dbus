'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
// JSH package command resolution does not resolve CommonJS `../` paths in a
// script the same way Node does.  Use the executing script's absolute virtual
// path so `pkg run` works both in Neo JSH and in local Node tests.
const SCRIPT_ROOT = typeof __dirname === 'string' && __dirname
  ? __dirname : path.resolve(path.dirname(process.argv[1] || '.'));
const { writeJsonAtomic } = require(path.join(SCRIPT_ROOT, '..', 'cgi-bin', 'src', 'config', 'atomic-json.js'));

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
  const beforeInstall = settings.beforeInstall || (() => {});

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
    try { beforeInstall(); } catch (prepareError) {
      finish(callback, prepareError, [], 'installed');
      return;
    }
    const installJobs = () => manager.list((listError, jobs) => {
      if (listError) { finish(callback, listError, [], 'installed'); return; }
      const names = jobs.filter((job) => job.configState === 'config-only').map((job) => job.name);
      eachSeries(names, (name, next) => manager.install(name, next), (installError) => {
        finish(callback, installError, names, 'installed');
      });
    });
    if (manager.isLs === true && typeof manager.installPackageService === 'function') {
      manager.installPackageService((installError) => {
        if (installError) { finish(callback, installError, [], 'installed'); return; }
        installJobs();
      });
      return;
    }
    installJobs();
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
        const allFailures = [...unsafe, ...stopFailures];
        if (allFailures.length || typeof manager.stopDaemonForPackage !== 'function') {
          finishLifecycleSession(session, callback, aggregateFailure(allFailures), targetNames, 'stopped');
          return;
        }
        manager.stopDaemonForPackage((daemonError) => {
          if (daemonError) allFailures.push(failureRecord(daemonError, 'ls-collector'));
          finishLifecycleSession(session, callback, aggregateFailure(allFailures), targetNames, 'stopped');
        });
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
      if (manager.isLs === true && typeof manager.startDaemonForPackage === 'function') {
        manager.startDaemonForPackage((startError) => {
          if (!startError) {
            try { clearCheckpoint(); } catch (clearError) {
              finish(callback, clearError, names, 'started');
              return;
            }
          }
          finish(callback, startError, names, 'started');
        });
        return;
      }
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
      const deleteJobs = () => eachSeriesCollect(running, session.stopForPackage, (stopFailures) => {
        const stopError = aggregateFailure(stopFailures);
        if (stopError) {
          finishLifecycleSession(session, callback, stopError, names, 'uninstalled');
          return;
        }
        eachSeriesCollect(names, session.delete, (deleteFailures) => {
          const deleteError = aggregateFailure(deleteFailures);
          if (deleteError) {
            finishLifecycleSession(session, callback, deleteError, names, 'uninstalled');
            return;
          }
          const finishUninstall = (daemonError) => {
            if (daemonError) {
              finishLifecycleSession(session, callback, aggregateFailure([failureRecord(daemonError, 'ls-collector')]), names, 'uninstalled');
              return;
            }
            try { clearCheckpoint(); } catch (clearError) {
              finishLifecycleSession(session, callback, clearError, names, 'uninstalled');
              return;
            }
            finishLifecycleSession(session, callback, null, names, 'uninstalled');
          };
          if (manager.isLs === true && typeof manager.uninstallDaemonForPackage === 'function') {
            manager.uninstallDaemonForPackage(finishUninstall);
          } else finishUninstall(null);
        });
      });
      // Unlike generic's independent Job services, LS has one data-plane
      // process. Stop it before removing any Job snapshot/config it may read.
      if (manager.isLs === true && typeof manager.stopDaemonForPackage === 'function') {
        manager.stopDaemonForPackage((daemonError) => {
          if (daemonError) {
            finishLifecycleSession(session, callback, aggregateFailure([failureRecord(daemonError, 'ls-collector')]), names, 'uninstalled');
            return;
          }
          deleteJobs();
        });
      } else deleteJobs();
    });
  }

  return { install, start, stop, uninstall };
}

function ensureLsCollectorExecutable(cgiRoot) {
  const productFile = path.join(cgiRoot, 'product', 'index.js');
  if (!fs.existsSync(productFile) || require(productFile).target !== 'ls') return;
  const files = [
    path.join(cgiRoot, 'bin', 'neo-dbus-collector'),
    path.join(cgiRoot, 'neo-dbus-launcher.js'),
    path.join(cgiRoot, 'neo-dbus-control.js'),
  ];
  if (files.some((file) => !fs.existsSync(file) || !fs.statSync(file).isFile())) {
    const failure = new Error('LS collector executable or JSH launcher files are missing from this package build.');
    failure.code = 'PACKAGE_INSTALL_FAILED';
    throw failure;
  }
  if (typeof fs.chmodSync !== 'function') {
    const failure = new Error('LS collector executable permissions cannot be set by this JSH runtime.');
    failure.code = 'PACKAGE_INSTALL_FAILED';
    throw failure;
  }
  files.forEach((file) => fs.chmodSync(file, 0o755));
}

// `pkg install` normally reaches the JobManager lifecycle, which refreshes the
// LS collector snapshot as part of package installation.  The LS fast path
// below deliberately uses servicectl directly (the service controller must not
// depend on an asynchronous JSH callback), so a manually unpacked package can
// otherwise register a service with no go-collector.json and the Go child exits
// immediately.  Seed the snapshot before install/start; this is also safe when
// Jobs already exist and preserves their current active checkpoint.
function ensureLsCollectorSnapshot(cgiRoot) {
  const { JobManager } = require(path.join(cgiRoot, 'src', 'jobs', 'manager.js'));
  const manager = new JobManager({ cgiRoot });
  if (!manager.isLs || !manager.lsRuntime) return;

  // server-store.list() creates the default localhost profile when a freshly
  // unpacked package has no DB profile directory yet. Its callback-based API is
  // synchronous by contract, just like the snapshot's server-store access.
  if (manager.serverStore && typeof manager.serverStore.list === 'function') {
    let listError = null;
    manager.serverStore.list((error) => { listError = error || null; });
    if (listError) throw listError;
  }
  manager.lsRuntime.snapshot();
}

function defaultLifecycle() {
  const cgiRoot = defaultCgiRoot();
  const { JobManager } = require(path.join(cgiRoot, 'src', 'jobs', 'manager.js'));
  return createLifecycle(
    new JobManager({ cgiRoot }),
    path.join(cgiRoot, 'data', 'package-stop-state.json'),
    { beforeInstall: () => ensureLsCollectorExecutable(cgiRoot) },
  );
}

function defaultCgiRoot() {
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  return path.join(root, 'cgi-bin');
}

// `pkg run` executes a package script in a short-lived child JSH engine.  The
// service module is callback based, so an LS package lifecycle must use the
// synchronous servicectl command: otherwise that child can exit before the
// service RPC callback has completed.  Generic keeps its existing per-Job
// callback lifecycle unchanged.
function runLsPackageAction(action) {
  const cgiRoot = defaultCgiRoot();
  const productFile = path.join(cgiRoot, 'product', 'index.js');
  if (!fs.existsSync(productFile) || require(productFile).target !== 'ls') return false;

  ensureLsCollectorExecutable(cgiRoot);
  const launcher = path.join(cgiRoot, 'neo-dbus-launcher.js');
  const serviceName = '_dbu_collector';
  const exec = (...args) => {
    const result = process.exec(...args);
    if (result instanceof Error) throw result;
    return result;
  };
  const stopNative = () => {
    // The controller can lose the JSH launcher while its native child retains
    // inherited pipes.  Kill the exact collector command first so stop never
    // waits indefinitely and no orphan keeps collecting after package stop.
    const result = process.exec('@pkill', '-TERM', '-f', '/cgi-bin/bin/neo-dbus-collector');
    if (result instanceof Error) throw result;
  };

  if (action === 'install') {
    ensureLsCollectorSnapshot(cgiRoot);
    if (exec('servicectl', 'install', '--name', serviceName,
      '--working-dir', cgiRoot, '--executable', launcher, '--enable') !== 0) {
      throw new Error('LS collector service installation failed.');
    }
  } else if (action === 'start') {
    ensureLsCollectorSnapshot(cgiRoot);
    if (exec('servicectl', 'start', serviceName) !== 0) throw new Error('LS collector service start failed.');
  } else if (action === 'stop') {
    stopNative();
    const result = exec('servicectl', 'stop', serviceName);
    if (result !== 0) defaultPrint('[WARN] LS collector service was already stopped or unavailable.');
  } else if (action === 'uninstall') {
    stopNative();
    exec('servicectl', 'stop', serviceName);
    const result = exec('servicectl', 'uninstall', serviceName);
    if (result !== 0) defaultPrint('[WARN] LS collector service was already uninstalled or unavailable.');
  } else throw new Error(`Unsupported package lifecycle action: ${action}`);
  defaultPrint(`[INFO] LS collector ${action} completed`);
  return true;
}

function packageAction(action) {
  try {
    if (runLsPackageAction(action)) return;
  } catch (failure) {
    defaultPrint(JSON.stringify({ ok: false, code: 'PACKAGE_LIFECYCLE_FAILED', reason: failure.message || String(failure) }));
    process.exit(1);
    return;
  }
  defaultLifecycle()[action]();
}

module.exports = {
  createLifecycle,
  defaultCgiRoot,
  ensureLsCollectorExecutable,
  runLsPackageAction,
  install(callback) { if (callback) defaultLifecycle().install(callback); else packageAction('install'); },
  start(callback) { if (callback) defaultLifecycle().start(callback); else packageAction('start'); },
  stop(callback) { if (callback) defaultLifecycle().stop(callback); else packageAction('stop'); },
  uninstall(callback) { if (callback) defaultLifecycle().uninstall(callback); else packageAction('uninstall'); },
};
