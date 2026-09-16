'use strict';

// LS uses one Go data-plane service. This adapter keeps that implementation
// detail behind the existing JobManager API. JSH owns canonical Job JSON and
// small Job indexes; Go reads the canonical Job directly when it starts one.
// This file therefore contains only deployment-wide policy and DB secrets.
const fs = require('fs');
const path = require('path');
const process = require('process');
const { writeJsonAtomic } = require('../config/atomic-json.js');
const { createServerStore } = require('../db/server-store.js');
const { loadSettings } = require('../config/settings-loader.js');
const { classifyControllerState } = require('../service/controller-state.js');
const { isNotInstalled } = require('../service/controller-adapter.js');

const LS_SERVICE_NAME = '_dbu_collector';
const SNAPSHOT_FILE = 'go-collector.json';
const SECRET_FILE = 'go-collector-secrets.json';
const ACTIVE_FILE = 'go-collector-active-jobs.json';
const RUNTIME_FILE = 'go-collector-runtime.json';
const BINARY_FILE = path.join('bin', 'neo-dbus-collector');
const LAUNCHER_FILE = 'neo-dbus-launcher.js';
const CONTROL_FILE = 'neo-dbus-control.js';

function runtimePaths(cgiRoot) {
  return {
    snapshot: path.join(cgiRoot, 'conf.d', SNAPSHOT_FILE),
    secret: path.join(cgiRoot, 'conf.d', SECRET_FILE),
    active: path.join(cgiRoot, 'conf.d', ACTIVE_FILE),
    runtime: path.join(cgiRoot, 'data', RUNTIME_FILE),
    binary: path.join(cgiRoot, BINARY_FILE),
    launcher: path.join(cgiRoot, LAUNCHER_FILE),
    control: path.join(cgiRoot, CONTROL_FILE),
  };
}

function readRuntime(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { jobs: {} };
  } catch (readError) {
    if (readError && readError.code === 'ENOENT') return { jobs: {} };
    throw readError;
  }
}

function readActiveJobs(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.names)
      || value.names.some((name) => typeof name !== 'string')) throw new Error('LS collector active Job state is invalid.');
    return [...new Set(value.names)].sort();
  } catch (readError) {
    if (readError && readError.code === 'ENOENT') return [];
    throw readError;
  }
}

function syncCallback(operation) {
  let called = false; let failure; let value;
  operation((error, result) => { called = true; failure = error; value = result; });
  if (!called) throw new Error('LS collector configuration store must complete synchronously.');
  if (failure) throw failure;
  return value;
}

function writeSecretAtomic(file, value) {
  writeJsonAtomic(file, value);
  // JSH fs implements chmodSync. If an older runtime does not, fail closed:
  // running a native collector with a world-readable DB password is unsafe.
  if (typeof fs.chmodSync !== 'function') throw new Error('secure collector secret file permissions are unavailable.');
  fs.chmodSync(file, 0o600);
}

function controllerStatus(controller, callback) {
  controller.status(LS_SERVICE_NAME, (statusError, info) => {
    if (statusError && isNotInstalled(statusError)) {
      callback(null, { controllerState: 'NOT_INSTALLED', controllerDetail: null, statusError: null });
      return;
    }
    if (statusError) {
      callback(null, { controllerState: 'UNKNOWN', controllerDetail: statusError.message || null, statusError });
      return;
    }
    const state = classifyControllerState(info);
    callback(null, {
      controllerState: state.known ? state.state : 'UNKNOWN',
      controllerDetail: state.detail || null,
      statusError: state.known ? null : new Error(state.detail || 'Controller state is unknown.'),
    });
  });
}

function createLsRuntime(options) {
  const settings = options || {};
  const cgiRoot = settings.cgiRoot;
  const controller = settings.controller;
  const serverStore = settings.serverStore || createServerStore({ cgiRoot });
  const processApi = settings.process || process;
  const files = runtimePaths(cgiRoot);

  // A GitHub source/release ZIP can be extracted without executable bits.
  // The controller executes the JSH launcher/control files directly, not via
  // an already-running JSH shell, so all three entry points need correction.
  // Do this before both service registration and direct control invocation so
  // LS delivery does not depend on the downloader or archive utility.
  function ensureExecutable() {
    if (!fs.existsSync(files.binary)) throw new Error('LS Go collector executable is missing. Build the LS package first.');
    if (!fs.existsSync(files.launcher) || !fs.existsSync(files.control)) {
      throw new Error('LS Go collector JSH launcher files are missing.');
    }
    if (typeof fs.chmodSync !== 'function') throw new Error('LS collector executable permissions cannot be set by this JSH runtime.');
    fs.chmodSync(files.binary, 0o755);
    fs.chmodSync(files.launcher, 0o755);
    fs.chmodSync(files.control, 0o755);
  }

  function syncConfig() {
    const settings = loadSettings(path.join(cgiRoot, 'conf.d', 'settings.json'));
    // The LS product has exactly one database profile.  Treat the configured
    // default server as authoritative even for pre-profile Job JSON that may
    // still contain a copied, old server name.
    const profileName = settings.defaults.database.server;
    const source = syncCallback((callback) => serverStore.get(profileName, callback));
    if (!source) throw new Error(`LS collector DB server was not found: ${profileName}`);
    const servers = {};
    servers[profileName] = {
      host: source.host, port: source.port, user: source.user, password: source.password,
      defaultTable: source.defaultTable || '',
      valueColumn: source.valueColumn || '',
      stringValueColumn: source.stringValueColumn || '',
    };
    writeJsonAtomic(files.snapshot, {
      schemaVersion: 2,
      logging: settings.logging,
      writer: settings.ls.writer,
      performance: settings.ls.performance,
    });
    writeSecretAtomic(files.secret, { schemaVersion: 1, servers });
    if (!fs.existsSync(files.active)) writeJsonAtomic(files.active, { schemaVersion: 1, names: [] });
  }

  function execControl(action, name) {
    ensureExecutable();
    if (!processApi || typeof processApi.exec !== 'function') throw new Error('JSH process.exec() is unavailable for LS collector control.');
    // process.exec() runs a JSH command file directly. The @ prefix is only
    // for an OS command; using it here asks the host to exec a JavaScript file
    // and fails with "exec format error" on Linux.
    const exitCode = processApi.exec(files.control, action, name);
    if (exitCode !== 0) throw new Error(`LS collector ${action} control command failed (exit=${exitCode}).`);
  }

  function install(callback) {
    try { ensureExecutable(); } catch (permissionError) { callback(permissionError); return; }
    controllerStatus(controller, (_unused, state) => {
      if (state.statusError) { callback(state.statusError); return; }
      if (state.controllerState !== 'NOT_INSTALLED') { callback(null, state); return; }
      controller.install({
        name: LS_SERVICE_NAME,
        // The collector must come back after a Neo process restart and then
        // restore the logical active-job checkpoint. Service-controller
        // descriptors are disabled unless enable is explicitly true.
        enable: true,
        working_dir: cgiRoot,
        executable: files.launcher,
      }, (installError) => {
        if (!installError) {
          controllerStatus(controller, (_ignored, installed) => callback(installed.statusError, installed));
          return;
        }
        // A package upgrade can preserve the existing shared service while
        // invoking install again. Some Neo controller versions report that
        // race as an ordinary error instead of returning its current state.
        // Do not query status again here: Neo 8.5.11 can leave that request
        // waiting indefinitely after this exact duplicate response. The
        // service name is package-private and fixed; start/health perform the
        // real controller operation and report a genuine service failure.
        if (!/already exists/i.test(String(installError.message || installError))) { callback(installError); return; }
        callback(null, {
          controllerState: 'STOPPED',
          controllerDetail: 'Existing shared collector service retained during package install.',
          statusError: null,
        });
      });
    });
  }

  function ensureRunning(callback) {
    install((installError, state) => {
      if (installError) { callback(installError); return; }
      if (['RUNNING', 'STARTING'].includes(state.controllerState)) { callback(null, state); return; }
      controller.start(LS_SERVICE_NAME, (startError) => {
        if (startError) { callback(startError); return; }
        controllerStatus(controller, (_ignored, started) => callback(started.statusError, started));
      });
    });
  }

  // The package health endpoint needs the shared daemon state separately from
  // the logical Job states. An idle daemon can have zero running Jobs, while a
  // package stop leaves the Job configuration intact but stops this service.
  function daemonStatus(callback) {
    controllerStatus(controller, callback);
  }

  function inspect(name, callback) {
    controllerStatus(controller, (_unused, service) => {
      if (service.statusError) { callback(null, service); return; }
      if (service.controllerState === 'NOT_INSTALLED') { callback(null, service); return; }
      if (!['RUNNING', 'STARTING'].includes(service.controllerState)) {
        callback(null, {
          controllerState: service.controllerState === 'FAILED' ? 'FAILED' : 'STOPPED',
          controllerDetail: service.controllerDetail,
          statusError: null,
        });
        return;
      }
      let runtime;
      try { runtime = readRuntime(files.runtime); } catch (runtimeError) {
        callback(null, { controllerState: 'UNKNOWN', controllerDetail: runtimeError.message, statusError: runtimeError });
        return;
      }
      const job = runtime.jobs && runtime.jobs[name];
      const runtimeState = job && job.state;
      const mappedState = runtimeState === 'running' ? 'RUNNING'
        : runtimeState === 'starting' ? 'STARTING'
          : runtimeState === 'stopping' ? 'STOPPING'
            : runtimeState === 'failed' ? 'FAILED' : 'STOPPED';
      callback(null, {
        controllerState: mappedState,
        controllerDetail: job && job.stateDetail || service.controllerDetail,
        statusError: null,
      });
    });
  }

  function overview(callback) {
    controllerStatus(controller, (_unused, service) => {
      if (service.statusError) {
        callback(null, { service, runtime: { jobs: {} } });
        return;
      }
      // The checkpoint retains the latest run after a logical Job or package
      // stop. Read it once even when the shared service is stopped; lsState()
      // still derives execution state from the controller first.
      try { callback(null, { service, runtime: readRuntime(files.runtime) }); }
      catch (runtimeError) {
        callback(null, {
          service: { controllerState: 'UNKNOWN', controllerDetail: runtimeError.message, statusError: runtimeError },
          runtime: { jobs: {} },
        });
      }
    });
  }

  function lastRun(name, callback) {
    try {
      const runtime = readRuntime(files.runtime);
      const job = runtime.jobs && runtime.jobs[name];
      if (!job) { callback(null, null); return; }
      if (!job.lastReadAt && !job.lastStoredAt && !job.lastError) { callback(null, null); return; }
      callback(null, {
        status: job.lastError ? 'failed' : 'success',
        lastRunAt: job.lastReadAt || null,
        lastSuccessfulRunAt: job.lastError ? null : (job.lastReadAt || null),
        lastStoredAt: job.lastStoredAt || null,
        lastError: job.lastError || null,
        overrunCount: Number.isSafeInteger(job.overrunCount) && job.overrunCount >= 0 ? job.overrunCount : 0,
        queueSkipped: Number.isSafeInteger(job.queueSkipped) && job.queueSkipped >= 0 ? job.queueSkipped : 0,
        lastOverrunAt: job.lastOverrunAt || null,
        methodCalls: [],
      });
    } catch (runtimeError) { callback(runtimeError); }
  }

  function uninstall(callback) {
    controllerStatus(controller, (_unused, state) => {
      if (state.statusError || state.controllerState === 'NOT_INSTALLED') { callback(state.statusError || null); return; }
      const remove = () => controller.uninstall(LS_SERVICE_NAME, callback);
      if (['RUNNING', 'STARTING'].includes(state.controllerState)) {
        controller.stop(LS_SERVICE_NAME, (stopError) => {
          if (stopError) { callback(stopError); return; }
          remove();
        });
      } else remove();
    });
  }

  return {
    serviceName: LS_SERVICE_NAME,
    syncConfig,
    inspect,
    lastRun,
    install,
    daemonStatus,
    installPackage(callback) {
      try { syncConfig(); } catch (snapshotError) { callback(snapshotError); return; }
      install(callback);
    },
    ensureRunning,
    startDaemon(callback) {
      try { syncConfig(); } catch (snapshotError) { callback(snapshotError); return; }
      ensureRunning(callback);
    },
    start(name, callback) {
      try {
        execControl('start', name);
        callback(null);
      } catch (controlError) {
        callback(controlError);
      }
    },
    stop(name, callback) {
      try {
        execControl('stop', name);
        callback(null);
      } catch (controlError) {
        callback(controlError);
      }
    },
    reload(name, callback) {
      try { execControl('reload', name); callback(null); } catch (controlError) { callback(controlError); }
    },
    refreshLog(name, callback) {
      try { execControl('refresh-log', name); callback(null); } catch (controlError) { callback(controlError); }
    },
    clearOverrun(name, callback) {
      try { execControl('clear-overrun', name); callback(null); } catch (controlError) { callback(controlError); }
    },
    stopDaemon(callback) {
      controllerStatus(controller, (_unused, state) => {
        if (state.statusError || ['NOT_INSTALLED', 'STOPPED', 'FAILED'].includes(state.controllerState)) { callback(state.statusError || null); return; }
        controller.stop(LS_SERVICE_NAME, callback);
      });
    },
    activeNames() { return readActiveJobs(files.active); },
    overview,
    reloadAllActive(callback) {
      let names;
      try { names = readActiveJobs(files.active); this.syncConfig(); } catch (snapshotError) { callback(snapshotError); return; }
      // A saved active-job checkpoint survives a package/service stop. In that
      // state there is no daemon to reload, and the new snapshot must merely
      // be ready for the next package start rather than causing an accidental
      // service start from a Database profile edit.
      daemonStatus((_unused, state) => {
        if (state.statusError) { callback(state.statusError); return; }
        if (!['RUNNING', 'STARTING'].includes(state.controllerState)) {
          callback(null, { names, reloaded: false });
          return;
        }
        let index = 0;
        const next = (reloadError) => {
          if (reloadError || index >= names.length) { callback(reloadError || null, { names, reloaded: true }); return; }
          const name = names[index]; index += 1;
          this.reload(name, next);
        };
        next(null);
      });
    },
    uninstall,
  };
}

module.exports = {
  ACTIVE_FILE,
  BINARY_FILE,
  LS_SERVICE_NAME,
  RUNTIME_FILE,
  SECRET_FILE,
  SNAPSHOT_FILE,
  createLsRuntime,
  readActiveJobs,
  runtimePaths,
};
