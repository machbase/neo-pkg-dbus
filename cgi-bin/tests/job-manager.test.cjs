'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  JobManager,
  SERVICE_PREFIX,
} = require('../src/jobs/manager.js');
const { startWorker } = require('../worker.js');
const originalScript = process.argv[1];
process.argv[1] = path.resolve(__dirname, '../../scripts/install.js');
const { createLifecycle } = require('../../scripts/lifecycle.js');
process.argv[1] = originalScript;
const counterPath = path.resolve(__dirname, '../src/example/counter.js');
const { CounterStore } = require(
  fs.existsSync(counterPath)
    ? counterPath
    : path.resolve(__dirname, '../../../../template-common/cgi-bin/src/example/counter.js'),
);

function fakeService() {
  const states = new Map();
  const failures = new Map();
  const installConfigs = [];
  let startCalls = 0;
  let stopCalls = 0;
  return {
    states,
    failures,
    installConfigs,
    get startCalls() { return startCalls; },
    get stopCalls() { return stopCalls; },
    install(config, callback) {
      installConfigs.push({ ...config });
      states.set(config.name, config.enable ? 'RUNNING' : 'STOPPED');
      callback(null);
    },
    status(name, callback) {
      if (failures.has(name)) {
        callback(new Error(failures.get(name)));
        return;
      }
      if (!states.has(name)) {
        callback(new Error('service not found'));
        return;
      }
      callback(null, { name, status: states.get(name) });
    },
    start(name, callback) {
      startCalls += 1;
      states.set(name, 'RUNNING');
      callback(null);
    },
    stop(name, callback) {
      stopCalls += 1;
      if (states.has(name)) states.set(name, 'STOPPED');
      callback(null);
    },
    uninstall(name, callback) {
      states.delete(name);
      failures.delete(name);
      callback(null);
    },
  };
}

function call(manager, method, ...args) {
  return new Promise((resolve, reject) => {
    manager[method](...args, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function callbackResult(manager, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      manager[method](...args, (error, data) => resolve({ error, data }));
    } catch (error) {
      reject(new Error(`콜백으로 전달되어야 할 오류가 동기로 throw되었습니다: ${error.message}`));
    }
  });
}

function createInChild(managerPath, cgiRoot) {
  const program = `
    const fs = require('node:fs');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function(file, data, options) {
      if (String(file).endsWith('/alpha.json')) throw new Error('writeFileSync must not reserve jobs');
      return originalWrite.call(fs, file, data, options);
    };
    const { JobManager } = require(${JSON.stringify(managerPath)});
    let installed = false;
    const service = {
      status(_name, callback) {
        if (installed) callback(null, { status: 'RUNNING' });
        else callback(new Error('service not found'));
      },
      install(config, callback) {
        installed = true;
        setTimeout(() => callback(null), 30);
      },
    };
    const manager = new JobManager({ service, cgiRoot: ${JSON.stringify(cgiRoot)} });
    manager.create({ name: 'alpha' }, (error) => {
      process.stdout.write(error ? 'ERR:' + error.message : 'OK');
      process.exitCode = error ? 2 : 0;
    });
  `;
  return new Promise((resolve) => {
    childProcess.execFile(
      process.execPath,
      ['-e', program],
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

function counterModulePath() {
  const generatedPath = path.resolve(__dirname, '..', 'src', 'example', 'counter.js');
  if (fs.existsSync(generatedPath)) return generatedPath;
  return path.resolve(
    __dirname,
    '..', '..', '..', '..', 'template-common', 'cgi-bin', 'src', 'example', 'counter.js',
  );
}

function createCgiHarness(temporary) {
  const sourceRoot = path.resolve(__dirname, '..');
  const cgiRoot = path.join(temporary, 'cgi-bin');
  fs.cpSync(sourceRoot, cgiRoot, { recursive: true });
  const generatedCounterPath = path.join(cgiRoot, 'src', 'example', 'counter.js');
  fs.mkdirSync(path.dirname(generatedCounterPath), { recursive: true });
  fs.copyFileSync(counterModulePath(), generatedCounterPath);
  const generatedControllerStatePath = path.join(
    cgiRoot,
    'src',
    'service',
    'controller-state.js',
  );
  fs.mkdirSync(path.dirname(generatedControllerStatePath), { recursive: true });
  const controllerStatePath = path.resolve(
    __dirname,
    '..', 'src', 'service', 'controller-state.js',
  );
  fs.copyFileSync(
    fs.existsSync(controllerStatePath)
      ? controllerStatePath
      : path.resolve(
        __dirname,
        '..', '..', '..', '..', 'template-common', 'cgi-bin', 'src', 'service', 'controller-state.js',
      ),
    generatedControllerStatePath,
  );
  const httpPath = path.join(cgiRoot, 'src', 'cgi', 'http.js');
  if (!fs.existsSync(httpPath)) {
    fs.mkdirSync(path.dirname(httpPath), { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', 'template-common', 'cgi-bin', 'src', 'cgi', 'http.js'),
      httpPath,
    );
  }

  const serviceModuleRoot = path.join(temporary, 'node_modules');
  const serviceModulePath = path.join(serviceModuleRoot, 'service', 'index.js');
  fs.mkdirSync(path.dirname(serviceModulePath), { recursive: true });
  fs.writeFileSync(serviceModulePath, `
    'use strict';
    const mode = process.env.JOBS_CGI_CONTROLLER_MODE;
    let state = null;
    function unavailable(callback) {
      if (mode === 'sync-unavailable') throw new Error('controller unavailable');
      if (mode === 'unavailable') {
        callback(new Error('controller unavailable'));
        return true;
      }
      return false;
    }
    module.exports = {
      status(name, callback) {
        if (unavailable(callback)) return;
        if (mode === 'unknown-null') {
          callback(null, null);
          return;
        }
        if (mode === 'unknown-empty') {
          callback(null, {});
          return;
        }
        if (mode === 'unknown-paused') {
          callback(null, { status: 'PAUSED' });
          return;
        }
        if (state === null) {
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
          return;
        }
        callback(null, { name, status: state });
      },
      install(config, callback) {
        if (!unavailable(callback)) {
          state = config.enable ? 'RUNNING' : 'STOPPED';
          callback(null);
        }
      },
      start(_name, callback) {
        if (!unavailable(callback)) {
          state = 'RUNNING';
          callback(null);
        }
      },
      stop(_name, callback) {
        if (!unavailable(callback)) {
          state = 'STOPPED';
          callback(null);
        }
      },
      uninstall(_name, callback) {
        if (!unavailable(callback)) {
          state = null;
          callback(null);
        }
      },
    };
  `, 'utf8');
  return { cgiRoot, serviceModuleRoot };
}

function runCgi(scriptPath, serviceModuleRoot, options) {
  const settings = options || {};
  const program = `
    const path = require('node:path');
    const environment = process.env;
    process.env = { ...environment, get: (name) => environment[name] };
    process.stdin.read = () => process.argv[2] || '';
    require(process.argv[1]);
  `;
  const result = childProcess.spawnSync(process.execPath, [
    '-e', program, scriptPath, settings.body || '',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: [serviceModuleRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      REQUEST_METHOD: settings.method,
      QUERY_STRING: settings.query || '',
      JOBS_CGI_CONTROLLER_MODE: settings.controllerMode || 'running',
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || (result.error && result.error.message) || `CGI가 ${result.status}로 끝났습니다.`);
  }
  const separator = '\r\n\r\n';
  const splitAt = result.stdout.indexOf(separator);
  if (splitAt < 0) throw new Error(`CGI 응답 헤더가 없습니다: ${result.stdout}`);
  const status = Number(/Status: (\d+)/.exec(result.stdout.slice(0, splitAt))[1]);
  return { status, payload: JSON.parse(result.stdout.slice(splitAt + separator.length)) };
}

async function run() {
  const noLockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-job-no-lock-'));
  try {
    const noLockManager = new JobManager({
      service: fakeService(),
      cgiRoot: noLockRoot,
    });
    const originalOpenSync = fs.openSync;
    fs.openSync = function rejectOperationLocks(file, ...args) {
      if (/\.operation\.lock(?:\.recovery)?$/.test(String(file))) {
        throw new Error(`Job operation lock을 만들면 안 됩니다: ${file}`);
      }
      return originalOpenSync.call(fs, file, ...args);
    };
    try {
      await call(noLockManager, 'create', { name: 'no-lock' });
      await call(noLockManager, 'delete', 'no-lock');
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(
      fs.readdirSync(noLockManager.jobDir).some((entry) => entry.includes('.operation.lock')),
      false,
    );
  } finally {
    fs.rmSync(noLockRoot, { recursive: true, force: true });
  }

  const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-job-race-'));
  try {
    const managerPath = path.resolve(__dirname, '../src/jobs/manager.js');
    const attempts = await Promise.all([
      createInChild(managerPath, raceRoot),
      createInChild(managerPath, raceRoot),
    ]);
    assert.equal(attempts.filter((result) => result.stdout === 'OK').length, 1);
    assert.equal(attempts.filter((result) => result.stdout.startsWith('ERR:')).length, 1);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(raceRoot, 'conf.d', 'jobs', 'alpha.json'), 'utf8'),
      ).name,
      'alpha',
    );
  } finally {
    fs.rmSync(raceRoot, { recursive: true, force: true });
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-job-test-'));
  try {
    const workerCalls = [];
    assert.throws(
      () => startWorker(path.join(temporary, 'alpha.json'), {
        document: { name: 'beta', config: { intervalMs: 1000 } },
        counter: {
          increment(name) { workerCalls.push(name); },
        },
        setInterval() {
          workerCalls.push('timer');
          return null;
        },
        clearInterval() {},
      }),
      /설정 파일 이름.*작업 이름.*일치/,
    );
    assert.deepEqual(workerCalls, []);

    const matchingWorker = startWorker(path.join(temporary, 'alpha.json'), {
      document: { name: 'alpha', config: { intervalMs: 1000 } },
      counter: {
        increment(name) { workerCalls.push(name); },
      },
      setInterval() {
        workerCalls.push('timer');
        return null;
      },
      clearInterval() {},
    });
    assert.equal(workerCalls[0], 'alpha');
    assert.equal(matchingWorker.intervalMs, 1000);
    matchingWorker.stop();

    const service = fakeService();
    const manager = new JobManager({
      service,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'conf.d', 'jobs'),
      dataDir: path.join(temporary, 'data'),
      workerPath: path.join(temporary, 'worker.js'),
    });

    assert.deepEqual(await call(manager, 'summary'), {
      scope: 'neo-pkg-dbus',
      total: 0,
      running: 0,
      errors: [],
      error_details: [],
    });

    const existingService = fakeService();
    const existingServiceManager = new JobManager({
      service: existingService,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'create-existing-service-jobs'),
      dataDir: path.join(temporary, 'create-existing-service-data'),
    });
    const existingServiceCounter = new CounterStore(
      path.join(temporary, 'create-existing-service-data'),
    );
    existingService.states.set(`${SERVICE_PREFIX}alpha`, 'STOPPED');
    existingServiceCounter.increment('alpha');
    const existingResult = existingServiceCounter.read('alpha');
    await assert.rejects(
      call(existingServiceManager, 'create', { name: 'alpha' }),
      (error) => error && error.kind === 'conflict',
      '설정이 없어도 같은 Controller 서비스가 있으면 create는 conflict여야 합니다.',
    );
    assert.equal(
      existingService.states.get(`${SERVICE_PREFIX}alpha`),
      'STOPPED',
      '기존 Controller 서비스는 create가 시작하거나 변경하면 안 됩니다.',
    );
    assert.equal(fs.existsSync(existingServiceManager.configPath('alpha')), false);
    assert.deepEqual(
      existingServiceCounter.read('alpha'),
      existingResult,
      '기존 서비스의 결과 파일도 create가 건드리면 안 됩니다.',
    );

    for (const [label, status] of [
      ['unknown', (_name, callback) => callback(null, { status: 'PAUSED' })],
      ['rpc-error', (_name, callback) => callback(new Error('controller unavailable'))],
    ]) {
      let installCalls = 0;
      const uncertainCreateManager = new JobManager({
        service: {
          status,
          install(_config, callback) {
            installCalls += 1;
            callback(null, { status: 'RUNNING' });
          },
        },
        cgiRoot: temporary,
        jobDir: path.join(temporary, `create-${label}-jobs`),
        dataDir: path.join(temporary, `create-${label}-data`),
      });
      await assert.rejects(
        call(uncertainCreateManager, 'create', { name: 'alpha' }),
        label === 'unknown' ? /PAUSED|UNKNOWN/ : /controller unavailable/,
        `Create 전 ${label} 상태는 중단해야 합니다.`,
      );
      assert.equal(installCalls, 0, `Create 전 ${label} 상태에서는 install을 호출하면 안 됩니다.`);
      assert.equal(fs.existsSync(uncertainCreateManager.configPath('alpha')), false);
    }

    const orphanResultService = fakeService();
    const orphanResultManager = new JobManager({
      service: orphanResultService,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'create-orphan-result-jobs'),
      dataDir: path.join(temporary, 'create-orphan-result-data'),
    });
    const orphanResultCounter = new CounterStore(
      path.join(temporary, 'create-orphan-result-data'),
    );
    orphanResultCounter.increment('alpha');
    await call(orphanResultManager, 'create', { name: 'alpha' });
    assert.equal(
      orphanResultCounter.read('alpha'),
      null,
      '새 create는 같은 이름의 고아 결과 count를 이어받으면 안 됩니다.',
    );

    const orphanResultRemovalFailure = new Error('orphan result removal failed');
    let removalFailureInstallCalls = 0;
    const removalFailureCounter = new CounterStore(
      path.join(temporary, 'create-result-removal-failure-data'),
    );
    removalFailureCounter.increment('alpha');
    const resultBeforeRemovalFailure = removalFailureCounter.read('alpha');
    removalFailureCounter.remove = () => { throw orphanResultRemovalFailure; };
    const removalFailureManager = new JobManager({
      service: {
        status(_name, callback) {
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
        },
        install(_config, callback) {
          removalFailureInstallCalls += 1;
          callback(null, { status: 'RUNNING' });
        },
      },
      counter: removalFailureCounter,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'create-result-removal-failure-jobs'),
      dataDir: path.join(temporary, 'create-result-removal-failure-data'),
    });
    await assert.rejects(
      call(removalFailureManager, 'create', { name: 'alpha' }),
      (error) => error === orphanResultRemovalFailure,
    );
    assert.equal(removalFailureInstallCalls, 0);
    assert.equal(fs.existsSync(removalFailureManager.configPath('alpha')), false);
    assert.deepEqual(removalFailureCounter.read('alpha'), resultBeforeRemovalFailure);

    let installBeforeFailureUninstallCalls = 0;
    const installBeforeFailureManager = new JobManager({
      service: {
        status(_name, callback) {
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
        },
        install(_config, callback) { callback(new Error('install request failed')); },
        uninstall(_name, callback) {
          installBeforeFailureUninstallCalls += 1;
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'create-install-before-failure-jobs'),
      dataDir: path.join(temporary, 'create-install-before-failure-data'),
    });
    await assert.rejects(
      call(installBeforeFailureManager, 'create', { name: 'alpha' }),
      /install request failed/,
    );
    assert.equal(
      installBeforeFailureUninstallCalls,
      0,
      'install이 실패한 요청은 소유하지 않은 서비스를 uninstall하면 안 됩니다.',
    );
    assert.equal(fs.existsSync(installBeforeFailureManager.configPath('alpha')), false);

    let startFailureInstalled = false;
    let startFailureUninstallCalls = 0;
    const startFailureManager = new JobManager({
      service: {
        status(_name, callback) {
          if (!startFailureInstalled) {
            const error = new Error('service not found');
            error.rpcCode = -32004;
            callback(error);
            return;
          }
          callback(null, { status: 'STOPPED' });
        },
        install(_config, callback) {
          startFailureInstalled = true;
          callback(null, { status: 'STOPPED' });
        },
        uninstall(_name, callback) {
          startFailureUninstallCalls += 1;
          startFailureInstalled = false;
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'create-start-failure-jobs'),
      dataDir: path.join(temporary, 'create-start-failure-data'),
    });
    await assert.rejects(
      call(startFailureManager, 'create', { name: 'alpha' }),
      /시작되지 않았|STOPPED/,
    );
    assert.equal(startFailureUninstallCalls, 1);
    assert.equal(startFailureInstalled, false);
    assert.equal(fs.existsSync(startFailureManager.configPath('alpha')), false);

    await call(manager, 'create', { name: 'alpha', config: { intervalMs: 1500 } });
    await call(manager, 'create', { name: 'beta' });
    assert.ok(service.states.has(`${SERVICE_PREFIX}alpha`));
    assert.equal(service.installConfigs.length, 2);
    assert.equal(service.installConfigs.every((config) => config.enable === true), true);
    assert.deepEqual(manager.readConfig('alpha').config, { intervalMs: 1500 });
    assert.deepEqual(manager.readConfig('beta').config, { intervalMs: 1000 });
    service.states.set(`${SERVICE_PREFIX}alpha`, 'STOPPED');
    const duplicateStartCalls = service.startCalls;
    await assert.rejects(
      call(manager, 'create', { name: 'alpha', config: { intervalMs: 1500 } }),
      (error) => error && error.kind === 'conflict',
      '같은 이름과 같은 설정의 create도 기존 Job을 다시 시작하지 않고 conflict여야 합니다.',
    );
    assert.equal(
      service.startCalls,
      duplicateStartCalls,
      '중지된 기존 Job에 create를 다시 보내도 start를 호출하면 안 됩니다.',
    );
    service.states.set(`${SERVICE_PREFIX}alpha`, 'RUNNING');
    await assert.rejects(
      call(manager, 'update', { name: 'alpha', config: { intervalMs: 2500 } }),
      /중지.*수정|수정.*중지/,
    );
    service.states.set(`${SERVICE_PREFIX}alpha`, 'STOPPED');
    await call(manager, 'update', { name: 'alpha', config: { intervalMs: 2500 } });
    assert.deepEqual(
      manager.readConfig('alpha').config,
      { intervalMs: 2500 },
      '멈춘 Job의 설정은 같은 이름을 유지한 채 바뀌어야 합니다.',
    );
    service.states.delete(`${SERVICE_PREFIX}alpha`);
    await call(manager, 'update', { name: 'alpha', config: { intervalMs: 2600 } });
    assert.deepEqual(
      manager.readConfig('alpha').config,
      { intervalMs: 2600 },
      'Controller에 등록되지 않은 Job은 설정을 고쳐 다시 시작할 수 있어야 합니다.',
    );
    for (const status of ['RUNNING', 'STARTING', 'STOPPING', 'FAILED', 'PAUSED']) {
      service.states.set(`${SERVICE_PREFIX}alpha`, status);
      const before = manager.readConfig('alpha');
      await assert.rejects(
        call(manager, 'update', { name: 'alpha', config: { intervalMs: 2700 } }),
        (error) => error
          && error.kind === 'conflict'
          && error.message.includes(status),
        `${status} 상태의 update는 현재 상태를 알려 주는 conflict여야 합니다.`,
      );
      assert.deepEqual(
        manager.readConfig('alpha'),
        before,
        `${status} 상태의 update 실패는 기존 설정을 보존해야 합니다.`,
      );
    }
    service.failures.set(`${SERVICE_PREFIX}alpha`, 'controller unavailable during update');
    await assert.rejects(
      call(manager, 'update', { name: 'alpha', config: { intervalMs: 2800 } }),
      (error) => error
        && error.kind === 'controller'
        && /controller unavailable/.test(error.message),
      'status RPC 실패의 update는 Controller 오류를 그대로 돌려줘야 합니다.',
    );
    assert.deepEqual(manager.readConfig('alpha').config, { intervalMs: 2600 });
    service.failures.delete(`${SERVICE_PREFIX}alpha`);
    service.states.set(`${SERVICE_PREFIX}alpha`, 'RUNNING');
    await assert.rejects(
      call(manager, 'update', { name: 'alpha', config: { intervalMs: 60001 } }),
      /intervalMs.*1000.*60000/,
    );
    await assert.rejects(
      call(manager, 'create', { name: 'invalid-interval', config: { intervalMs: 999 } }),
      /intervalMs.*1000.*60000/,
    );
    for (const action of ['start', 'stop', 'delete']) {
      const missing = await callbackResult(manager, action, 'missing-job');
      assert.equal(missing.error && missing.error.kind, 'not_found', `${action}의 없는 Job은 구조화된 not_found 오류여야 합니다.`);
      assert.match(missing.error && missing.error.message, /등록되지 않은 작업/, `${action}의 없는 Job 오류는 사용자가 이해할 수 있어야 합니다.`);
    }
    const missingUpdate = await callbackResult(
      manager,
      'update',
      { name: 'missing-job', config: { intervalMs: 1000 } },
    );
    assert.equal(missingUpdate.error && missingUpdate.error.kind, 'not_found');

    const originalStatSync = fs.statSync;
    const permissionFailure = new Error('config permission denied');
    permissionFailure.code = 'EACCES';
    fs.statSync = function statWithPermissionFailure(file, ...args) {
      if (file === manager.configPath('alpha')) throw permissionFailure;
      return originalStatSync.call(fs, file, ...args);
    };
    try {
      assert.throws(
        () => manager.requireConfigFile('alpha'),
        (error) => error === permissionFailure,
        '설정 파일 확인은 ENOENT가 아닌 파일 오류를 그대로 전달해야 합니다.',
      );
    } finally {
      fs.statSync = originalStatSync;
    }
    assert.throws(
      () => manager.requireConfigFile('missing-job'),
      (error) => error && error.kind === 'not_found',
      '없는 설정 파일만 구조화된 not_found 오류로 바꿔야 합니다.',
    );

    const counter = new CounterStore(path.join(temporary, 'data'));
    counter.increment('alpha');
    const alphaResult = (await call(manager, 'list')).find((job) => job.name === 'alpha').result;
    assert.equal(alphaResult.count, 1);
    assert.equal(typeof alphaResult.startedAt, 'string');
    assert.equal(typeof alphaResult.updatedAt, 'string');

    fs.writeFileSync(counter.resultPath('alpha'), '{not-json', 'utf8');
    const resultFailure = (await call(manager, 'list')).find((job) => job.name === 'alpha');
    assert.equal(resultFailure.status, 'RUNNING');
    assert.equal(resultFailure.running, true);
    assert.equal(resultFailure.result, null);
    assert.notEqual(resultFailure.resultError, '');
    const resultFailureSummary = await call(manager, 'summary');
    assert.equal(resultFailureSummary.errors.some((entry) => /alpha: 결과 오류:/.test(entry)), true);
    assert.equal(
      resultFailureSummary.error_details.some((entry) => entry.name === 'alpha' && entry.kind === 'result'),
      true,
      '손상된 결과 파일은 summary에도 result 오류로 나타나야 합니다.',
    );
    fs.unlinkSync(counter.resultPath('alpha'));
    counter.increment('alpha');

    const brokenJobDir = path.join(temporary, 'broken-list-jobs');
    const brokenDataDir = path.join(temporary, 'broken-list-data');
    const brokenService = fakeService();
    const brokenManager = new JobManager({
      service: brokenService,
      cgiRoot: temporary,
      jobDir: brokenJobDir,
      dataDir: brokenDataDir,
    });
    for (const name of ['failed', 'missing', 'rpc-failed', 'running']) {
      fs.writeFileSync(brokenManager.configPath(name), '{broken', 'utf8');
    }
    brokenService.states.set(`${SERVICE_PREFIX}running`, 'RUNNING');
    brokenService.states.set(`${SERVICE_PREFIX}failed`, 'FAILED');
    brokenService.failures.set(`${SERVICE_PREFIX}rpc-failed`, 'controller unavailable');
    const brokenCounter = new CounterStore(brokenDataDir);
    brokenCounter.increment('running');
    brokenCounter.increment('failed');
    fs.writeFileSync(brokenCounter.resultPath('failed'), '{broken-result', 'utf8');

    const brokenJobs = await call(brokenManager, 'list');
    const brokenRunning = brokenJobs.find((job) => job.name === 'running');
    assert.equal(brokenRunning.status, 'RUNNING');
    assert.equal(brokenRunning.running, true);
    assert.equal(brokenRunning.statusKnown, true);
    assert.equal(brokenRunning.registered, true);
    assert.equal(brokenRunning.errorKind, 'config');
    assert.match(brokenRunning.error, /JSON|Unexpected|position/i);
    assert.match(brokenRunning.configError, /JSON|Unexpected|position/i);
    assert.equal(brokenRunning.controllerError, '');
    assert.equal(brokenRunning.result.count, 1);

    const brokenRpc = brokenJobs.find((job) => job.name === 'rpc-failed');
    assert.equal(brokenRpc.status, 'ERROR');
    assert.equal(brokenRpc.running, false);
    assert.equal(brokenRpc.statusKnown, false);
    assert.match(brokenRpc.configError, /JSON|Unexpected|position/i);
    assert.match(brokenRpc.controllerError, /controller unavailable/);
    assert.equal(brokenRpc.errorKind, 'controller');
    assert.match(brokenRpc.error, /controller unavailable/);

    const brokenFailed = brokenJobs.find((job) => job.name === 'failed');
    assert.equal(brokenFailed.status, 'FAILED');
    assert.equal(brokenFailed.running, false);
    assert.equal(brokenFailed.statusKnown, true);
    assert.equal(brokenFailed.errorKind, 'controller');
    assert.match(brokenFailed.configError, /JSON|Unexpected|position/i);
    assert.match(brokenFailed.controllerError, /FAILED/);
    assert.match(brokenFailed.resultError, /JSON|Unexpected|position/i);

    const brokenMissing = brokenJobs.find((job) => job.name === 'missing');
    assert.equal(brokenMissing.status, 'NOT_INSTALLED');
    assert.equal(brokenMissing.running, false);
    assert.equal(brokenMissing.statusKnown, true);
    assert.equal(brokenMissing.registered, false);
    assert.equal(brokenMissing.errorKind, 'config');
    assert.match(brokenMissing.configError, /JSON|Unexpected|position/i);
    assert.equal(brokenMissing.controllerError, '');

    const brokenSummary = await call(brokenManager, 'summary');
    assert.equal(brokenSummary.total, 4);
    assert.equal(brokenSummary.running, 1);
    assert.deepEqual(
      brokenSummary.error_details.map(({ name, kind }) => `${name}:${kind}`),
      [
        'failed:config',
        'failed:controller',
        'failed:result',
        'missing:config',
        'rpc-failed:config',
        'rpc-failed:controller',
        'running:config',
      ],
      'summary는 설정, Controller, 결과 오류를 출처별로 모두 보존해야 합니다.',
    );
    await assert.rejects(
      call(brokenManager, 'runningNames'),
      /rpc-failed: controller unavailable/,
      'Controller 상태를 모를 때만 package stop을 막아야 합니다.',
    );
    brokenService.failures.delete(`${SERVICE_PREFIX}rpc-failed`);
    assert.deepEqual(
      await call(brokenManager, 'runningNames'),
      ['running'],
      '설정 오류, 알려진 FAILED, 미등록 서비스는 실행 중인 이름 수집을 막으면 안 됩니다.',
    );

    for (const staleState of ['RUNNING', 'STOPPED']) {
      const suffix = staleState.toLowerCase();
      const errorWithInfoManager = new JobManager({
        service: {
          status(_name, callback) {
            callback(new Error('controller unavailable with stale info'), {
              status: staleState,
            });
          },
        },
        cgiRoot: temporary,
        jobDir: path.join(temporary, `error-with-${suffix}-info-jobs`),
        dataDir: path.join(temporary, `error-with-${suffix}-info-data`),
      });
      fs.writeFileSync(
        errorWithInfoManager.configPath('alpha'),
        `${JSON.stringify({ name: 'alpha', config: { intervalMs: 1000 } }, null, 2)}\n`,
        'utf8',
      );

      const [errorWithInfoJob] = await call(errorWithInfoManager, 'list');
      assert.equal(errorWithInfoJob.status, 'ERROR');
      assert.equal(errorWithInfoJob.statusKnown, false);
      assert.equal(errorWithInfoJob.registered, null);
      assert.equal(errorWithInfoJob.running, false);
      assert.match(errorWithInfoJob.controllerError, /controller unavailable with stale info/);
      await assert.rejects(
        call(errorWithInfoManager, 'runningNames'),
        /alpha: controller unavailable with stale info/,
      );
    }

    const brokenControlService = fakeService();
    const brokenControlManager = new JobManager({
      service: brokenControlService,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'broken-control-jobs'),
      dataDir: path.join(temporary, 'broken-control-data'),
    });
    fs.writeFileSync(brokenControlManager.configPath('alpha'), '{broken', 'utf8');
    brokenControlService.states.set(`${SERVICE_PREFIX}alpha`, 'RUNNING');
    const brokenControlCounter = new CounterStore(path.join(temporary, 'broken-control-data'));
    brokenControlCounter.increment('alpha');
    await call(brokenControlManager, 'stop', 'alpha');
    assert.equal(brokenControlService.states.get(`${SERVICE_PREFIX}alpha`), 'STOPPED');
    await call(brokenControlManager, 'delete', 'alpha');
    assert.equal(brokenControlService.states.has(`${SERVICE_PREFIX}alpha`), false);
    assert.equal(fs.existsSync(brokenControlManager.configPath('alpha')), false);
    assert.equal(fs.existsSync(brokenControlCounter.resultPath('alpha')), false);

    await call(manager, 'start', 'alpha');
    assert.equal(service.startCalls, 0);
    await call(manager, 'stop', 'alpha');
    await call(manager, 'stop', 'alpha');
    assert.equal(
      service.stopCalls,
      1,
      '이미 멈춘 job을 다시 stop해도 Controller stop을 중복 호출하면 안 됩니다.',
    );
    await call(manager, 'start', 'alpha');
    assert.deepEqual(await call(manager, 'summary'), {
      scope: 'neo-pkg-dbus',
      total: 2,
      running: 2,
      errors: [],
      error_details: [],
    });

    service.failures.set(`${SERVICE_PREFIX}beta`, 'simulated status failure');
    const degraded = await call(manager, 'summary');
    assert.equal(degraded.total, 2);
    assert.equal(degraded.running, 1);
    assert.deepEqual(degraded.errors, ['beta: simulated status failure']);
    assert.deepEqual(degraded.error_details, [{
      name: 'beta',
      kind: 'controller',
      message: 'simulated status failure',
    }]);
    assert.equal(
      (await call(manager, 'list')).find((job) => job.name === 'beta').errorKind,
      'controller',
    );
    await assert.rejects(
      call(manager, 'runningNames'),
      /beta: simulated status failure/,
    );

    await call(manager, 'stop', 'alpha');
    service.failures.delete(`${SERVICE_PREFIX}beta`);
    service.states.set(`${SERVICE_PREFIX}beta`, 'FAILED');
    const failedJob = (await call(manager, 'list')).find((job) => job.name === 'beta');
    assert.equal(failedJob.running, false);
    assert.equal(failedJob.errorKind, 'controller');
    assert.match(failedJob.error, /FAILED/);
    const failedSummary = await call(manager, 'summary');
    assert.equal(failedSummary.errors.some((entry) => /beta:.*FAILED/.test(entry)), true);

    const contradictoryFailedManager = new JobManager({
      service: {
        status(_name, callback) {
          callback(null, { status: 'FAILED', running: true });
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'contradictory-failed-jobs'),
      dataDir: path.join(temporary, 'contradictory-failed-data'),
    });
    fs.writeFileSync(
      contradictoryFailedManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    const contradictoryFailed = (await call(contradictoryFailedManager, 'list'))[0];
    assert.equal(contradictoryFailed.status, 'FAILED');
    assert.equal(
      contradictoryFailed.running,
      false,
      '확실한 FAILED 상태는 모순된 running:true보다 우선해야 합니다.',
    );
    assert.equal(
      (await call(contradictoryFailedManager, 'summary')).running,
      0,
      'FAILED Job은 summary running에 포함하면 안 됩니다.',
    );
    assert.deepEqual(
      await call(contradictoryFailedManager, 'runningNames'),
      [],
      'FAILED Job은 package stop의 실행 중 목록에 포함하면 안 됩니다.',
    );

    let uncertainStatusInfo = {};
    let uncertainStopCalls = 0;
    const uncertainStatusManager = new JobManager({
      service: {
        status(_name, callback) { callback(null, uncertainStatusInfo); },
        stop(_name, callback) {
          uncertainStopCalls += 1;
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'uncertain-status-jobs'),
      dataDir: path.join(temporary, 'uncertain-status-data'),
    });
    fs.writeFileSync(
      uncertainStatusManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    const emptyStatusJob = (await call(uncertainStatusManager, 'list'))[0];
    assert.equal(emptyStatusJob.status, 'UNKNOWN');
    assert.equal(
      emptyStatusJob.statusKnown,
      false,
      '상태가 빠진 Controller 응답을 STOPPED로 믿으면 안 됩니다.',
    );
    assert.equal(emptyStatusJob.running, false);
    assert.equal(emptyStatusJob.registered, null);
    assert.equal(emptyStatusJob.errorKind, 'controller');
    assert.notEqual(emptyStatusJob.controllerError, '');
    assert.equal(
      (await call(uncertainStatusManager, 'summary')).error_details[0].kind,
      'controller',
    );
    await assert.rejects(
      call(uncertainStatusManager, 'runningNames'),
      /alpha:.*UNKNOWN/,
      '빈 Controller 상태에서는 package stop을 시작하면 안 됩니다.',
    );
    const uncertainStopCheckpoint = path.join(
      temporary,
      'uncertain-status-data',
      'package-stop-state.json',
    );
    const uncertainStopExitCodes = [];
    const originalUncertainStopExit = process.exit;
    process.exit = (code) => { uncertainStopExitCodes.push(code); };
    try {
      createLifecycle(uncertainStatusManager, uncertainStopCheckpoint).stop();
    } finally {
      process.exit = originalUncertainStopExit;
    }
    assert.deepEqual(uncertainStopExitCodes, [1]);
    assert.equal(uncertainStopCalls, 0);
    assert.equal(
      fs.existsSync(uncertainStopCheckpoint),
      false,
      '빈 Controller 상태의 package stop은 checkpoint도 만들면 안 됩니다.',
    );

    uncertainStatusInfo = null;
    const nullStatusJob = (await call(uncertainStatusManager, 'list'))[0];
    assert.equal(nullStatusJob.status, 'UNKNOWN');
    assert.equal(nullStatusJob.statusKnown, false);
    assert.equal(nullStatusJob.registered, null);
    assert.equal(nullStatusJob.errorKind, 'controller');
    assert.notEqual(nullStatusJob.controllerError, '');
    assert.equal(
      (await call(uncertainStatusManager, 'summary')).errors.length,
      1,
      'null Controller 상태를 정상 summary로 계산하면 안 됩니다.',
    );

    uncertainStatusInfo = { status: 'PAUSED' };
    const pausedStatusJob = (await call(uncertainStatusManager, 'list'))[0];
    assert.equal(pausedStatusJob.status, 'UNKNOWN');
    assert.equal(
      pausedStatusJob.statusKnown,
      false,
      '지원하지 않는 Controller 상태를 알려진 비실행 상태로 믿으면 안 됩니다.',
    );
    assert.equal(pausedStatusJob.registered, null);
    assert.equal(pausedStatusJob.errorKind, 'controller');
    assert.match(pausedStatusJob.controllerError, /PAUSED/);
    assert.equal(
      (await call(uncertainStatusManager, 'summary')).error_details[0].kind,
      'controller',
    );
    await assert.rejects(
      call(uncertainStatusManager, 'runningNames'),
      /alpha:.*PAUSED/,
      '알 수 없는 Controller 상태에서는 package stop을 시작하면 안 됩니다.',
    );

    uncertainStatusInfo = { running: true };
    const legacyRunningJob = (await call(uncertainStatusManager, 'list'))[0];
    assert.equal(
      legacyRunningJob.status,
      'RUNNING',
      '상태 문자열이 없는 옛 running:true 응답만 호환용 RUNNING으로 인정해야 합니다.',
    );
    assert.equal(legacyRunningJob.statusKnown, true);
    assert.equal(legacyRunningJob.registered, true);
    assert.equal(legacyRunningJob.running, true);

    let manualStartStatus = 'FAILED';
    let manualFailedStartCalls = 0;
    const manualFailedStartManager = new JobManager({
      service: {
        status(_name, callback) {
          callback(null, { status: manualStartStatus, running: true });
        },
        start(_name, callback) {
          manualFailedStartCalls += 1;
          manualStartStatus = 'RUNNING';
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'manual-failed-start-jobs'),
      dataDir: path.join(temporary, 'manual-failed-start-data'),
    });
    fs.writeFileSync(
      manualFailedStartManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    const manualFailedStart = await call(manualFailedStartManager, 'start', 'alpha');

    let checkpointStartStatus = 'FAILED';
    let checkpointFailedStartCalls = 0;
    const checkpointFailedStartManager = new JobManager({
      service: {
        status(_name, callback) {
          callback(null, { status: checkpointStartStatus, running: true });
        },
        start(_name, callback) {
          checkpointFailedStartCalls += 1;
          if (checkpointFailedStartCalls === 1) {
            callback(new Error('checkpoint start failed'));
            return;
          }
          checkpointStartStatus = 'RUNNING';
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'checkpoint-failed-start-jobs'),
      dataDir: path.join(temporary, 'checkpoint-failed-start-data'),
    });
    fs.writeFileSync(
      checkpointFailedStartManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    const failedStartCheckpointPath = path.join(
      temporary,
      'checkpoint-failed-start-data',
      'package-stop-state.json',
    );
    fs.writeFileSync(
      failedStartCheckpointPath,
      JSON.stringify({ names: ['alpha'], savedAt: new Date().toISOString() }),
    );
    const checkpointLifecycle = createLifecycle(
      checkpointFailedStartManager,
      failedStartCheckpointPath,
    );
    const checkpointExitCodes = [];
    const originalCheckpointExit = process.exit;
    process.exit = (code) => { checkpointExitCodes.push(code); };
    try {
      checkpointLifecycle.start();
      assert.equal(
        fs.existsSync(failedStartCheckpointPath),
        true,
        '실제 start 실패 뒤에는 checkpoint를 보존해야 합니다.',
      );
      checkpointLifecycle.start();
    } finally {
      process.exit = originalCheckpointExit;
    }

    assert.deepEqual(
      {
        manual: manualFailedStartCalls,
        checkpoint: checkpointFailedStartCalls,
      },
      { manual: 1, checkpoint: 2 },
      '명시된 FAILED 상태는 running:true여도 수동 start와 checkpoint 재시도에서 실제 start를 호출해야 합니다.',
    );
    assert.deepEqual(checkpointExitCodes, [1]);
    assert.equal(manualFailedStart.status, 'RUNNING');
    assert.equal(
      fs.existsSync(failedStartCheckpointPath),
      false,
      'checkpoint는 실제 start가 끝난 뒤에만 삭제해야 합니다.',
    );
    service.states.set(`${SERVICE_PREFIX}beta`, 'RUNNING');

    fs.writeFileSync(
      manager.configPath('mismatched'),
      JSON.stringify({ name: 'different', config: { intervalMs: 1000 } }),
    );
    await assert.rejects(
      call(manager, 'start', 'mismatched'),
      /파일 이름.*name|name.*파일 이름/,
    );
    fs.writeFileSync(
      manager.configPath('invalid-config'),
      JSON.stringify({ name: 'invalid-config', config: { intervalMs: 999 } }),
    );
    await assert.rejects(
      call(manager, 'start', 'invalid-config'),
      /intervalMs.*1000.*60000/,
    );
    fs.unlinkSync(manager.configPath('mismatched'));
    fs.unlinkSync(manager.configPath('invalid-config'));
    assert.deepEqual(await call(manager, 'runningNames'), ['beta']);
    assert.equal((await call(manager, 'summary')).running, 1);
    await call(manager, 'start', 'alpha');
    assert.equal(service.startCalls, 2);
    assert.equal((await call(manager, 'summary')).running, 2);

    service.states.delete(`${SERVICE_PREFIX}alpha`);
    await call(manager, 'start', 'alpha');
    assert.equal(service.states.get(`${SERVICE_PREFIX}alpha`), 'RUNNING');
    assert.equal(service.installConfigs.length, 3);

    await call(manager, 'delete', 'alpha');
    assert.equal(counter.read('alpha'), null);
    assert.equal(fs.existsSync(manager.configPath('alpha')), false);
    assert.equal(fs.existsSync(counter.resultPath('alpha')), false);
    await call(manager, 'delete', 'beta');
    assert.equal((await call(manager, 'list')).length, 0);

    fs.writeFileSync(
      manager.configPath('configured'),
      JSON.stringify({ name: 'configured', config: {} }),
    );
    await call(manager, 'installConfigured');
    assert.equal(service.states.get(`${SERVICE_PREFIX}configured`), 'RUNNING');
    const installedConfigured = service.installConfigs.length;
    await call(manager, 'installConfigured');
    assert.equal(service.installConfigs.length, installedConfigured);
    await call(manager, 'delete', 'configured');
    await assert.rejects(
      call(manager, 'delete', 'configured'),
      (error) => error && error.kind === 'not_found',
    );

    const missingService = {
      status(_name, callback) { callback(new Error('service not found')); },
      stop(_name, callback) { callback(new Error('service not found')); },
      uninstall(_name, callback) { callback(new Error('service not found')); },
    };
    const missingServiceManager = new JobManager({
      service: missingService,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'missing-service-jobs'),
      dataDir: path.join(temporary, 'missing-service-data'),
    });
    fs.writeFileSync(
      missingServiceManager.configPath('orphaned'),
      JSON.stringify({ name: 'orphaned', config: {} }),
    );
    const missingCounter = new CounterStore(path.join(temporary, 'missing-service-data'));
    missingCounter.increment('orphaned');
    await call(missingServiceManager, 'delete', 'orphaned');
    assert.equal(fs.existsSync(missingServiceManager.configPath('orphaned')), false);
    assert.equal(fs.existsSync(missingCounter.resultPath('orphaned')), false);

    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = function readdirWithFailure(directory, ...args) {
      if (directory === manager.jobDir) {
        const error = new Error('jobs directory permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReaddirSync.call(fs, directory, ...args);
    };
    try {
      await assert.rejects(
        call(manager, 'list'),
        /jobs directory permission denied/,
      );
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    for (const invalidConfigType of ['directory', 'symlink']) {
      let controllerCalls = 0;
      const invalidConfigManager = new JobManager({
        service: {
          status(_name, callback) {
            controllerCalls += 1;
            callback(null, { status: 'STOPPED' });
          },
          uninstall(_name, callback) {
            controllerCalls += 1;
            callback(null);
          },
        },
        cgiRoot: temporary,
        jobDir: path.join(temporary, `${invalidConfigType}-delete-jobs`),
        dataDir: path.join(temporary, `${invalidConfigType}-delete-data`),
      });
      const invalidConfigPath = invalidConfigManager.configPath('unsafe');
      if (invalidConfigType === 'directory') {
        fs.mkdirSync(invalidConfigPath);
      } else {
        const targetPath = path.join(temporary, 'symlink-delete-target.json');
        fs.writeFileSync(targetPath, JSON.stringify({ name: 'unsafe', config: {} }));
        fs.symlinkSync(targetPath, invalidConfigPath);
      }
      await assert.rejects(
        call(invalidConfigManager, 'delete', 'unsafe'),
        /일반 파일|regular file/i,
        `${invalidConfigType} config는 Delete 전에 거부해야 합니다.`,
      );
      assert.equal(
        controllerCalls,
        0,
        `${invalidConfigType} config는 Controller를 변경하기 전에 거부해야 합니다.`,
      );
      assert.equal(fs.lstatSync(invalidConfigPath).isFile(), false);
    }

    let retryableDeleteInstalled = true;
    const retryableDeleteCounter = new CounterStore(
      path.join(temporary, 'retryable-delete-data'),
    );
    const retryableDeleteManager = new JobManager({
      service: {
        status(_name, callback) {
          if (retryableDeleteInstalled) callback(null, { status: 'STOPPED' });
          else {
            const error = new Error('service not installed');
            error.rpcCode = -32004;
            callback(error);
          }
        },
        install(_config, callback) {
          retryableDeleteInstalled = true;
          callback(null, { status: 'RUNNING' });
        },
        stop(_name, callback) { callback(null); },
        uninstall(_name, callback) {
          retryableDeleteInstalled = false;
          callback(null);
        },
      },
      counter: retryableDeleteCounter,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'retryable-delete-jobs'),
      dataDir: path.join(temporary, 'retryable-delete-data'),
    });
    const retryableConfigPath = retryableDeleteManager.configPath('retryable');
    fs.writeFileSync(
      retryableConfigPath,
      JSON.stringify({ name: 'retryable', config: {} }),
    );
    retryableDeleteCounter.increment('retryable');
    const originalRetryableUnlinkSync = fs.unlinkSync;
    const configRemovalFailure = new Error('config removal failed');
    configRemovalFailure.code = 'EACCES';
    fs.unlinkSync = function failRetryableConfigRemoval(file, ...args) {
      if (file === retryableConfigPath) throw configRemovalFailure;
      return originalRetryableUnlinkSync.call(fs, file, ...args);
    };
    try {
      await assert.rejects(
        call(retryableDeleteManager, 'delete', 'retryable'),
        (error) => error === configRemovalFailure,
      );
    } finally {
      fs.unlinkSync = originalRetryableUnlinkSync;
    }
    assert.equal(
      fs.existsSync(retryableConfigPath),
      true,
      'config 삭제 실패 뒤에는 재시도할 설정을 보존해야 합니다.',
    );
    assert.equal(
      fs.existsSync(retryableDeleteCounter.resultPath('retryable')),
      true,
      'config 삭제 실패 뒤에는 결과도 보존해야 합니다.',
    );
    await call(retryableDeleteManager, 'delete', 'retryable');
    assert.equal(fs.existsSync(retryableConfigPath), false);
    assert.equal(
      fs.existsSync(retryableDeleteCounter.resultPath('retryable')),
      false,
      'NOT_INSTALLED 재시도는 남은 config와 result를 모두 정리해야 합니다.',
    );

    let cleanupWarningInstalled = true;
    const cleanupWarningCounter = new CounterStore(
      path.join(temporary, 'cleanup-warning-delete-data'),
    );
    const cleanupWarningManager = new JobManager({
      service: {
        status(_name, callback) {
          if (cleanupWarningInstalled) callback(null, { status: 'STOPPED' });
          else {
            const error = new Error('service not installed');
            error.rpcCode = -32004;
            callback(error);
          }
        },
        install(_config, callback) {
          cleanupWarningInstalled = true;
          callback(null, { status: 'RUNNING' });
        },
        uninstall(_name, callback) {
          cleanupWarningInstalled = false;
          callback(null);
        },
      },
      counter: cleanupWarningCounter,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'cleanup-warning-delete-jobs'),
      dataDir: path.join(temporary, 'cleanup-warning-delete-data'),
    });
    const cleanupWarningConfigPath = cleanupWarningManager.configPath('warning');
    const cleanupWarningResultPath = cleanupWarningCounter.resultPath('warning');
    fs.writeFileSync(
      cleanupWarningConfigPath,
      JSON.stringify({ name: 'warning', config: {} }),
    );
    cleanupWarningCounter.increment('warning');
    const resultRemovalFailure = new Error('result removal failed');
    resultRemovalFailure.code = 'EACCES';
    const originalCleanupWarningUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = function failResultRemoval(file, ...args) {
      if (file === cleanupWarningResultPath) throw resultRemovalFailure;
      return originalCleanupWarningUnlinkSync.call(fs, file, ...args);
    };
    let cleanupWarningResult;
    try {
      cleanupWarningResult = await call(cleanupWarningManager, 'delete', 'warning');
    } finally {
      fs.unlinkSync = originalCleanupWarningUnlinkSync;
    }
    assert.deepEqual(
      cleanupWarningResult,
      { name: 'warning', cleanupError: 'result removal failed' },
      'config 삭제 뒤 result 정리 실패는 경고를 담은 논리적 성공이어야 합니다.',
    );
    assert.equal(fs.existsSync(cleanupWarningConfigPath), false);
    assert.equal(
      fs.existsSync(cleanupWarningResultPath),
      true,
      '논리적 삭제 성공 뒤 정리하지 못한 오래된 result는 남아 있어야 합니다.',
    );
    await call(cleanupWarningManager, 'create', { name: 'warning' });
    assert.equal(
      cleanupWarningCounter.read('warning'),
      null,
      '같은 이름 Create는 오래된 result를 먼저 지워 0부터 다시 시작해야 합니다.',
    );

    const syncThrowManager = (service, suffix) => new JobManager({
      service,
      cgiRoot: temporary,
      jobDir: path.join(temporary, `sync-${suffix}-jobs`),
      dataDir: path.join(temporary, `sync-${suffix}-data`),
    });
    const syncStatusManager = syncThrowManager({
      status() { throw new Error('synchronous status failure'); },
    }, 'status');
    assert.match((await callbackResult(syncStatusManager, 'status', 'alpha')).error.message, /synchronous status failure/);

    const callbackThrowManager = syncThrowManager({
      status(_name, callback) { callback(null, { status: 'RUNNING' }); },
    }, 'callback-throw');
    const callbackFailure = new Error('jobs callback failure');
    assert.throws(
      () => callbackThrowManager.status('alpha', () => { throw callbackFailure; }),
      (error) => error === callbackFailure,
    );

    let createCallbackInstalled = false;
    const createCallbackManager = syncThrowManager({
      status(_name, callback) {
        if (createCallbackInstalled) {
          callback(null, { status: 'RUNNING' });
          return;
        }
        const error = new Error('service not found');
        error.rpcCode = -32004;
        callback(error);
      },
      install(_config, callback) {
        createCallbackInstalled = true;
        callback(null, { status: 'RUNNING' });
      },
    }, 'create-callback');
    const createMarker = new Error('create callback marker');
    let createCallbackCalls = 0;
    assert.throws(
      () => createCallbackManager.create({ name: 'alpha' }, () => {
        createCallbackCalls += 1;
        throw createMarker;
      }),
      (error) => error === createMarker,
    );
    assert.equal(createCallbackCalls, 1);
    assert.equal(fs.existsSync(createCallbackManager.configPath('alpha')), true);

    let synchronousStartCalls = 0;
    const startCallbackManager = syncThrowManager({
      status(_name, callback) { callback(null, { status: 'STOPPED' }); },
      start(_name, callback) {
        synchronousStartCalls += 1;
        callback(null);
      },
    }, 'start-callback');
    fs.writeFileSync(
      startCallbackManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    const startMarker = new Error('start callback marker');
    let startCallbackCalls = 0;
    assert.throws(
      () => startCallbackManager.start('alpha', () => {
        startCallbackCalls += 1;
        throw startMarker;
      }),
      (error) => error === startMarker,
    );
    assert.equal(startCallbackCalls, 1);
    assert.equal(synchronousStartCalls, 1);

    let deleteCallbackInstalled = true;
    const deleteCallbackManager = syncThrowManager({
      status(_name, callback) {
        if (deleteCallbackInstalled) callback(null, { status: 'STOPPED' });
        else callback(new Error('service not found'));
      },
      stop(_name, callback) { callback(null); },
      uninstall(_name, callback) {
        deleteCallbackInstalled = false;
        callback(null);
      },
    }, 'delete-callback');
    fs.writeFileSync(
      deleteCallbackManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    const deleteCallbackCounter = new CounterStore(path.join(temporary, 'sync-delete-callback-data'));
    deleteCallbackCounter.increment('alpha');
    const deleteMarker = new Error('delete callback marker');
    let deleteCallbackCalls = 0;
    assert.throws(
      () => deleteCallbackManager.delete('alpha', () => {
        deleteCallbackCalls += 1;
        throw deleteMarker;
      }),
      (error) => error === deleteMarker,
    );
    assert.equal(deleteCallbackCalls, 1);
    assert.equal(fs.existsSync(deleteCallbackManager.configPath('alpha')), false);
    assert.equal(fs.existsSync(deleteCallbackCounter.resultPath('alpha')), false);

    const syncInstallManager = syncThrowManager({
      status(_name, callback) {
        const error = new Error('service not found');
        error.rpcCode = -32004;
        callback(error);
      },
      install() { throw new Error('synchronous install failure'); },
    }, 'install');
    assert.match((await callbackResult(syncInstallManager, 'create', { name: 'alpha' })).error.message, /synchronous install failure/);

    const syncStartManager = syncThrowManager({
      status(_name, callback) { callback(null, { status: 'STOPPED' }); },
      start() { throw new Error('synchronous start failure'); },
    }, 'start');
    fs.writeFileSync(syncStartManager.configPath('alpha'), JSON.stringify({ name: 'alpha', config: {} }));
    assert.match((await callbackResult(syncStartManager, 'start', 'alpha')).error.message, /synchronous start failure/);

    let concurrentInstallStatusReads = 0;
    const concurrentInstallManager = syncThrowManager({
      status(_name, callback) {
        concurrentInstallStatusReads += 1;
        if (concurrentInstallStatusReads === 1) {
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
        } else {
          callback(null, { status: 'RUNNING' });
        }
      },
      install(_config, callback) { callback(new Error('service already exists')); },
    }, 'concurrent-install');
    fs.writeFileSync(
      concurrentInstallManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    assert.equal(
      (await call(concurrentInstallManager, 'start', 'alpha')).status,
      'RUNNING',
      'status와 install 사이에 다른 주체가 등록한 서비스는 상태 재조회로 성공 처리해야 합니다.',
    );

    let failedJobStartStatusReads = 0;
    const failedJobStartManager = syncThrowManager({
      status(_name, callback) {
        failedJobStartStatusReads += 1;
        callback(null, failedJobStartStatusReads === 1
          ? { status: 'STOPPED' }
          : { status: 'FAILED', error: 'job worker crashed after start' });
      },
      start(_name, callback) { callback(null); },
    }, 'failed-job-start');
    fs.writeFileSync(
      failedJobStartManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    await assert.rejects(call(failedJobStartManager, 'start', 'alpha'), (error) => error
      && error.kind === 'controller'
      && /job worker crashed after start|FAILED/.test(error.message));

    let failedJobStartDetailStatusReads = 0;
    const failedJobStartDetailManager = syncThrowManager({
      status(_name, callback) {
        failedJobStartDetailStatusReads += 1;
        callback(null, failedJobStartDetailStatusReads === 1
          ? { status: 'STOPPED' }
          : { status: 'FAILED', config: { start_error: 'worker crash' } });
      },
      start(_name, callback) { callback(null); },
    }, 'failed-job-start-detail');
    fs.writeFileSync(
      failedJobStartDetailManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    await assert.rejects(call(failedJobStartDetailManager, 'start', 'alpha'), (error) => error
      && error.kind === 'controller'
      && /worker crash/.test(error.message));

    for (const transitionalState of ['STARTING', 'STOPPING']) {
      let transitionalStartCalls = 0;
      const transitionalStartManager = syncThrowManager({
        status(_name, callback) { callback(null, { status: transitionalState }); },
        start(_name, callback) {
          transitionalStartCalls += 1;
          callback(null, { status: 'RUNNING' });
        },
      }, `start-${transitionalState.toLowerCase()}`);
      fs.writeFileSync(
        transitionalStartManager.configPath('alpha'),
        JSON.stringify({ name: 'alpha', config: {} }),
      );
      await assert.rejects(
        call(transitionalStartManager, 'start', 'alpha'),
        (error) => error
          && error.kind === 'controller'
          && error.message.includes(transitionalState),
      );
      assert.equal(
        transitionalStartCalls,
        0,
        `${transitionalState} 상태의 jobs Start는 service.start를 다시 호출하면 안 됩니다.`,
      );
    }

    let immediateJobStartStatusReads = 0;
    const immediateRunningJobStartManager = syncThrowManager({
      status(_name, callback) {
        immediateJobStartStatusReads += 1;
        callback(null, immediateJobStartStatusReads === 1
          ? { status: 'STOPPED' }
          : { status: 'FAILED', error: 'stale job detail' });
      },
      start(_name, callback) {
        callback(null, { status: 'RUNNING', error: 'old job failure detail' });
      },
    }, 'immediate-running-job-start');
    fs.writeFileSync(
      immediateRunningJobStartManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    assert.equal(
      (await call(immediateRunningJobStartManager, 'start', 'alpha')).status,
      'RUNNING',
    );
    assert.equal(
      immediateJobStartStatusReads,
      1,
      'jobs start 즉시 RUNNING이면 오래된 status/detail을 다시 읽으면 안 됩니다.',
    );

    const syncStopManager = syncThrowManager({
      status(_name, callback) { callback(null, { status: 'RUNNING' }); },
      stop() { throw new Error('synchronous stop failure'); },
    }, 'stop');
    fs.writeFileSync(syncStopManager.configPath('alpha'), JSON.stringify({ name: 'alpha', config: {} }));
    assert.match((await callbackResult(syncStopManager, 'stop', 'alpha')).error.message, /synchronous stop failure/);

    const stubbornStopManager = syncThrowManager({
      status(_name, callback) { callback(null, { status: 'RUNNING' }); },
      stop(_name, callback) { callback(null); },
    }, 'stubborn-stop');
    fs.writeFileSync(
      stubbornStopManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    await assert.rejects(call(stubbornStopManager, 'stop', 'alpha'), (error) => error
      && error.kind === 'controller'
      && /멈추지 않았|RUNNING/.test(error.message));

    let failedJobStopDetailStatusReads = 0;
    const failedJobStopDetailManager = syncThrowManager({
      status(_name, callback) {
        failedJobStopDetailStatusReads += 1;
        callback(null, failedJobStopDetailStatusReads === 1
          ? { status: 'RUNNING' }
          : { status: 'FAILED', config: { start_error: 'worker crash' } });
      },
      stop(_name, callback) { callback(null); },
    }, 'failed-job-stop-detail');
    fs.writeFileSync(
      failedJobStopDetailManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    await assert.rejects(call(failedJobStopDetailManager, 'stop', 'alpha'), (error) => error
      && error.kind === 'controller'
      && /worker crash/.test(error.message));

    let stoppingStatusReads = 0;
    const stoppingManager = syncThrowManager({
      status(_name, callback) {
        stoppingStatusReads += 1;
        callback(null, stoppingStatusReads === 1
          ? { status: 'RUNNING' }
          : { status: 'STOPPING' });
      },
      stop(_name, callback) { callback(null); },
    }, 'stopping');
    fs.writeFileSync(
      stoppingManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    await assert.rejects(call(stoppingManager, 'stop', 'alpha'), (error) => error
      && error.kind === 'controller'
      && /멈추지 않았|STOPPING/.test(error.message));

    let deleteStatusReads = 0;
    let earlyJobUninstallCalls = 0;
    const stoppingDeleteManager = syncThrowManager({
      status(_name, callback) {
        deleteStatusReads += 1;
        callback(null, deleteStatusReads === 1
          ? { status: 'RUNNING' }
          : { status: 'STOPPING' });
      },
      stop(_name, callback) { callback(null); },
      uninstall(_name, callback) {
        earlyJobUninstallCalls += 1;
        callback(null);
      },
    }, 'stopping-delete');
    fs.writeFileSync(
      stoppingDeleteManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    await assert.rejects(
      call(stoppingDeleteManager, 'delete', 'alpha'),
      /멈추지 않았|STOPPING/,
    );
    assert.equal(
      earlyJobUninstallCalls,
      0,
      'job이 STOPPING이면 uninstall을 먼저 호출하면 안 됩니다.',
    );

    for (const transitionalState of ['STARTING', 'STOPPING']) {
      let installed = true;
      let currentState = transitionalState;
      const deleteOrder = [];
      const transitionalDeleteDataDir = path.join(
        temporary,
        `delete-${transitionalState.toLowerCase()}-success-data`,
      );
      const transitionalDeleteCounter = new CounterStore(transitionalDeleteDataDir);
      const transitionalDeleteManager = new JobManager({
        service: {
          status(_name, callback) {
            if (!installed) {
              deleteOrder.push('status:NOT_INSTALLED');
              const error = new Error('service not installed');
              error.rpcCode = -32004;
              callback(error);
              return;
            }
            deleteOrder.push(`status:${currentState}`);
            callback(null, { status: currentState });
          },
          stop(_name, callback) {
            deleteOrder.push('stop');
            currentState = 'STOPPED';
            callback(null);
          },
          uninstall(_name, callback) {
            deleteOrder.push('uninstall');
            installed = false;
            callback(null);
          },
        },
        counter: transitionalDeleteCounter,
        cgiRoot: temporary,
        jobDir: path.join(
          temporary,
          `delete-${transitionalState.toLowerCase()}-success-jobs`,
        ),
        dataDir: transitionalDeleteDataDir,
      });
      const transitionalConfigPath = transitionalDeleteManager.configPath('alpha');
      const transitionalResultPath = transitionalDeleteCounter.resultPath('alpha');
      fs.writeFileSync(
        transitionalConfigPath,
        JSON.stringify({ name: 'alpha', config: {} }),
      );
      transitionalDeleteCounter.increment('alpha');
      const originalTransitionalUnlinkSync = fs.unlinkSync;
      fs.unlinkSync = function recordTransitionalDelete(file, ...args) {
        if (file === transitionalConfigPath) deleteOrder.push('config-delete');
        if (file === transitionalResultPath) deleteOrder.push('result-delete');
        return originalTransitionalUnlinkSync.call(fs, file, ...args);
      };
      try {
        await call(transitionalDeleteManager, 'delete', 'alpha');
      } finally {
        fs.unlinkSync = originalTransitionalUnlinkSync;
      }
      assert.deepEqual(
        deleteOrder,
        [
          `status:${transitionalState}`,
          `status:${transitionalState}`,
          'stop',
          'status:STOPPED',
          'uninstall',
          'status:NOT_INSTALLED',
          'config-delete',
          'result-delete',
        ],
        `${transitionalState} Delete는 전환 확인 뒤 config와 result 순서로 삭제해야 합니다.`,
      );
    }

    for (const state of ['FAILED', 'STOPPED', 'STARTING', 'STOPPING']) {
      let installed = true;
      let currentState = state;
      const calls = [];
      const cleanupManager = syncThrowManager({
        status(_name, callback) {
          if (installed) callback(null, { status: currentState });
          else {
            const error = new Error('service not found');
            error.rpcCode = -32004;
            callback(error);
          }
        },
        stop(_name, callback) {
          calls.push('stop');
          currentState = 'STOPPED';
          callback(null);
        },
        uninstall(_name, callback) {
          calls.push('uninstall');
          installed = false;
          callback(null);
        },
      }, `cleanup-${state.toLowerCase()}`);
      const cleanupCounter = new CounterStore(
        path.join(temporary, `sync-cleanup-${state.toLowerCase()}-data`),
      );
      cleanupCounter.increment('alpha');
      await call(cleanupManager, 'cleanupRegistration', 'alpha');
      assert.deepEqual(
        calls,
        state === 'FAILED' || state === 'STOPPED'
          ? ['uninstall']
          : ['stop', 'uninstall'],
        `cleanupRegistration은 ${state} 상태표에 맞는 순서로 정리해야 합니다.`,
      );
      assert.equal(fs.existsSync(cleanupCounter.resultPath('alpha')), false);
    }

    let failedDeleteInstalled = true;
    let failedDeleteStatus = 'FAILED';
    let failedDeleteStopCalls = 0;
    let failedDeleteUninstallCalls = 0;
    const failedDeleteManager = syncThrowManager({
      status(_name, callback) {
        if (failedDeleteInstalled) {
          callback(null, {
            status: failedDeleteStatus,
            error: failedDeleteStatus === 'FAILED' ? 'worker crashed' : '',
          });
        } else {
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
        }
      },
      install(_config, callback) {
        failedDeleteInstalled = true;
        failedDeleteStatus = 'RUNNING';
        callback(null, { status: 'RUNNING' });
      },
      stop(_name, callback) {
        failedDeleteStopCalls += 1;
        callback(new Error('FAILED service cannot stop'));
      },
      uninstall(_name, callback) {
        failedDeleteUninstallCalls += 1;
        failedDeleteInstalled = false;
        callback(null);
      },
    }, 'failed-delete');
    fs.writeFileSync(
      failedDeleteManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
    );
    const failedDeleteCounter = new CounterStore(
      path.join(temporary, 'sync-failed-delete-data'),
    );
    failedDeleteCounter.increment('alpha');
    await call(failedDeleteManager, 'delete', 'alpha');
    assert.equal(failedDeleteStopCalls, 0, 'FAILED delete는 stop 성공을 기다리면 안 됩니다.');
    assert.equal(failedDeleteUninstallCalls, 1, 'FAILED delete는 바로 uninstall해야 합니다.');
    assert.equal(fs.existsSync(failedDeleteManager.configPath('alpha')), false);
    assert.equal(fs.existsSync(failedDeleteCounter.resultPath('alpha')), false);
    await call(failedDeleteManager, 'create', { name: 'alpha' });
    assert.equal(
      fs.existsSync(failedDeleteManager.configPath('alpha')),
      true,
      'FAILED Job을 삭제한 뒤에는 같은 이름을 새로 create할 수 있어야 합니다.',
    );

    for (const [label, statusService] of [
      ['unknown', {
        status(_name, callback) { callback(null, {}); },
        stop(_name, callback) { callback(null); },
        uninstall(_name, callback) { callback(null); },
      }],
      ['rpc-failure', {
        status(_name, callback) { callback(new Error('controller unavailable during delete')); },
        stop(_name, callback) { callback(null); },
        uninstall(_name, callback) { callback(null); },
      }],
    ]) {
      const uncertainDeleteManager = syncThrowManager(statusService, `delete-${label}`);
      fs.writeFileSync(
        uncertainDeleteManager.configPath('alpha'),
        JSON.stringify({ name: 'alpha', config: {} }),
      );
      await assert.rejects(
        call(uncertainDeleteManager, 'delete', 'alpha'),
        (error) => (label === 'unknown'
          ? error
            && error.kind === 'controller'
            && /UNKNOWN|알 수 없는/.test(error.message)
          : /controller unavailable/.test(error && error.message)),
        `${label} 상태의 delete는 실패해야 합니다.`,
      );
      assert.equal(
        fs.existsSync(uncertainDeleteManager.configPath('alpha')),
        true,
        `${label} 상태를 확실히 알 수 없으면 설정을 보존해야 합니다.`,
      );
    }

    const syncUninstallManager = syncThrowManager({
      status(_name, callback) { callback(null, { status: 'STOPPED' }); },
      stop(_name, callback) { callback(null); },
      uninstall() { throw new Error('synchronous uninstall failure'); },
    }, 'uninstall');
    fs.writeFileSync(syncUninstallManager.configPath('alpha'), JSON.stringify({ name: 'alpha', config: {} }));
    assert.match((await callbackResult(syncUninstallManager, 'delete', 'alpha')).error.message, /synchronous uninstall failure/);

    const brokenLifecycleService = fakeService();
    const brokenLifecycleManager = new JobManager({
      service: brokenLifecycleService,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'broken-lifecycle-jobs'),
      dataDir: path.join(temporary, 'broken-lifecycle-data'),
    });
    await call(brokenLifecycleManager, 'create', { name: 'alpha' });
    const brokenLifecycleStatePath = path.join(
      temporary,
      'broken-lifecycle-data',
      'package-stop-state.json',
    );
    const brokenLifecycle = createLifecycle(brokenLifecycleManager, brokenLifecycleStatePath);
    fs.writeFileSync(brokenLifecycleManager.configPath('alpha'), '{broken', 'utf8');
    brokenLifecycle.stop();
    assert.equal(
      brokenLifecycleService.states.get(`${SERVICE_PREFIX}alpha`),
      'STOPPED',
      'package stop은 설정이 깨진 Job도 Controller에서 멈춰야 합니다.',
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(brokenLifecycleStatePath, 'utf8')).names,
      ['alpha'],
      'package stop checkpoint는 서비스를 멈춘 뒤에도 이름을 보존해야 합니다.',
    );
    const originalBrokenLifecycleExit = process.exit;
    process.exit = () => {};
    try {
      brokenLifecycle.start();
    } finally {
      process.exit = originalBrokenLifecycleExit;
    }
    assert.equal(
      brokenLifecycleService.states.get(`${SERVICE_PREFIX}alpha`),
      'STOPPED',
      '설정이 깨진 package start는 서비스를 시작하면 안 됩니다.',
    );
    assert.equal(
      fs.existsSync(brokenLifecycleStatePath),
      true,
      '설정이 깨진 package start 실패 뒤 checkpoint를 보존해야 합니다.',
    );
    fs.writeFileSync(
      brokenLifecycleManager.configPath('alpha'),
      JSON.stringify({ name: 'alpha', config: {} }),
      'utf8',
    );
    brokenLifecycle.start();
    assert.equal(brokenLifecycleService.states.get(`${SERVICE_PREFIX}alpha`), 'RUNNING');
    assert.equal(fs.existsSync(brokenLifecycleStatePath), false);
    fs.writeFileSync(brokenLifecycleManager.configPath('alpha'), '{broken', 'utf8');
    brokenLifecycleManager.counter.increment('alpha');
    brokenLifecycle.uninstall();
    assert.equal(
      brokenLifecycleService.states.has(`${SERVICE_PREFIX}alpha`),
      false,
      'package uninstall은 설정이 깨진 Job도 Controller에서 제거해야 합니다.',
    );
    assert.equal(fs.existsSync(brokenLifecycleManager.configPath('alpha')), false);
    assert.equal(
      fs.existsSync(brokenLifecycleManager.counter.resultPath('alpha')),
      false,
      'package uninstall은 설정이 깨진 Job 결과도 제거해야 합니다.',
    );

    const successfulUninstallStatePath = path.join(
      temporary,
      'successful-uninstall-state.json',
    );
    fs.writeFileSync(
      successfulUninstallStatePath,
      JSON.stringify({ names: ['alpha', 'beta'], savedAt: new Date().toISOString() }),
    );
    const successfullyDeletedNames = [];
    const successfulUninstallLifecycle = createLifecycle({
      list(callback) {
        callback(null, [{ name: 'alpha' }, { name: 'beta' }]);
      },
      delete(name, callback) {
        successfullyDeletedNames.push(name);
        callback(null, { name });
      },
    }, successfulUninstallStatePath);
    successfulUninstallLifecycle.uninstall();
    assert.deepEqual(successfullyDeletedNames, ['alpha', 'beta']);
    assert.equal(
      fs.existsSync(successfulUninstallStatePath),
      false,
      '모든 Delete가 성공한 package uninstall은 checkpoint를 제거해야 합니다.',
    );

    const partialUninstallStatePath = path.join(
      temporary,
      'partial-uninstall-state.json',
    );
    fs.writeFileSync(
      partialUninstallStatePath,
      JSON.stringify({ names: ['alpha', 'beta'], savedAt: new Date().toISOString() }),
    );
    const partialUninstallLifecycle = createLifecycle({
      list(callback) {
        callback(null, [{ name: 'alpha' }, { name: 'beta' }]);
      },
      delete(name, callback) {
        callback(name === 'beta' ? new Error('partial delete failure') : null, { name });
      },
    }, partialUninstallStatePath);
    const originalPartialUninstallExit = process.exit;
    process.exit = () => {};
    try {
      partialUninstallLifecycle.uninstall();
    } finally {
      process.exit = originalPartialUninstallExit;
    }
    assert.equal(
      fs.existsSync(partialUninstallStatePath),
      true,
      '일부 Delete가 실패한 package uninstall은 checkpoint를 보존해야 합니다.',
    );

    let installCalls = 0;
    const lifecycle = createLifecycle({
      jobDir: path.join(temporary, 'lifecycle-jobs'),
      dataDir: path.join(temporary, 'lifecycle-data'),
      installConfigured(callback) {
        installCalls += 1;
        callback(null, ['example']);
      },
    }, path.join(temporary, 'lifecycle-state.json'));
    lifecycle.install();
    assert.equal(installCalls, 1);

    const lifecycleStatePath = path.join(temporary, 'retry-lifecycle-state.json');
    let runningPass = 0;
    let stopPass = 0;
    let startPass = 0;
    const retryLifecycle = createLifecycle({
      jobDir: path.join(temporary, 'retry-lifecycle-jobs'),
      dataDir: path.join(temporary, 'retry-lifecycle-data'),
      runningNames(callback) {
        runningPass += 1;
        callback(null, runningPass === 1 ? ['alpha', 'beta'] : ['beta']);
      },
      stop(name, callback) {
        if (stopPass === 0 && name === 'beta') {
          stopPass += 1;
          callback(new Error('partial stop failure'));
          return;
        }
        callback(null);
      },
      list(callback) {
        callback(null, [{ name: 'alpha' }, { name: 'beta' }]);
      },
      start(name, callback) {
        if (startPass === 0 && name === 'beta') {
          startPass += 1;
          callback(new Error('partial start failure'));
          return;
        }
        callback(null);
      },
    }, lifecycleStatePath);
    const originalExit = process.exit;
    process.exit = () => {};
    try {
      retryLifecycle.stop();
      retryLifecycle.stop();
      assert.deepEqual(
        JSON.parse(fs.readFileSync(lifecycleStatePath, 'utf8')).names,
        ['alpha', 'beta'],
        '부분 stop 실패 뒤 재시도해도 최초 실행 목록을 보존해야 합니다.',
      );
      retryLifecycle.start();
      assert.equal(
        fs.existsSync(lifecycleStatePath),
        true,
        '부분 start 실패 뒤에는 다음 재시도를 위해 checkpoint를 남겨야 합니다.',
      );
      retryLifecycle.start();
      assert.equal(
        fs.existsSync(lifecycleStatePath),
        false,
        '모든 서비스가 시작된 뒤에만 checkpoint를 삭제해야 합니다.',
      );

      const atomicStatePath = path.join(temporary, 'atomic-lifecycle-state.json');
      fs.writeFileSync(
        atomicStatePath,
        JSON.stringify({ names: ['already-stopped'], savedAt: '2026-07-28T00:00:00.000Z' }),
      );
      const atomicLifecycle = createLifecycle({
        runningNames(callback) { callback(null, ['newly-running']); },
        stop(_name, callback) { callback(null); },
      }, atomicStatePath);
      const originalWriteFileSync = fs.writeFileSync;
      const originalWriteSync = fs.writeSync;
      fs.writeFileSync = function simulatedInterruptedWrite(file, data, options) {
        if (String(file).startsWith(atomicStatePath)) {
          originalWriteFileSync.call(fs, file, '{', options);
          throw new Error('simulated checkpoint interruption');
        }
        return originalWriteFileSync.call(fs, file, data, options);
      };
      fs.writeSync = function simulatedInterruptedAtomicWrite(descriptor, data, ...args) {
        if (String(data).includes('"savedAt"')) {
          originalWriteSync.call(fs, descriptor, '{');
          throw new Error('simulated checkpoint interruption');
        }
        return originalWriteSync.call(fs, descriptor, data, ...args);
      };
      try {
        assert.throws(
          () => atomicLifecycle.stop(),
          /simulated checkpoint interruption/,
        );
      } finally {
        fs.writeFileSync = originalWriteFileSync;
        fs.writeSync = originalWriteSync;
      }
      assert.deepEqual(
        JSON.parse(fs.readFileSync(atomicStatePath, 'utf8')).names,
        ['already-stopped'],
        'checkpoint 저장 실패가 이전 정상 파일을 손상하면 안 됩니다.',
      );

      const corruptStatePath = path.join(temporary, 'corrupt-lifecycle-state.json');
      fs.writeFileSync(corruptStatePath, '{broken', 'utf8');
      const startedFromCorruptCheckpoint = [];
      const corruptLifecycle = createLifecycle({
        list(callback) { callback(null, [{ name: 'must-stay-stopped' }]); },
        start(name, callback) {
          startedFromCorruptCheckpoint.push(name);
          callback(null);
        },
      }, corruptStatePath);
      corruptLifecycle.start();
      assert.deepEqual(
        startedFromCorruptCheckpoint,
        [],
        '손상된 checkpoint를 무시하고 모든 job을 시작하면 안 됩니다.',
      );
      assert.equal(
        fs.existsSync(corruptStatePath),
        true,
        '손상된 checkpoint는 진단과 복구를 위해 보존해야 합니다.',
      );

      const deletedStatePath = path.join(temporary, 'deleted-lifecycle-state.json');
      fs.writeFileSync(
        deletedStatePath,
        JSON.stringify({ names: ['deleted-job'], savedAt: new Date().toISOString() }),
      );
      const startedAfterDelete = [];
      const deletedLifecycle = createLifecycle({
        list(callback) { callback(null, [{ name: 'remaining-job' }]); },
        start(name, callback) {
          startedAfterDelete.push(name);
          callback(name === 'deleted-job' ? new Error('deleted job') : null);
        },
      }, deletedStatePath);
      deletedLifecycle.start();
      assert.deepEqual(
        startedAfterDelete,
        [],
        'checkpoint에만 남은 삭제된 작업은 다시 시작하면 안 됩니다.',
      );
      assert.equal(fs.existsSync(deletedStatePath), false);
    } finally {
      process.exit = originalExit;
    }

    let failedInstalled = false;
    let failedStatus = 'STOPPED';
    const failedManager = new JobManager({
      service: {
        install(_config, callback) {
          failedInstalled = true;
          failedStatus = 'RUNNING';
          callback(null, { status: 'FAILED', error: 'worker crashed' });
        },
        status(_name, callback) {
          if (!failedInstalled) {
            const error = new Error('service not installed');
            error.rpcCode = -32004;
            callback(error);
          } else {
            callback(null, { status: failedStatus });
          }
        },
        stop(_name, callback) {
          failedStatus = 'STOPPED';
          callback(null);
        },
        uninstall(_name, callback) {
          failedInstalled = false;
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'failed-jobs'),
      dataDir: path.join(temporary, 'failed-data'),
    });
    await assert.rejects(
      call(failedManager, 'create', { name: 'failed-job' }),
      /worker crashed|FAILED/i,
    );

    let initialCleanupInstallCalls = 0;
    const initialCleanupManager = new JobManager({
      service: {
        status(_name, callback) {
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
        },
        install(_config, callback) {
          initialCleanupInstallCalls += 1;
          callback(null, { status: 'RUNNING' });
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'initial-config-cleanup-jobs'),
      dataDir: path.join(temporary, 'initial-config-cleanup-data'),
    });
    const initialCleanupPath = initialCleanupManager.configPath('initial-cleanup');
    const initialWriteError = new Error('initial config write failed');
    const initialUnlinkError = new Error('initial config cleanup permission denied');
    initialUnlinkError.code = 'EACCES';
    const originalInitialWriteSync = fs.writeSync;
    const originalInitialUnlinkSync = fs.unlinkSync;
    fs.writeSync = function failInitialConfigWrite(descriptor, data, ...args) {
      if (String(data).includes('"name": "initial-cleanup"')) throw initialWriteError;
      return originalInitialWriteSync.call(fs, descriptor, data, ...args);
    };
    fs.unlinkSync = function failInitialConfigCleanup(file, ...args) {
      if (file === initialCleanupPath) throw initialUnlinkError;
      return originalInitialUnlinkSync.call(fs, file, ...args);
    };
    let initialCleanupResult;
    try {
      initialCleanupResult = await callbackResult(
        initialCleanupManager,
        'create',
        { name: 'initial-cleanup' },
      );
    } finally {
      fs.writeSync = originalInitialWriteSync;
      fs.unlinkSync = originalInitialUnlinkSync;
    }

    let compensatedInstalled = false;
    const compensatedCleanupManager = new JobManager({
      service: {
        install(_config, callback) {
          compensatedInstalled = true;
          callback(null, { status: 'FAILED', error: 'registration failed' });
        },
        status(_name, callback) {
          if (compensatedInstalled) callback(null, { status: 'STOPPED' });
          else {
            const error = new Error('service not installed');
            error.rpcCode = -32004;
            callback(error);
          }
        },
        uninstall(_name, callback) {
          compensatedInstalled = false;
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'compensated-config-cleanup-jobs'),
      dataDir: path.join(temporary, 'compensated-config-cleanup-data'),
    });
    const compensatedCleanupPath = compensatedCleanupManager.configPath('compensated-cleanup');
    const compensatedUnlinkError = new Error('compensated config cleanup permission denied');
    compensatedUnlinkError.code = 'EACCES';
    const originalCompensatedUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = function failCompensatedConfigCleanup(file, ...args) {
      if (file === compensatedCleanupPath) throw compensatedUnlinkError;
      return originalCompensatedUnlinkSync.call(fs, file, ...args);
    };
    let compensatedCleanupResult;
    try {
      compensatedCleanupResult = await callbackResult(
        compensatedCleanupManager,
        'create',
        { name: 'compensated-cleanup' },
      );
    } finally {
      fs.unlinkSync = originalCompensatedUnlinkSync;
    }

    assert.deepEqual(
      {
        initialCleanupError: initialCleanupResult.error
          && initialCleanupResult.error.cleanupError,
        initialRecoveryGuidance: /설정을 보존.*start.*delete/i.test(
          String(initialCleanupResult.error && initialCleanupResult.error.message),
        ),
        compensatedCleanupError: compensatedCleanupResult.error
          && compensatedCleanupResult.error.cleanupError,
        compensatedRecoveryGuidance: /설정을 보존.*start.*delete/i.test(
          String(compensatedCleanupResult.error && compensatedCleanupResult.error.message),
        ),
      },
      {
        initialCleanupError: 'initial config cleanup permission denied',
        initialRecoveryGuidance: true,
        compensatedCleanupError: 'compensated config cleanup permission denied',
        compensatedRecoveryGuidance: true,
      },
      'config unlink 실패는 두 create 정리 경로에서 cleanupError와 복구 안내를 보존해야 합니다.',
    );
    assert.equal(initialCleanupResult.error, initialWriteError);
    assert.equal(initialCleanupInstallCalls, 0);
    assert.equal(fs.existsSync(initialCleanupPath), true);
    assert.match(initialCleanupResult.error.message, /initial config write failed/);
    assert.equal(compensatedInstalled, false);
    assert.equal(fs.existsSync(compensatedCleanupPath), true);
    assert.match(compensatedCleanupResult.error.message, /registration failed/);

    let orphanInstalled = false;
    let orphanInstallShouldFail = true;
    const orphaningService = {
      status(_name, callback) {
        if (orphanInstalled) callback(null, { status: 'RUNNING' });
        else callback(new Error('service not found'));
      },
      install(_config, callback) {
        orphanInstalled = true;
        if (orphanInstallShouldFail) {
          orphaningManager.counter.increment('orphan-install');
          callback(null, { status: 'FAILED', error: 'worker executable missing' });
        } else {
          callback(null, { status: 'RUNNING' });
        }
      },
      stop(_name, callback) {
        orphanInstalled = false;
        callback(null);
      },
      uninstall(_name, callback) {
        orphanInstalled = false;
        callback(null);
      },
    };
    const orphaningManager = new JobManager({
      service: orphaningService,
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'orphan-install-jobs'),
      dataDir: path.join(temporary, 'orphan-install-data'),
    });
    await assert.rejects(
      call(orphaningManager, 'create', { name: 'orphan-install' }),
      /worker executable missing/,
    );
    assert.equal(
      orphanInstalled,
      false,
      'install이 FAILED 서비스를 남겨도 create가 stop/uninstall로 보상해야 합니다.',
    );
    assert.equal(
      fs.existsSync(orphaningManager.configPath('orphan-install')),
      false,
    );
    assert.equal(
      orphaningManager.counter.read('orphan-install'),
      null,
      '등록 실패 중 만들어진 카운터 결과도 보상 정리해야 합니다.',
    );
    orphanInstallShouldFail = false;
    await call(orphaningManager, 'create', { name: 'orphan-install' });
    assert.equal(orphanInstalled, true);
    await call(orphaningManager, 'delete', 'orphan-install');

    let earlyCleanupUninstallCalls = 0;
    let stoppingCleanupInstalled = false;
    const stoppingCleanupManager = new JobManager({
      service: {
        install(_config, callback) {
          stoppingCleanupInstalled = true;
          callback(null, { status: 'FAILED', error: 'failed while starting' });
        },
        status(_name, callback) {
          if (stoppingCleanupInstalled) {
            callback(null, { status: 'STOPPING' });
            return;
          }
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
        },
        stop(_name, callback) { callback(null); },
        uninstall(_name, callback) {
          earlyCleanupUninstallCalls += 1;
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'stopping-cleanup-jobs'),
      dataDir: path.join(temporary, 'stopping-cleanup-data'),
    });
    await assert.rejects(
      call(stoppingCleanupManager, 'create', { name: 'stopping-cleanup' }),
      /보상 정리 실패|STOPPING/,
    );
    assert.equal(
      earlyCleanupUninstallCalls,
      0,
      '등록 실패 서비스가 STOPPING이면 uninstall을 먼저 호출하면 안 됩니다.',
    );
    assert.equal(
      fs.existsSync(stoppingCleanupManager.configPath('stopping-cleanup')),
      true,
      '등록 실패 보상 정리가 끝나지 않으면 재시도용 설정을 보존해야 합니다.',
    );

    let lingeringCleanupUninstallCalls = 0;
    let lingeringCleanupInstalled = false;
    const lingeringCleanupManager = new JobManager({
      service: {
        install(_config, callback) {
          lingeringCleanupInstalled = true;
          callback(null, { status: 'FAILED', error: 'failed registration' });
        },
        status(_name, callback) {
          if (lingeringCleanupInstalled) {
            callback(null, { status: 'STOPPED' });
            return;
          }
          const error = new Error('service not found');
          error.rpcCode = -32004;
          callback(error);
        },
        stop(_name, callback) { callback(null); },
        uninstall(_name, callback) {
          lingeringCleanupUninstallCalls += 1;
          callback(null);
        },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'lingering-cleanup-jobs'),
      dataDir: path.join(temporary, 'lingering-cleanup-data'),
    });
    await assert.rejects(
      call(lingeringCleanupManager, 'create', { name: 'lingering-cleanup' }),
      /보상 정리 실패|제거되지 않았/,
    );
    assert.equal(lingeringCleanupUninstallCalls, 1);
    assert.equal(
      fs.existsSync(lingeringCleanupManager.configPath('lingering-cleanup')),
      true,
      'uninstall 응답 뒤 서비스가 남아 있으면 설정을 보존해야 합니다.',
    );

    let retryControllerAvailable = false;
    let retryCreateInstalled = false;
    const retryAfterCleanupFailure = new JobManager({
      service: {
        status(_name, callback) {
          if (!retryControllerAvailable && retryCreateInstalled) {
            callback(new Error('controller unavailable'));
            return;
          }
          const error = new Error('service not installed');
          error.rpcCode = -32004;
          callback(error);
        },
        install(_config, callback) {
          if (retryControllerAvailable) {
            callback(null, { status: 'RUNNING' });
            return;
          }
          retryCreateInstalled = true;
          callback(null, { status: 'STOPPED' });
        },
        stop(_name, callback) { callback(new Error('controller unavailable')); },
        uninstall(_name, callback) { callback(new Error('controller unavailable')); },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'retry-create-jobs'),
      dataDir: path.join(temporary, 'retry-create-data'),
    });
    await assert.rejects(
      call(retryAfterCleanupFailure, 'create', { name: 'retry-create' }),
      /설정을 보존.*start.*delete/i,
    );
    assert.equal(
      fs.existsSync(retryAfterCleanupFailure.configPath('retry-create')),
      true,
      '보상 정리 실패 시 start/delete 복구를 위해 설정을 보존해야 합니다.',
    );
    await assert.rejects(
      call(retryAfterCleanupFailure, 'create', { name: 'retry-create' }),
      (error) => error && error.kind === 'conflict',
      '보상 정리 실패 뒤 설정이 남았으면 같은 create도 conflict여야 합니다.',
    );
    retryControllerAvailable = true;
    const recoveredStart = await call(
      retryAfterCleanupFailure,
      'start',
      'retry-create',
    );
    assert.equal(recoveredStart.name, 'retry-create');
    assert.equal(recoveredStart.status, 'RUNNING');
    assert.equal(
      fs.existsSync(failedManager.configPath('failed-job')),
      false,
      '실패한 서비스 등록은 이번 요청이 만든 설정을 남기면 안 됩니다.',
    );
    await assert.rejects(
      call(failedManager, 'create', { name: 'failed-job' }),
      /worker crashed|FAILED/i,
    );

    const stopFailureManager = new JobManager({
      service: {
        status(_name, callback) { callback(null, { status: 'RUNNING' }); },
        stop(_name, callback) { callback(new Error('stop failed')); },
        uninstall(_name, callback) { callback(null); },
      },
      cgiRoot: temporary,
      jobDir: path.join(temporary, 'stop-failure-jobs'),
      dataDir: path.join(temporary, 'stop-failure-data'),
    });
    fs.writeFileSync(
      stopFailureManager.configPath('blocked'),
      JSON.stringify({ name: 'blocked', config: {} }),
    );
    await assert.rejects(
      call(stopFailureManager, 'delete', 'blocked'),
      /stop failed/,
    );
    assert.equal(fs.existsSync(stopFailureManager.configPath('blocked')), true);

    const cgi = createCgiHarness(path.join(temporary, 'cgi-harness'));
    const endpoint = (name) => path.join(cgi.cgiRoot, 'api', 'jobs', `${name}.js`);
    const createGet = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'GET', body: JSON.stringify({ name: 'alpha' }),
    });
    assert.equal(createGet.status, 405);
    assert.equal(createGet.payload.ok, false);
    const invalidCreate = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'POST', body: '{}',
    });
    assert.equal(invalidCreate.status, 400);
    const unavailableCreate = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'POST', body: JSON.stringify({ name: 'alpha-unavailable' }), controllerMode: 'unavailable',
    });
    assert.equal(unavailableCreate.status, 503);
    assert.equal(unavailableCreate.payload.ok, false);
    const synchronousUnavailableCreate = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'POST', body: JSON.stringify({ name: 'alpha-sync-unavailable' }), controllerMode: 'sync-unavailable',
    });
    assert.equal(synchronousUnavailableCreate.status, 503);
    assert.equal(synchronousUnavailableCreate.payload.ok, false);
    const created = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'POST', body: JSON.stringify({ name: 'alpha' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.payload.ok, true);
    const invalidConfigDuplicateConflict = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'POST', body: JSON.stringify({ name: 'alpha', config: { intervalMs: 999 } }),
    });
    assert.equal(invalidConfigDuplicateConflict.status, 409);
    assert.equal(invalidConfigDuplicateConflict.payload.kind, 'conflict');
    const sameConfigDuplicateConflict = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'POST', body: JSON.stringify({ name: 'alpha' }),
    });
    assert.equal(sameConfigDuplicateConflict.status, 409);
    assert.equal(sameConfigDuplicateConflict.payload.kind, 'conflict');
    const duplicateConflict = await runCgi(endpoint('create'), cgi.serviceModuleRoot, {
      method: 'POST', body: JSON.stringify({ name: 'alpha', config: { intervalMs: 2000 } }),
    });
    assert.equal(duplicateConflict.status, 409);
    assert.equal(duplicateConflict.payload.kind, 'conflict');

    for (const controllerMode of ['unknown-null', 'unknown-empty', 'unknown-paused']) {
      const health = await runCgi(
        path.join(cgi.cgiRoot, 'api', 'health.js'),
        cgi.serviceModuleRoot,
        { method: 'GET', controllerMode },
      );
      assert.equal(health.status, 200);
      assert.equal(health.payload.data.healthy, false);
      assert.equal(health.payload.data.status, 'degraded');
      assert.equal(health.payload.data.service_summary.error_details[0].kind, 'controller');
      assert.notEqual(health.payload.data.service_summary.error_details[0].message, '');
    }

    const unknownDelete = await runCgi(endpoint('delete'), cgi.serviceModuleRoot, {
      method: 'POST', query: 'name=alpha', controllerMode: 'unknown-empty',
    });
    assert.equal(unknownDelete.status, 503);
    assert.equal(unknownDelete.payload.ok, false);
    assert.equal(unknownDelete.payload.kind, 'controller');
    assert.equal(
      fs.existsSync(path.join(cgi.cgiRoot, 'conf.d', 'jobs', 'alpha.json')),
      true,
      'UNKNOWN Delete CGI는 설정 파일을 보존해야 합니다.',
    );

    for (const action of ['start', 'stop', 'delete']) {
      const wrongMethod = await runCgi(endpoint(action), cgi.serviceModuleRoot, {
        method: 'GET', query: 'name=alpha',
      });
      assert.equal(wrongMethod.status, 405, `${action}는 GET을 허용하면 안 됩니다.`);
      const invalidName = await runCgi(endpoint(action), cgi.serviceModuleRoot, {
        method: 'POST', query: 'name=INVALID',
      });
      assert.equal(invalidName.status, 400, `${action}의 잘못된 입력은 4xx여야 합니다.`);
      const unavailable = await runCgi(endpoint(action), cgi.serviceModuleRoot, {
        method: 'POST', query: 'name=alpha', controllerMode: 'sync-unavailable',
      });
      assert.equal(unavailable.status, 503, `${action}의 Controller 오류는 503이어야 합니다.`);
      assert.equal(unavailable.payload.ok, false);
      assert.equal(unavailable.payload.kind, 'controller');
      const missing = await runCgi(endpoint(action), cgi.serviceModuleRoot, {
        method: 'POST', query: 'name=missing-job',
      });
      assert.equal(missing.status, 404, `${action}의 없는 Job은 404여야 합니다.`);
      assert.equal(missing.payload.kind, 'not_found');
    }
    const started = await runCgi(endpoint('start'), cgi.serviceModuleRoot, {
      method: 'POST',
      query: 'name=alpha',
    });
    assert.equal(started.status, 200);
    assert.deepEqual(started.payload.data, {
      name: 'alpha',
      status: 'RUNNING',
    });
    const stopped = await runCgi(endpoint('stop'), cgi.serviceModuleRoot, {
      method: 'POST',
      query: 'name=alpha',
    });
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.payload.data, {
      name: 'alpha',
      status: 'STOPPED',
    });
    const deleted = await runCgi(endpoint('delete'), cgi.serviceModuleRoot, {
      method: 'POST', query: 'name=alpha',
    });
    assert.equal(deleted.status, 200);

    console.log('jobs profile lifecycle and health aggregation: ok');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
