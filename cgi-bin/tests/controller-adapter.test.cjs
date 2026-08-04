'use strict';

const assert = require('node:assert/strict');
const { createControllerAdapter } = require('../src/service/controller-adapter.js');

function call(target, method, ...args) {
  return new Promise((resolve, reject) => target[method](...args, (error, value) => {
    if (error) reject(error);
    else resolve(value);
  }));
}

async function run() {
  const calls = [];
  let instances = 0;
  const serviceModule = {
    Client: class FakeClient {
      constructor() {
        instances += 1;
        this.details = {
          get(name, key, callback) {
            calls.push(['details.get', name, key]);
            callback(null, { details: { lastRun: { status: 'success' } } });
          },
        };
      }

      status(name, callback) { calls.push(['status', name]); callback(null, { status: 'STOPPED' }); }

      install(config, callback) { calls.push(['install', config]); callback(null, { status: 'STOPPED' }); }

      start(name, callback) { calls.push(['start', name]); callback(null, { status: 'RUNNING' }); }

      stop(name, callback) { calls.push(['stop', name]); callback(null, { status: 'STOPPED' }); }

      uninstall(name, callback) { calls.push(['uninstall', name]); callback(null); }
    },
  };
  const adapter = createControllerAdapter(serviceModule);
  assert.equal(instances, 1);
  assert.deepEqual(await call(adapter, 'status', '_dbu_alpha'), { status: 'STOPPED' });
  await call(adapter, 'install', { name: '_dbu_alpha' });
  await call(adapter, 'start', '_dbu_alpha');
  await call(adapter, 'stop', '_dbu_alpha');
  await call(adapter, 'uninstall', '_dbu_alpha');
  assert.deepEqual(await call(adapter, 'details', '_dbu_alpha', 'lastRun'), { status: 'success' });
  assert.deepEqual(calls.map((entry) => entry[0]), [
    'status', 'install', 'start', 'stop', 'uninstall', 'details.get',
  ]);

  const unavailable = createControllerAdapter({});
  await assert.rejects(call(unavailable, 'status', '_dbu_alpha'), /Client/);

  const noHistory = createControllerAdapter({
    Client: class NoHistoryClient {
      constructor() {
        this.details = {
          get(_name, _key, callback) {
            callback(new Error("Detail 'lastRun' not found for service '_dbu_alpha'."));
          },
        };
      }
    },
  });
  assert.equal(await call(noHistory, 'details', '_dbu_alpha', 'lastRun'), null);
}

run().then(() => console.log('Controller Client adapter: ok')).catch((failure) => {
  console.error(failure);
  process.exitCode = 1;
});
