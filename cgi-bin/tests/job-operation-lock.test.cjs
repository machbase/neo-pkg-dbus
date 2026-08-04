'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJobOperationLock } = require('../src/jobs/operation-lock.js');

function errorCode(code) {
  return (failure) => {
    assert.equal(failure.code, code);
    return true;
  };
}

function makeTimers() {
  const callbacks = new Set();
  return {
    callbacks,
    setInterval(callback) {
      callbacks.add(callback);
      return callback;
    },
    clearInterval(callback) {
      callbacks.delete(callback);
    },
  };
}

function makeLockHarness(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const timers = makeTimers();
  let clock = Date.now();
  return {
    directory,
    timers,
    now: () => clock,
    advance(milliseconds = 30001) {
      clock += milliseconds;
    },
    settings(extra) {
      return {
        directory,
        leaseMs: 30000,
        now: () => clock,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isProcessAlive: () => false,
        ...(extra || {}),
      };
    },
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('같은 Job 잠금은 충돌하고 해제한 뒤 다음 owner가 획득한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      heartbeatMs: 5000,
      now: () => Date.now(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => true,
      randomToken: () => tokens.shift(),
    });

    const first = locks.acquire('alpha');
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    assert.doesNotThrow(() => first.assertOwned());
    first.release();

    const second = locks.acquire('alpha');
    assert.equal(second.token, 'owner-b');
    second.release();
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(timers.callbacks.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JSH readdirSync가 .과 ..를 돌려줘도 lock 정리를 끝낸다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-dot-entries-'));
  const timers = makeTimers();
  const jshFs = {
    ...fs,
    readdirSync(target) {
      return [...fs.readdirSync(target), '.', '..'];
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: jshFs,
      directory,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      randomToken: () => 'owner-a',
    });
    const handle = locks.acquire('alpha');
    assert.doesNotThrow(() => handle.release());
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale fence의 중첩 availability probe는 둘 다 읽기만 하고 통과한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-probe-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'probe-owner'];
  let clock = Date.now();
  let ownerAlive = true;
  let locks;
  let traceMutations = false;
  let nestedProbeStarted = false;
  const createdDirectories = [];
  const renames = [];
  const lockDirectory = path.join(directory, 'package-lifecycle.lock');
  const tracedFs = {
    ...fs,
    statSync(target) {
      if (traceMutations && target === lockDirectory && !nestedProbeStarted) {
        nestedProbeStarted = true;
        assert.doesNotThrow(() => locks.assertAvailable('package-lifecycle'));
      }
      return fs.statSync(target);
    },
    mkdirSync(target, options) {
      if (traceMutations) createdDirectories.push(target);
      return fs.mkdirSync(target, options);
    },
    renameSync(source, destination) {
      if (traceMutations) renames.push([source, destination]);
      return fs.renameSync(source, destination);
    },
  };
  try {
    locks = createJobOperationLock({
      fs: tracedFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => ownerAlive,
      randomToken: () => tokens.shift(),
    });

    assert.doesNotThrow(() => locks.assertAvailable('package-lifecycle'));
    assert.deepEqual(fs.readdirSync(directory), [], 'lock 부재 probe는 파일을 만들면 안 됩니다.');

    const owner = locks.acquire('package-lifecycle');
    assert.throws(() => locks.assertAvailable('package-lifecycle'), errorCode('JOB_CONFLICT'));
    clock += 30001;
    ownerAlive = false;
    traceMutations = true;
    assert.doesNotThrow(() => locks.assertAvailable('package-lifecycle'));
    traceMutations = false;

    assert.equal(nestedProbeStarted, true);
    assert.deepEqual(createdDirectories, []);
    assert.deepEqual(renames, []);
    assert.deepEqual(fs.readdirSync(directory), ['package-lifecycle.lock']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8')).token, 'owner-a');
    assert.deepEqual(tokens, ['probe-owner'], 'probe는 임시 owner token을 소비하면 안 됩니다.');

    owner.release();
    assert.equal(timers.callbacks.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('이전 owner의 release는 새 owner 잠금을 삭제하지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-owner-'));
  const timers = makeTimers();
  try {
    const locks = createJobOperationLock({
      directory,
      now: () => Date.now(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      randomToken: () => 'owner-a',
    });
    const first = locks.acquire('alpha');
    const lockDirectory = path.join(directory, 'alpha.lock');
    fs.renameSync(lockDirectory, `${lockDirectory}.reclaimed-owner-b`);
    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(path.join(lockDirectory, 'owner.json'), JSON.stringify({
      token: 'owner-b',
      pid: process.pid,
      acquiredAt: 2,
      heartbeatAt: 2,
    }));

    first.release();

    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8')).token, 'owner-b');
    assert.equal(fs.existsSync(lockDirectory), true);
    assert.equal(timers.callbacks.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('heartbeat는 자기 잠금만 갱신하고 종료된 owner의 stale 잠금만 격리 회수한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-stale-'));
  const timers = makeTimers();
  const alivePids = new Set([process.pid]);
  const tokens = ['owner-a', 'owner-b'];
  const renames = [];
  const tracedFs = {
    ...fs,
    renameSync(source, destination) {
      renames.push([source, destination]);
      fs.renameSync(source, destination);
    },
  };
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      fs: tracedFs,
      directory,
      leaseMs: 30000,
      heartbeatMs: 5000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: (pid) => alivePids.has(pid),
      randomToken: () => tokens.shift(),
    });
    const first = locks.acquire('alpha');
    const lockDirectory = path.join(directory, 'alpha.lock');
    const firstHeartbeat = [...timers.callbacks][0];
    const firstOwner = JSON.parse(fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8'));
    assert.deepEqual(Object.keys(firstOwner).sort(), ['acquiredAt', 'heartbeatAt', 'pid', 'token']);

    clock += 5000;
    firstHeartbeat();
    assert.equal(fs.readFileSync(path.join(lockDirectory, 'heartbeat-owner-a'), 'utf8'), `${clock}\n`);

    clock += 30001;
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    alivePids.delete(process.pid);

    const second = locks.acquire('alpha');
    assert.equal(second.token, 'owner-b');
    assert.deepEqual(renames.filter(([source]) => source === lockDirectory), [[lockDirectory, `${lockDirectory}.reclaimed-owner-b`]]);
    assert.equal(fs.readdirSync(directory).some((entry) => entry.includes('.reclaimed-')), false);

    const secondOwnerFile = path.join(lockDirectory, 'owner.json');
    clock += 5000;
    firstHeartbeat();
    assert.equal(JSON.parse(fs.readFileSync(secondOwnerFile, 'utf8')).token, 'owner-b');
    assert.equal(fs.existsSync(path.join(lockDirectory, 'heartbeat-owner-a')), false);
    assert.throws(() => first.assertOwned(), errorCode('JOB_CONFLICT'));

    first.release();
    assert.equal(JSON.parse(fs.readFileSync(secondOwnerFile, 'utf8')).token, 'owner-b');
    second.release();
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(timers.callbacks.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JSH에 utimesSync와 mtimeMs가 없어도 token heartbeat로 Job lock을 유지한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-jsh-heartbeat-'));
  const timers = makeTimers();
  const jshFs = {
    ...fs,
    utimesSync: undefined,
    statSync(target) {
      const stat = fs.statSync(target);
      return { mtime: { unixMilli: () => stat.mtimeMs } };
    },
  };
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      fs: jshFs,
      directory,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      randomToken: () => 'owner-a',
    });
    const handle = locks.acquire('alpha');
    const lockDirectory = path.join(directory, 'alpha.lock');
    const heartbeat = path.join(lockDirectory, 'heartbeat-owner-a');

    assert.equal(fs.existsSync(heartbeat), false);
    clock += 5000;
    [...timers.callbacks][0]();
    assert.equal(fs.readFileSync(heartbeat, 'utf8'), `${clock}\n`);
    handle.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('이전 owner heartbeat는 canonical 교체 뒤 새 token lease를 갱신하지 못한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-token-heartbeat-'));
  const timers = makeTimers();
  const heartbeatTimes = new Map();
  let clock = Date.now();
  const trackedFs = {
    ...fs,
    writeFileSync(target, contents) {
      fs.writeFileSync(target, contents);
      if (path.basename(target).startsWith('heartbeat-')) heartbeatTimes.set(target, clock);
    },
    statSync(target) {
      const stat = fs.statSync(target);
      return { mtime: { unixMilli: () => stat.mtimeMs } };
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: trackedFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: (() => {
        const tokens = ['owner-a', 'owner-b'];
        return () => tokens.shift();
      })(),
    });
    const first = locks.acquire('alpha');
    const firstHeartbeat = [...timers.callbacks][0];
    clock += 30001;
    const second = locks.acquire('alpha');
    const lockDirectory = path.join(directory, 'alpha.lock');
    const secondHeartbeat = path.join(lockDirectory, 'heartbeat-owner-b');
    const secondFreshAt = heartbeatTimes.get(secondHeartbeat);

    firstHeartbeat();
    assert.equal(heartbeatTimes.get(secondHeartbeat), secondFreshAt);
    clock += 1;
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    assert.doesNotThrow(() => second.assertOwned());
    first.release();
    second.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owner JSON 최초 기록 실패는 acquire를 실패시키고 stale 회수로 복구한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-heartbeat-write-failure-'));
  const timers = makeTimers();
  const faultFs = {
    ...fs,
    writeSync() {
      const failure = new Error('heartbeat write failed');
      failure.code = 'EIO';
      throw failure;
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: faultFs,
      directory,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      randomToken: () => 'owner-a',
    });

    assert.throws(() => locks.acquire('alpha'), (failure) => {
      assert.equal(failure.code, 'EIO');
      return true;
    });
    assert.deepEqual(fs.readdirSync(directory), ['alpha.lock']);
    const recovery = createJobOperationLock({
      directory,
      leaseMs: 0,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-b',
    }).acquire('alpha');
    recovery.release();
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.equal(timers.callbacks.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('incomplete lock은 directory mtime lease로만 회수한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-incomplete-jsh-mtime-'));
  const timers = makeTimers();
  const lockDirectory = path.join(directory, 'alpha.lock');
  let clock = Date.now();
  let directoryMtime = clock;
  const jshFs = {
    ...fs,
    utimesSync: undefined,
    statSync(target) {
      if (target === lockDirectory) return { mtime: { unixMilli: () => directoryMtime } };
      const stat = fs.statSync(target);
      return { mtime: { unixMilli: () => stat.mtimeMs } };
    },
  };
  try {
    fs.mkdirSync(lockDirectory);
    const locks = createJobOperationLock({
      fs: jshFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      randomToken: () => 'owner-a',
    });

    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    clock += 30001;
    directoryMtime = clock - 30001;
    const handle = locks.acquire('alpha');
    assert.doesNotThrow(() => handle.assertOwned());
    handle.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('PID 생존 확인 오류가 나면 stale 잠금을 회수하지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-pid-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive() {
        throw new Error('PID 확인 기능을 사용할 수 없습니다.');
      },
      randomToken: () => tokens.shift(),
    });
    const first = locks.acquire('alpha');
    clock += 30001;

    assert.throws(() => locks.assertAvailable('alpha'), errorCode('JOB_CONFLICT'));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'alpha.lock', 'owner.json'), 'utf8')).token, 'owner-a');

    first.release();
    assert.deepEqual(tokens, ['owner-b']);
    assert.equal(timers.callbacks.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JSH PID 확인이 ESRCH Error 값을 돌려주면 stale 잠금을 회수한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-jsh-pid-error-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => Object.assign(new Error('no such process'), { code: 'ESRCH' }),
      randomToken: () => tokens.shift(),
    });
    locks.acquire('alpha');
    clock += 30001;
    const replacement = locks.acquire('alpha');
    assert.equal(replacement.token, 'owner-b');
    replacement.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JSH PID 확인이 EPERM Error 값을 돌려주면 stale 잠금을 회수하지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-jsh-pid-permission-'));
  const timers = makeTimers();
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
      randomToken: () => 'owner-a',
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    owner.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('두 stale 회수자가 끼어들어도 한 회수자만 canonical lock을 교체한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-race-'));
  const timers = makeTimers();
  let clock = Date.now();
  let nestedHandle = null;
  let nestedFailure = null;
  try {
    const common = {
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
    };
    const owner = createJobOperationLock({ ...common, randomToken: () => 'owner-a' }).acquire('alpha');
    clock += 30001;

    const secondReclaimer = createJobOperationLock({
      ...common,
      randomToken: () => 'owner-y',
    });
    const firstReclaimer = createJobOperationLock({
      ...common,
      randomToken() {
        try {
          nestedHandle = secondReclaimer.acquire('alpha');
        } catch (failure) {
          nestedFailure = failure;
        }
        return 'owner-x';
      },
    });

    const winner = firstReclaimer.acquire('alpha');

    assert.equal(nestedHandle, null);
    assert.equal(nestedFailure && nestedFailure.code, 'JOB_CONFLICT');
    assert.equal(winner.token, 'owner-x');
    assert.doesNotThrow(() => winner.assertOwned());
    assert.throws(() => owner.assertOwned(), errorCode('JOB_CONFLICT'));

    owner.release();
    winner.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    if (nestedHandle) nestedHandle.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const failedOperation of ['unlink', 'rmdir']) {
  test(`${failedOperation} 정리 실패는 보이고 canonical lock을 막지 않는다`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `neo-job-operation-lock-${failedOperation}-`));
    const timers = makeTimers();
    const tokens = ['owner-a', 'owner-b'];
    const faultFs = {
      ...fs,
      unlinkSync(file) {
        if (failedOperation === 'unlink' && file.includes('.released-owner-a')) {
          const failure = new Error('unlink cleanup failed');
          failure.code = 'EIO';
          throw failure;
        }
        fs.unlinkSync(file);
      },
      rmdirSync(target) {
        if (failedOperation === 'rmdir' && target.includes('.released-owner-a')) {
          const failure = new Error('rmdir cleanup failed');
          failure.code = 'EIO';
          throw failure;
        }
        fs.rmdirSync(target);
      },
    };
    try {
      const locks = createJobOperationLock({
        fs: faultFs,
        directory,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        randomToken: () => tokens.shift(),
      });
      const first = locks.acquire('alpha');

      assert.throws(() => first.release(), (failure) => {
        assert.equal(failure.code, 'EIO');
        return true;
      });
      assert.equal(fs.existsSync(path.join(directory, 'alpha.lock')), false);

      const second = locks.acquire('alpha');
      assert.equal(second.token, 'owner-b');
      second.release();
      assert.equal(timers.callbacks.size, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('timer 생성 실패는 자기 owner lock을 남기지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-timer-'));
  try {
    const locks = createJobOperationLock({
      directory,
      randomToken: () => 'owner-a',
      setInterval() {
        throw new Error('timer creation failed');
      },
    });

    assert.throws(() => locks.acquire('alpha'), /timer creation failed/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale 회수의 owner 기록 실패는 빈 canonical을 치우고 이전 owner를 복원한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-owner-write-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b', 'owner-c'];
  let clock = Date.now();
  let ownerWrites = 0;
  const ownerDescriptors = new Set();
  const faultFs = {
    ...fs,
    openSync(file, flags) {
      const descriptor = fs.openSync(file, flags);
      if (file.includes(path.join('alpha.lock', 'owner.json.tmp-'))) ownerDescriptors.add(descriptor);
      return descriptor;
    },
    writeSync(descriptor, ...args) {
      if (ownerDescriptors.has(descriptor)) {
        ownerWrites += 1;
        if (ownerWrites === 2) {
          const failure = new Error('owner write failed');
          failure.code = 'EIO';
          throw failure;
        }
      }
      return fs.writeSync(descriptor, ...args);
    },
    closeSync(descriptor) {
      ownerDescriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: faultFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
    });
    const first = locks.acquire('alpha');
    clock += 30001;

    assert.throws(() => locks.acquire('alpha'), (failure) => {
      assert.equal(failure.code, 'EIO');
      return true;
    });
    assert.deepEqual(fs.readdirSync(directory), ['alpha.lock']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'alpha.lock', 'owner.json'), 'utf8')).token, 'owner-a');

    const recovered = locks.acquire('alpha');
    assert.equal(recovered.token, 'owner-c');
    assert.doesNotThrow(() => recovered.assertOwned());
    first.release();
    recovered.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reclaim mutex 삭제 실패는 보이고 mutex를 분리해 다음 요청을 복구한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-mutex-cleanup-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b', 'owner-c'];
  const reclaimMutex = path.join(directory, 'alpha.lock.reclaim');
  let clock = Date.now();
  let mutexCleanupFails = true;
  const faultFs = {
    ...fs,
    rmdirSync(target) {
      if (target === reclaimMutex && mutexCleanupFails) {
        mutexCleanupFails = false;
        const failure = new Error('reclaim mutex cleanup failed');
        failure.code = 'EIO';
        throw failure;
      }
      fs.rmdirSync(target);
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: faultFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
    });
    const first = locks.acquire('alpha');
    clock += 30001;

    assert.throws(() => locks.acquire('alpha'), (failure) => {
      assert.equal(failure.code, 'EIO');
      return true;
    });
    assert.equal(fs.existsSync(reclaimMutex), true);
    assert.equal(fs.existsSync(path.join(directory, 'alpha.lock')), false);

    clock += 30001;
    const recovered = locks.acquire('alpha');
    assert.equal(recovered.token, 'owner-c');
    assert.doesNotThrow(() => recovered.assertOwned());
    first.release();
    recovered.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('orphan reclaim mutex는 lease가 지난 뒤 회수되어 stale Job lock을 다시 획득한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-orphan-mutex-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  let clock = Date.now();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex); // mutex를 만든 직후 프로세스가 죽은 상황
    fs.utimesSync(reclaimMutex, new Date(clock - 30001), new Date(clock - 30001));

    const replacement = locks.acquire('alpha');

    assert.equal(replacement.token, 'owner-b');
    assert.doesNotThrow(() => replacement.assertOwned());
    assert.equal(fs.existsSync(reclaimMutex), false);
    owner.release();
    replacement.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh reclaim mutex와 PID 확인 오류가 난 stale reclaim mutex는 모두 충돌로 보호한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-mutex-protection-'));
  const timers = makeTimers();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  let clock = Date.now();
  let pidCheckFails = false;
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive() {
        if (pidCheckFails) throw new Error('PID 확인 오류');
        return false;
      },
      randomToken: () => 'owner-a',
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex);
    fs.writeFileSync(path.join(reclaimMutex, 'owner-reclaimer-a.json'), JSON.stringify({
      token: 'reclaimer-a', pid: process.pid, acquiredAt: clock, heartbeatAt: clock,
    }));
    fs.utimesSync(reclaimMutex, new Date(clock), new Date(clock));

    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    fs.utimesSync(reclaimMutex, new Date(clock - 30001), new Date(clock - 30001));
    pidCheckFails = true;
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));

    owner.release();
    fs.rmSync(reclaimMutex, { recursive: true, force: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JSH reclaim mutex의 ESRCH Error 값은 stale mutex와 Job lock을 회수한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-jsh-mutex-esrch-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => Object.assign(new Error('no such process'), { code: 'ESRCH' }),
      randomToken: () => tokens.shift(),
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex);
    fs.writeFileSync(path.join(reclaimMutex, 'owner-reclaimer-a.json'), JSON.stringify({
      token: 'reclaimer-a', pid: process.pid, acquiredAt: clock - 30001, heartbeatAt: clock - 30001,
    }));

    const replacement = locks.acquire('alpha');

    assert.equal(replacement.token, 'owner-b');
    owner.release();
    replacement.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JSH reclaim mutex의 EPERM Error 값은 stale mutex를 회수하지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-jsh-mutex-eperm-'));
  const timers = makeTimers();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' }),
      randomToken: () => 'owner-a',
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex);
    fs.writeFileSync(path.join(reclaimMutex, 'owner-reclaimer-a.json'), JSON.stringify({
      token: 'reclaimer-a', pid: process.pid, acquiredAt: clock - 30001, heartbeatAt: clock - 30001,
    }));

    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    assert.equal(fs.existsSync(reclaimMutex), true);
    owner.release();
    fs.rmSync(reclaimMutex, { recursive: true, force: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('오래 멈춘 mutex owner의 정리는 새 owner mutex를 지우지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-old-mutex-owner-'));
  const timers = makeTimers();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  let clock = Date.now();
  let replaced = false;
  const faultFs = {
    ...fs,
    unlinkSync(target) {
      if (!replaced && target === path.join(reclaimMutex, 'owner-reclaimer-a.json')) {
        replaced = true;
        fs.renameSync(reclaimMutex, `${reclaimMutex}.reclaimed-reclaimer-b`);
        fs.mkdirSync(reclaimMutex);
        fs.writeFileSync(path.join(reclaimMutex, 'owner-reclaimer-b.json'), JSON.stringify({
          token: 'reclaimer-b', pid: process.pid, acquiredAt: clock, heartbeatAt: clock,
        }));
      }
      fs.unlinkSync(target);
    },
  };
  try {
    const ownerLocks = createJobOperationLock({
      fs: faultFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-a',
      randomReclaimToken: () => 'reclaimer-a',
    });
    const owner = ownerLocks.acquire('alpha');
    clock += 30001;
    const replacement = ownerLocks.acquire('alpha');

    assert.equal(replaced, true);
    assert.equal(fs.existsSync(reclaimMutex), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(reclaimMutex, 'owner-reclaimer-b.json'), 'utf8')).token, 'reclaimer-b');

    owner.release();
    replacement.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale malformed reclaim mutex owner는 quarantine 회수해 다음 Job owner를 설치한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-malformed-mutex-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  let clock = Date.now();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex);
    fs.writeFileSync(path.join(reclaimMutex, 'owner-reclaimer-a.json'), '{partial');
    fs.utimesSync(reclaimMutex, new Date(clock - 30001), new Date(clock - 30001));

    const replacement = locks.acquire('alpha');

    assert.equal(replacement.token, 'owner-b');
    assert.doesNotThrow(() => replacement.assertOwned());
    owner.release();
    replacement.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reclaim mutex owner 문서는 임시 파일을 완성한 뒤 원자 publish한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-atomic-mutex-owner-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  let clock = Date.now();
  let writeSyncCalls = 0;
  const renames = [];
  const faultFs = {
    ...fs,
    writeFileSync(file, contents, encoding) {
      if (file.includes('.reclaim') && file.endsWith('.json')) {
        const failure = new Error('완성되지 않은 owner 문서를 직접 publish하면 안 됩니다.');
        failure.code = 'EIO';
        throw failure;
      }
      fs.writeFileSync(file, contents, encoding);
    },
    writeSync(...args) {
      writeSyncCalls += 1;
      return fs.writeSync(...args);
    },
    renameSync(source, destination) {
      renames.push([source, destination]);
      return fs.renameSync(source, destination);
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: faultFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
      randomReclaimToken: () => 'reclaimer-a',
    });
    const owner = locks.acquire('alpha');
    clock += 30001;

    const replacement = locks.acquire('alpha');

    assert.equal(replacement.token, 'owner-b');
    assert.ok(writeSyncCalls > 0);
    assert.ok(renames.some(([source, destination]) => source.includes('.reclaim.pending-reclaimer-a/owner-reclaimer-a.json.tmp-')
      && destination.endsWith('.reclaim.pending-reclaimer-a/owner-reclaimer-a.json')));
    assert.ok(renames.some(([source, destination]) => source.endsWith('.reclaim.pending-reclaimer-a')
      && destination.endsWith('.reclaim')));
    owner.release();
    replacement.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh malformed reclaim mutex는 회수하지 않고 JOB_CONFLICT로 보호한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-fresh-malformed-mutex-'));
  const timers = makeTimers();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-a',
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex);
    fs.writeFileSync(path.join(reclaimMutex, 'owner-reclaimer-a.json'), '{partial');
    fs.utimesSync(reclaimMutex, new Date(clock), new Date(clock));

    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));

    owner.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale temp-only reclaim mutex는 orphan으로 quarantine 회수한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-temp-only-mutex-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  let clock = Date.now();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex);
    fs.writeFileSync(path.join(reclaimMutex, 'owner-reclaimer-a.json.tmp-crashed'), '{partial');
    fs.utimesSync(reclaimMutex, new Date(clock - 30001), new Date(clock - 30001));

    const replacement = locks.acquire('alpha');

    assert.equal(replacement.token, 'owner-b');
    owner.release();
    replacement.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale reclaim mutex에 여러 owner 문서가 있으면 fail-closed 충돌이다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-ambiguous-mutex-'));
  const timers = makeTimers();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  let clock = Date.now();
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-a',
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    fs.mkdirSync(reclaimMutex);
    for (const token of ['reclaimer-a', 'reclaimer-b']) {
      fs.writeFileSync(path.join(reclaimMutex, `owner-${token}.json`), JSON.stringify({
        token, pid: process.pid, acquiredAt: clock, heartbeatAt: clock,
      }));
    }
    fs.utimesSync(reclaimMutex, new Date(clock - 30001), new Date(clock - 30001));

    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));

    owner.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stale malformed canonical owner는 quarantine 회수해 replacement owner를 설치한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-malformed-canonical-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  let clock = Date.now();
  const lockDirectory = path.join(directory, 'alpha.lock');
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
    });
    const owner = locks.acquire('alpha');
    fs.writeFileSync(path.join(lockDirectory, 'owner.json'), '{partial');
    clock += 30001;
    fs.utimesSync(lockDirectory, new Date(clock - 30001), new Date(clock - 30001));

    const replacement = locks.acquire('alpha');

    assert.equal(replacement.token, 'owner-b');
    assert.doesNotThrow(() => replacement.assertOwned());
    owner.release();
    replacement.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical owner 문서는 temp 완성 뒤 원자 publish하여 initial과 replacement에서 직접 쓰지 않는다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-atomic-canonical-owner-'));
  const timers = makeTimers();
  const tokens = ['owner-a', 'owner-b'];
  const renames = [];
  let clock = Date.now();
  const lockDirectory = path.join(directory, 'alpha.lock');
  const ownerPath = path.join(lockDirectory, 'owner.json');
  const faultFs = {
    ...fs,
    writeFileSync(file, contents, encoding) {
      if (file === ownerPath) {
        const failure = new Error('canonical owner 문서를 직접 publish하면 안 됩니다.');
        failure.code = 'EIO';
        throw failure;
      }
      return fs.writeFileSync(file, contents, encoding);
    },
    renameSync(source, destination) {
      renames.push([source, destination]);
      return fs.renameSync(source, destination);
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: faultFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => tokens.shift(),
    });
    const owner = locks.acquire('alpha');
    clock += 30001;
    const replacement = locks.acquire('alpha');

    assert.equal(replacement.token, 'owner-b');
    assert.equal(renames.filter(([, destination]) => destination === ownerPath).length, 2);
    owner.release();
    replacement.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical owner writeSync가 0을 반환하면 오류를 보이고 다음 획득이 가능하다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-canonical-write-zero-'));
  const timers = makeTimers();
  const lockDirectory = path.join(directory, 'alpha.lock');
  let clock = Date.now();
  const faultFs = {
    ...fs,
    writeSync() {
      return 0;
    },
  };
  try {
    const failing = createJobOperationLock({
      fs: faultFs,
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-a',
    });
    assert.throws(() => failing.acquire('alpha'), (failure) => {
      assert.equal(failure.code, 'EIO');
      return true;
    });
    assert.equal(fs.existsSync(lockDirectory), true);
    clock = fs.statSync(lockDirectory).mtimeMs;

    const recoveryLocks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-b',
    });
    assert.throws(() => recoveryLocks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    clock += 30001;
    const recovered = recoveryLocks.acquire('alpha');
    assert.equal(recovered.token, 'owner-b');
    recovered.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical owner는 JSH 문자열 writeSync의 부분 기록을 끝까지 기록한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-jsh-partial-write-'));
  const timers = makeTimers();
  const writes = [];
  const jshFs = {
    ...fs,
    writeSync(descriptor, text) {
      assert.equal(typeof text, 'string');
      assert.equal(arguments.length, 2);
      writes.push(text);
      const count = Math.min(7, text.length);
      return fs.writeSync(descriptor, text.slice(0, count));
    },
  };
  try {
    const locks = createJobOperationLock({
      fs: jshFs,
      directory,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      randomToken: () => 'owner-a',
    });
    const handle = locks.acquire('alpha');

    assert.ok(writes.length > 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'alpha.lock', 'owner.json'), 'utf8')).token, 'owner-a');
    handle.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh incomplete canonical lock은 보호하고 stale empty와 temp-only canonical lock은 회수한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-incomplete-canonical-'));
  const timers = makeTimers();
  let clock = Date.now();
  const lockDirectory = path.join(directory, 'alpha.lock');
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-a',
    });
    fs.mkdirSync(lockDirectory);
    fs.utimesSync(lockDirectory, new Date(clock), new Date(clock));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));

    clock += 30001;
    fs.utimesSync(lockDirectory, new Date(clock - 30001), new Date(clock - 30001));
    const emptyRecovered = locks.acquire('alpha');
    assert.equal(emptyRecovered.token, 'owner-a');
    emptyRecovered.release();

    fs.mkdirSync(lockDirectory);
    fs.writeFileSync(path.join(lockDirectory, 'owner.json.tmp-crashed'), '{partial');
    clock += 30001;
    fs.utimesSync(lockDirectory, new Date(clock - 30001), new Date(clock - 30001));
    const tempRecovered = locks.acquire('alpha');
    assert.equal(tempRecovered.token, 'owner-a');
    tempRecovered.release();
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical owner final과 extra owner 문서가 함께 있으면 stale이어도 fail-closed 충돌이다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-ambiguous-canonical-'));
  const timers = makeTimers();
  let clock = Date.now();
  const lockDirectory = path.join(directory, 'alpha.lock');
  try {
    const locks = createJobOperationLock({
      directory,
      leaseMs: 30000,
      now: () => clock,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isProcessAlive: () => false,
      randomToken: () => 'owner-a',
    });
    const owner = locks.acquire('alpha');
    fs.writeFileSync(path.join(lockDirectory, 'owner-extra.json'), JSON.stringify({
      token: 'owner-extra', pid: process.pid, acquiredAt: clock, heartbeatAt: clock,
    }));
    clock += 30001;
    fs.utimesSync(lockDirectory, new Date(clock - 30001), new Date(clock - 30001));

    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));

    owner.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const failedOperation of ['fsync', 'close', 'rename']) {
  test(`canonical owner ${failedOperation} 실패는 보이고 다음 initial acquire가 복구한다`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `neo-job-operation-lock-canonical-${failedOperation}-`));
    const timers = makeTimers();
    const lockDirectory = path.join(directory, 'alpha.lock');
    const ownerPath = path.join(lockDirectory, 'owner.json');
    const ownerDescriptors = new Set();
    let failed = false;
    let clock = Date.now();
    const faultFs = {
      ...fs,
      openSync(file, flags) {
        const descriptor = fs.openSync(file, flags);
        if (file.startsWith(`${ownerPath}.tmp-`)) ownerDescriptors.add(descriptor);
        return descriptor;
      },
      fsyncSync(descriptor) {
        if (failedOperation === 'fsync' && ownerDescriptors.has(descriptor) && !failed) {
          failed = true;
          const failure = new Error('fsync failed');
          failure.code = 'EIO';
          throw failure;
        }
        return fs.fsyncSync(descriptor);
      },
      closeSync(descriptor) {
        if (failedOperation === 'close' && ownerDescriptors.has(descriptor) && !failed) {
          failed = true;
          fs.closeSync(descriptor);
          const failure = new Error('close failed');
          failure.code = 'EIO';
          throw failure;
        }
        ownerDescriptors.delete(descriptor);
        return fs.closeSync(descriptor);
      },
      renameSync(source, destination) {
        if (failedOperation === 'rename' && source.startsWith(`${ownerPath}.tmp-`) && destination === ownerPath && !failed) {
          failed = true;
          const failure = new Error('rename failed');
          failure.code = 'EIO';
          throw failure;
        }
        return fs.renameSync(source, destination);
      },
    };
    try {
      const failing = createJobOperationLock({
        fs: faultFs,
        directory,
        leaseMs: 30000,
        now: () => clock,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isProcessAlive: () => false,
        randomToken: () => 'owner-a',
      });
      assert.throws(() => failing.acquire('alpha'), (failure) => {
        assert.equal(failure.code, 'EIO');
        return true;
      });
      assert.equal(fs.existsSync(lockDirectory), true);
      clock = fs.statSync(lockDirectory).mtimeMs;

      const recoveryLocks = createJobOperationLock({
        directory,
        leaseMs: 30000,
        now: () => clock,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isProcessAlive: () => false,
        randomToken: () => 'owner-b',
      });
      assert.throws(() => recoveryLocks.acquire('alpha'), errorCode('JOB_CONFLICT'));
      clock += 30001;
      const recovered = recoveryLocks.acquire('alpha');
      assert.equal(recovered.token, 'owner-b');
      recovered.release();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

const invalidOwnerCases = [
  { label: 'pid 0', change: { pid: 0 } },
  { label: '음수 pid', change: { pid: -1 } },
  { label: '소수 pid', change: { pid: 1.5 } },
  { label: '빈 token', change: { token: '' } },
  { label: '뒤집힌 heartbeat 시각', change: { acquiredAt: 200, heartbeatAt: 199 } },
];

for (const invalidCase of invalidOwnerCases) {
  test(`stale canonical owner의 ${invalidCase.label} schema 오류는 PID 확인 없이 orphan 회수한다`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-invalid-canonical-owner-'));
    const timers = makeTimers();
    const lockDirectory = path.join(directory, 'alpha.lock');
    let clock = Date.now();
    let pidChecks = 0;
    try {
      fs.mkdirSync(lockDirectory, { recursive: true });
      fs.writeFileSync(path.join(lockDirectory, 'owner.json'), JSON.stringify({
        token: 'owner-a',
        pid: process.pid,
        acquiredAt: 100,
        heartbeatAt: 100,
        ...invalidCase.change,
      }));
      fs.utimesSync(lockDirectory, new Date(clock - 30001), new Date(clock - 30001));
      const locks = createJobOperationLock({
        directory,
        leaseMs: 30000,
        now: () => clock,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isProcessAlive() {
          pidChecks += 1;
          return true;
        },
        randomToken: () => 'owner-b',
      });

      const replacement = locks.acquire('alpha');

      assert.equal(replacement.token, 'owner-b');
      assert.equal(pidChecks, 0);
      replacement.release();
      assert.deepEqual(fs.readdirSync(directory), []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`stale reclaim mutex owner의 ${invalidCase.label} schema 오류는 PID 확인 없이 orphan 회수한다`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-job-operation-lock-invalid-mutex-owner-'));
    const timers = makeTimers();
    const reclaimMutex = path.join(directory, 'alpha.lock.reclaim');
    let clock = Date.now();
    let pidChecks = 0;
    try {
      const owner = {
        token: 'reclaimer-a',
        pid: process.pid,
        acquiredAt: 100,
        heartbeatAt: 100,
        ...invalidCase.change,
      };
      fs.mkdirSync(reclaimMutex, { recursive: true });
      fs.writeFileSync(path.join(reclaimMutex, `owner-${encodeURIComponent(owner.token)}.json`), JSON.stringify(owner));
      fs.utimesSync(reclaimMutex, new Date(clock - 30001), new Date(clock - 30001));
      const locks = createJobOperationLock({
        directory,
        leaseMs: 30000,
        now: () => clock,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isProcessAlive() {
          pidChecks += 1;
          return true;
        },
        randomToken: () => 'owner-b',
      });

      const replacement = locks.acquire('alpha');

      assert.equal(replacement.token, 'owner-b');
      assert.equal(pidChecks, 0);
      replacement.release();
      assert.deepEqual(fs.readdirSync(directory), []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const ownerKind of ['canonical', 'reclaim mutex']) {
  test(`${ownerKind} owner publish 패자는 stale 회수 승자의 owner를 삭제하지 않는다`, () => {
    const harness = makeLockHarness(`neo-job-operation-lock-${ownerKind === 'canonical' ? 'canonical' : 'mutex'}-race-`);
    const lockDirectory = path.join(harness.directory, 'alpha.lock');
    const reclaimMutex = `${lockDirectory}.reclaim`;
    const pendingMutex = `${reclaimMutex}.pending-reclaimer-a`;
    const loserOwnerPath = ownerKind === 'canonical'
      ? path.join(lockDirectory, 'owner.json')
      : path.join(reclaimMutex, 'owner-reclaimer-a.json');
    const winnerOwnerPath = ownerKind === 'canonical'
      ? loserOwnerPath
      : path.join(reclaimMutex, 'owner-reclaimer-b.json');
    let interleaved = false;
    let winner = null;
    try {
      const winnerLocks = createJobOperationLock(harness.settings({ randomToken: () => 'owner-b' }));
      if (ownerKind !== 'canonical') {
        fs.mkdirSync(lockDirectory, { recursive: true });
        fs.writeFileSync(path.join(lockDirectory, 'owner.json'), JSON.stringify({
          token: 'owner-old', pid: process.pid, acquiredAt: harness.now(), heartbeatAt: harness.now(),
        }));
        fs.utimesSync(lockDirectory, new Date(harness.now() - 30001), new Date(harness.now() - 30001));
      }
      const loserFs = {
        ...fs,
        existsSync(target) {
          return fs.existsSync(target);
        },
        renameSync(source, destination) {
          if (!interleaved && ownerKind === 'canonical' && destination === loserOwnerPath) {
            interleaved = true;
            assert.equal(fs.existsSync(destination), false);
            harness.advance();
            fs.utimesSync(lockDirectory, new Date(harness.now() - 30001), new Date(harness.now() - 30001));
            winner = winnerLocks.acquire('alpha');
          } else if (!interleaved && ownerKind !== 'canonical'
            && source.startsWith(`${pendingMutex}/owner-reclaimer-a.json.tmp-`)
            && destination === path.join(pendingMutex, 'owner-reclaimer-a.json')) {
            interleaved = true;
            fs.renameSync(pendingMutex, `${pendingMutex}.lost`);
            fs.mkdirSync(reclaimMutex);
            fs.writeFileSync(winnerOwnerPath, JSON.stringify({
              token: 'reclaimer-b', pid: process.pid, acquiredAt: harness.now(), heartbeatAt: harness.now(),
            }));
            fs.utimesSync(reclaimMutex, new Date(harness.now()), new Date(harness.now()));
          }
          return fs.renameSync(source, destination);
        },
      };
      const loserLocks = createJobOperationLock(harness.settings({
        fs: loserFs,
        randomToken: () => 'owner-a',
        randomReclaimToken: () => 'reclaimer-a',
      }));

      assert.throws(() => loserLocks.acquire('alpha'), errorCode('JOB_CONFLICT'));
      assert.equal(interleaved, true);
      assert.equal(JSON.parse(fs.readFileSync(winnerOwnerPath, 'utf8')).token,
        ownerKind === 'canonical' ? 'owner-b' : 'reclaimer-b');
      if (winner) {
        assert.doesNotThrow(() => winner.assertOwned());
        winner.release();
        assert.equal(harness.timers.callbacks.size, 0);
      } else {
        assert.throws(() => loserLocks.acquire('alpha'), errorCode('JOB_CONFLICT'));
      }
    } finally {
      harness.cleanup();
    }
  });
}

test('reclaim mutex release 중 새 owner가 와도 이전 owner가 새 mutex를 지우지 않는다', () => {
  const harness = makeLockHarness('neo-job-operation-lock-mutex-release-race-');
  const lockDirectory = path.join(harness.directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  const winnerOwnerPath = path.join(reclaimMutex, 'owner-reclaimer-b.json');
  const originalRmdirSync = fs.rmdirSync;
  const oldOwner = createJobOperationLock(harness.settings({ randomToken: () => 'owner-old' })).acquire('alpha');
  harness.advance();
  let phase = 'waiting';
  let resumeOldRmdir;
  let oldRmdirFailure;
  let oldOriginalRmdirAttempts = 0;
  let oldRmdirFailureSource;
  let winner;
  let winnerOwnerUnlinks = 0;
  let winnerMutexRmdirs = 0;
  const trace = [];
  try {
    const winnerFs = {
      ...fs,
      statSync(target) {
        if (phase === 'winner-acquiring' && target === lockDirectory && fs.existsSync(winnerOwnerPath)) {
          phase = 'winner-published';
          trace.push('B owner published');
          assert.equal(JSON.parse(fs.readFileSync(winnerOwnerPath, 'utf8')).token, 'reclaimer-b');
          resumeOldRmdir();
          assert.equal(oldRmdirFailure && oldRmdirFailure.code, 'ENOTEMPTY');
          assert.equal(JSON.parse(fs.readFileSync(winnerOwnerPath, 'utf8')).token, 'reclaimer-b');
        }
        return fs.statSync(target);
      },
      unlinkSync(target) {
        if (target === winnerOwnerPath) {
          winnerOwnerUnlinks += 1;
          trace.push('B mutex owner unlinked');
        }
        return fs.unlinkSync(target);
      },
      rmdirSync(target) {
        if (target === reclaimMutex) {
          winnerMutexRmdirs += 1;
          trace.push('B mutex removed');
        }
        return originalRmdirSync(target);
      },
    };
    const winnerLocks = createJobOperationLock(harness.settings({
      fs: winnerFs,
      randomToken: () => 'owner-b',
      randomReclaimToken: () => 'reclaimer-b',
    }));
    const loserFs = {
      ...fs,
      rmdirSync(target) {
        if (phase === 'waiting' && target === reclaimMutex) {
          phase = 'old-wrapper-entered';
          trace.push('A rmdir wrapper entered');
          harness.advance();
          fs.utimesSync(reclaimMutex, new Date(harness.now() - 30001), new Date(harness.now() - 30001));
          fs.utimesSync(lockDirectory, new Date(harness.now() - 30001), new Date(harness.now() - 30001));
          resumeOldRmdir = () => {
            oldOriginalRmdirAttempts += 1;
            trace.push('A original rmdir attempted');
            try {
              originalRmdirSync(target);
            } catch (failure) {
              oldRmdirFailure = failure;
              oldRmdirFailureSource = 'originalRmdirSync';
              trace.push(`A original rmdir ${failure.code}`);
            }
          };
          phase = 'winner-acquiring';
          winner = winnerLocks.acquire('alpha');
          trace.push('B acquire returned');
          throw oldRmdirFailure;
        }
        return originalRmdirSync(target);
      },
    };
    const loserLocks = createJobOperationLock(harness.settings({
      fs: loserFs,
      randomToken: () => 'owner-a',
      randomReclaimToken: () => 'reclaimer-a',
    }));

    const loser = loserLocks.acquire('alpha');

    assert.equal(phase, 'winner-published');
    assert.equal(oldOriginalRmdirAttempts, 1);
    assert.equal(oldRmdirFailureSource, 'originalRmdirSync');
    assert.equal(oldRmdirFailure && oldRmdirFailure.code, 'ENOTEMPTY');
    assert.equal(winnerOwnerUnlinks, 1, 'B의 실제 releaseReclaimMutex가 owner를 지워야 합니다.');
    assert.equal(winnerMutexRmdirs, 1, 'B의 실제 releaseReclaimMutex가 mutex를 닫아야 합니다.');
    assert.deepEqual(trace.slice(0, 7), [
      'A rmdir wrapper entered',
      'B owner published',
      'A original rmdir attempted',
      'A original rmdir ENOTEMPTY',
      'B mutex owner unlinked',
      'B mutex removed',
      'B acquire returned',
    ]);
    assert.equal(fs.existsSync(reclaimMutex), false);
    let winnerAssertCalls = 0;
    winnerAssertCalls += 1;
    assert.doesNotThrow(() => winner.assertOwned());
    assert.equal(winnerAssertCalls, 1);
    assert.throws(() => loser.assertOwned(), errorCode('JOB_CONFLICT'));
    oldOwner.release();
    loser.release();

    let winnerReleaseCalls = 0;
    winnerReleaseCalls += 1;
    winner.release();
    assert.equal(winnerReleaseCalls, 1);
    const next = createJobOperationLock(harness.settings({ randomToken: () => 'owner-c' })).acquire('alpha');
    assert.doesNotThrow(() => next.assertOwned());
    next.release();
    assert.equal(harness.timers.callbacks.size, 0);
  } finally {
    harness.cleanup();
  }
});

test('crash로 남은 다른 token의 pending mutex는 새 owner 획득을 막지 않는다', () => {
  const harness = makeLockHarness('neo-job-operation-lock-pending-orphan-');
  const lockDirectory = path.join(harness.directory, 'alpha.lock');
  const reclaimMutex = `${lockDirectory}.reclaim`;
  const crashedPending = `${reclaimMutex}.pending-reclaimer-crashed`;
  const crashedOwnerPath = path.join(crashedPending, 'owner-reclaimer-crashed.json');
  try {
    const oldOwner = createJobOperationLock(harness.settings({ randomToken: () => 'owner-old' })).acquire('alpha');
    harness.advance();
    fs.mkdirSync(crashedPending);
    fs.writeFileSync(crashedOwnerPath, JSON.stringify({
      token: 'reclaimer-crashed', pid: process.pid,
      acquiredAt: harness.now(), heartbeatAt: harness.now(),
    }));
    fs.utimesSync(crashedPending, new Date(harness.now()), new Date(harness.now()));
    const locks = createJobOperationLock(harness.settings({
      randomToken: () => 'owner-b',
      randomReclaimToken: () => 'reclaimer-b',
    }));

    const winner = locks.acquire('alpha');

    assert.equal(winner.token, 'owner-b');
    assert.doesNotThrow(() => winner.assertOwned());
    assert.equal(JSON.parse(fs.readFileSync(crashedOwnerPath, 'utf8')).token, 'reclaimer-crashed');
    assert.equal(fs.existsSync(reclaimMutex), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8')).token, 'owner-b');
    oldOwner.release();
    let winnerReleaseCalls = 0;
    winnerReleaseCalls += 1;
    winner.release();
    assert.equal(winnerReleaseCalls, 1);
    assert.equal(fs.existsSync(lockDirectory), false);

    const next = createJobOperationLock(harness.settings({ randomToken: () => 'owner-c' })).acquire('alpha');
    let nextAssertCalls = 0;
    nextAssertCalls += 1;
    assert.doesNotThrow(() => next.assertOwned());
    assert.equal(nextAssertCalls, 1);
    next.release();
    assert.equal(fs.existsSync(lockDirectory), false);
    assert.equal(harness.timers.callbacks.size, 0);
  } finally {
    harness.cleanup();
  }
});
