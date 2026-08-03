"use strict";

const fs = require('fs');
const path = require('path');
const process = require('process');
const root = path.resolve(path.dirname(process.argv[1]), '..');
const cgiRoot = path.join(root, 'cgi-bin');
const { JobManager } = require(path.join(cgiRoot, 'src', 'jobs', 'manager.js'));

function print(message) {
  if (console.println) console.println(message);
  else console.log(message);
}

function fail(error) {
  print(`[ERROR] ${error && error.message ? error.message : String(error)}`);
  if (process.exit) process.exit(1);
}

function eachSeries(names, action, done) {
  let index = 0;
  const next = (error) => {
    if (error) {
      done(error);
      return;
    }
    if (index >= names.length) {
      done(null);
      return;
    }
    const name = names[index];
    index += 1;
    action(name, next);
  };
  next(null);
}

function createLifecycle(manager, statePath) {
  function readSavedNames() {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!state || !Array.isArray(state.names)) {
        throw new Error(`잘못된 package stop checkpoint입니다: ${statePath}`);
      }
      return state.names;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function writeSavedNames(names) {
    const unique = [...new Set(names)].sort();
    const temporaryPath = `${statePath}.${process.pid || 0}.${Date.now()}.tmp`;
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx');
      fs.writeSync(
        descriptor,
        `${JSON.stringify({ names: unique, savedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, statePath);
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch (_) {}
      }
      try { fs.unlinkSync(temporaryPath); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    return unique;
  }

  function install() {
    fs.mkdirSync(manager.jobDir, { recursive: true });
    fs.mkdirSync(manager.dataDir, { recursive: true });
    manager.installConfigured((error, names) => {
      if (error) return fail(error);
      print(`[INFO] registered and started ${names.length} configured job service(s)`);
    });
  }

  function stop() {
    manager.runningNames((error, running) => {
      if (error) return fail(error);
      let saved;
      try {
        saved = readSavedNames() || [];
      } catch (readError) {
        fail(readError);
        return;
      }
      writeSavedNames([...saved, ...running]);
      eachSeries(running, (name, next) => manager.stop(name, next), (stopError) => {
        if (stopError) return fail(stopError);
        print(`[INFO] stopped ${running.length} job service(s)`);
      });
    });
  }

  function start() {
    manager.list((error, jobs) => {
      if (error) return fail(error);
      let names = jobs.map((job) => job.name);
      try {
        const saved = readSavedNames();
        if (saved) {
          const configured = new Set(names);
          names = saved.filter((name) => configured.has(name));
        }
      } catch (readError) {
        fail(readError);
        return;
      }
      eachSeries(names, (name, next) => manager.start(name, next), (startError) => {
        if (startError) return fail(startError);
        try { fs.unlinkSync(statePath); } catch (error) {
          if (!error || error.code !== 'ENOENT') return fail(error);
        }
        print(`[INFO] started ${names.length} job service(s)`);
      });
    });
  }

  function uninstall() {
    manager.list((error, jobs) => {
      if (error) return fail(error);
      const names = jobs.map((job) => job.name);
      eachSeries(names, (name, next) => manager.delete(name, next), (deleteError) => {
        if (deleteError) return fail(deleteError);
        try { fs.unlinkSync(statePath); } catch (error) {
          if (!error || error.code !== 'ENOENT') return fail(error);
        }
        print(`[INFO] uninstalled ${names.length} job service(s)`);
      });
    });
  }

  return { install, start, stop, uninstall };
}

const manager = new JobManager({ cgiRoot });
const statePath = path.join(cgiRoot, 'data', 'package-stop-state.json');
module.exports = { ...createLifecycle(manager, statePath), createLifecycle };
