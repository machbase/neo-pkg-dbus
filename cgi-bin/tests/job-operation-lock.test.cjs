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

function makeHarness(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const timers = makeTimers();
  let clock = Date.now();
  let ownerSequence = 0;
  let guardSequence = 0;
  return {
    directory,
    timers,
    now: () => clock,
    advance(milliseconds = 30001) { clock += milliseconds; },
    lockPath(name = 'alpha') { return path.join(directory, `${name}.lock`); },
    guardPath(name = 'alpha') { return path.join(directory, `${name}.lock.reclaim`); },
    settings(extra) {
      return {
        directory,
        leaseMs: 30000,
        heartbeatMs: 5000,
        now: () => clock,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        isProcessAlive: () => false,
        randomToken: () => `owner-${++ownerSequence}`,
        randomReclaimToken: () => `guard-${++guardSequence}`,
        ...(extra || {}),
      };
    },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

function owner(token, heartbeatAt, pid = process.pid) {
  return { token, pid, acquiredAt: heartbeatAt, heartbeatAt };
}

function writeOwnerFile(target, document, modifiedAt) {
  fs.writeFileSync(target, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  if (modifiedAt !== undefined) fs.utimesSync(target, new Date(modifiedAt), new Date(modifiedAt));
}

function writeLegacyLock(target, document, heartbeat) {
  fs.mkdirSync(target, { recursive: true });
  writeOwnerFile(path.join(target, 'owner.json'), document);
  if (heartbeat !== undefined) fs.writeFileSync(path.join(target, `heartbeat-${document.token}`), `${heartbeat}\n`);
}

test('canonical operation lock은 wx로 생성한 단일 0600 JSON 파일이다', () => {
  const harness = makeHarness('neo-file-operation-lock-shape-');
  const opened = [];
  const tracedFs = {
    ...fs,
    openSync(target, flags, mode) {
      opened.push({ target, flags, mode });
      return fs.openSync(target, flags, mode);
    },
  };
  try {
    const locks = createJobOperationLock(harness.settings({ fs: tracedFs, isProcessAlive: () => true }));
    const first = locks.acquire('alpha');
    const lockPath = harness.lockPath();
    assert.equal(fs.statSync(lockPath).isFile(), true);
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).sort(), [
      'acquiredAt', 'heartbeatAt', 'pid', 'token',
    ]);
    assert.ok(opened.some((entry) => entry.target === lockPath && entry.flags === 'wx' && entry.mode === 0o600));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    first.release();

    const second = locks.acquire('alpha');
    assert.equal(second.token, 'owner-2');
    second.release();
    assert.deepEqual(fs.readdirSync(harness.directory), []);
    assert.equal(harness.timers.callbacks.size, 0);
  } finally {
    harness.cleanup();
  }
});

test('Neo JSH가 O_EXCL 충돌을 ENOENT로 포장해도 기존 owner를 보존한다', () => {
  const harness = makeHarness('neo-file-operation-lock-jsh-exclusive-');
  const lockPath = harness.lockPath();
  let injected = false;
  const jshFs = {
    ...fs,
    openSync(target, flags, mode) {
      if (!injected && target === lockPath && flags === 'wx') {
        injected = true;
        writeOwnerFile(lockPath, owner('competing-owner', harness.now()));
        const failure = new Error('JSH wrapped exclusive collision');
        failure.code = 'ENOENT';
        throw failure;
      }
      return fs.openSync(target, flags, mode);
    },
  };
  try {
    const locks = createJobOperationLock(harness.settings({ fs: jshFs, isProcessAlive: () => true }));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'competing-owner');
    assert.equal(fs.existsSync(harness.guardPath()), false);
  } finally {
    harness.cleanup();
  }
});

test('Neo JSH mkdir이 기존 directory에서도 성공해도 guard owner wx가 동시 획득을 막는다', () => {
  const harness = makeHarness('neo-file-operation-lock-jsh-guard-exclusive-');
  const ownerPath = path.join(harness.guardPath(), 'owner.json');
  let injected = false;
  const jshFs = {
    ...fs,
    mkdirSync(target, options) {
      fs.mkdirSync(target, { ...(options || {}), recursive: true });
    },
    openSync(target, flags, mode) {
      if (!injected && target === ownerPath && flags === 'wx') {
        injected = true;
        writeOwnerFile(ownerPath, owner('competing-guard', harness.now()));
        const failure = new Error('JSH wrapped exclusive collision');
        failure.code = 'ENOENT';
        throw failure;
      }
      return fs.openSync(target, flags, mode);
    },
  };
  try {
    const locks = createJobOperationLock(harness.settings({ fs: jshFs, isProcessAlive: () => true }));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    assert.equal(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).token, 'competing-guard');
    assert.equal(fs.existsSync(harness.lockPath()), false);
  } finally {
    harness.cleanup();
  }
});

test('heartbeat는 canonical 파일을 원자 교체하고 현재 owner만 갱신한다', () => {
  const harness = makeHarness('neo-file-operation-lock-heartbeat-');
  try {
    const locks = createJobOperationLock(harness.settings({ isProcessAlive: () => true }));
    const handle = locks.acquire('alpha');
    const lockPath = harness.lockPath();
    const heartbeat = [...harness.timers.callbacks][0];
    const initial = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

    harness.advance(5000);
    heartbeat();
    const updated = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(updated.token, initial.token);
    assert.equal(updated.heartbeatAt, harness.now());
    assert.equal(fs.readdirSync(harness.directory).some((entry) => entry.includes('.tmp-')), false);

    writeOwnerFile(lockPath, owner('replacement-owner', harness.now()));
    harness.advance(5000);
    heartbeat();
    handle.release();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'replacement-owner');
    assert.equal(harness.timers.callbacks.size, 0);
  } finally {
    harness.cleanup();
  }
});

test('lease가 지나고 PID가 종료된 file lock만 회수한다', () => {
  const harness = makeHarness('neo-file-operation-lock-stale-');
  const lockPath = harness.lockPath();
  try {
    writeOwnerFile(lockPath, owner('old-owner', harness.now() - 30001, 9123));
    const locks = createJobOperationLock(harness.settings({ isProcessAlive: (pid) => pid !== 9123 }));
    const replacement = locks.acquire('alpha');
    assert.equal(replacement.token, 'owner-1');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'owner-1');
    replacement.release();
    assert.deepEqual(fs.readdirSync(harness.directory), []);
  } finally {
    harness.cleanup();
  }
});

test('fresh owner, 살아 있는 PID, PID 판정 오류는 모두 fail-closed다', () => {
  for (const scenario of [
    { label: 'fresh', age: 0, alive: false },
    { label: 'alive', age: 30001, alive: true },
    { label: 'check-error', age: 30001, throws: true },
    { label: 'eperm-value', age: 30001, alive: { code: 'EPERM' } },
  ]) {
    const harness = makeHarness(`neo-file-operation-lock-${scenario.label}-`);
    try {
      writeOwnerFile(harness.lockPath(), owner('protected-owner', harness.now() - scenario.age, 9123));
      const locks = createJobOperationLock(harness.settings({
        isProcessAlive() {
          if (scenario.throws) throw new Error('cannot inspect pid');
          return scenario.alive;
        },
      }));
      assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'), scenario.label);
      assert.equal(JSON.parse(fs.readFileSync(harness.lockPath(), 'utf8')).token, 'protected-owner');
    } finally {
      harness.cleanup();
    }
  }
});

test('JSH PID 확인의 ESRCH 및 code 없는 GoError 값으로 stale lock을 회수한다', () => {
  for (const [label, result] of [
    ['esrch', { code: 'ESRCH' }],
    ['go-error', { toString: () => 'GoError: kill 9123 with 0: os: process already finished' }],
  ]) {
    const harness = makeHarness(`neo-file-operation-lock-${label}-`);
    try {
      writeOwnerFile(harness.lockPath(), owner('old-owner', harness.now() - 30001, 9123));
      const locks = createJobOperationLock(harness.settings({ isProcessAlive: () => result }));
      const replacement = locks.acquire('alpha');
      replacement.release();
      assert.deepEqual(fs.readdirSync(harness.directory), []);
    } finally {
      harness.cleanup();
    }
  }
});

test('code 없는 알 수 없는 JSH GoError 값은 stale lock을 보호한다', () => {
  const harness = makeHarness('neo-file-operation-lock-unknown-go-error-');
  try {
    writeOwnerFile(harness.lockPath(), owner('old-owner', harness.now() - 30001, 9123));
    const locks = createJobOperationLock(harness.settings({
      isProcessAlive: () => ({ toString: () => 'GoError: operation not permitted' }),
    }));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
  } finally {
    harness.cleanup();
  }
});

test('손상된 file lock은 mtime lease 전에는 보호하고 지난 뒤 PID 검사 없이 회수한다', () => {
  const harness = makeHarness('neo-file-operation-lock-incomplete-');
  let pidChecks = 0;
  try {
    fs.writeFileSync(harness.lockPath(), '{broken');
    const locks = createJobOperationLock(harness.settings({
      isProcessAlive() { pidChecks += 1; return true; },
    }));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
    fs.utimesSync(harness.lockPath(), new Date(harness.now() - 30001), new Date(harness.now() - 30001));
    const replacement = locks.acquire('alpha');
    assert.equal(pidChecks, 0);
    replacement.release();
  } finally {
    harness.cleanup();
  }
});

test('availability probe는 stale 판정만 하고 lock 또는 guard를 변경하지 않는다', () => {
  const harness = makeHarness('neo-file-operation-lock-probe-');
  try {
    const locks = createJobOperationLock(harness.settings({ isProcessAlive: () => false }));
    assert.doesNotThrow(() => locks.assertAvailable('package-lifecycle'));
    assert.deepEqual(fs.readdirSync(harness.directory), []);

    const lockPath = path.join(harness.directory, 'package-lifecycle.lock');
    writeOwnerFile(lockPath, owner('old-fence', harness.now() - 30001, 9123));
    const before = fs.readFileSync(lockPath, 'utf8');
    assert.doesNotThrow(() => locks.assertAvailable('package-lifecycle'));
    assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(harness.directory), ['package-lifecycle.lock']);
  } finally {
    harness.cleanup();
  }
});

test('JSH 문자열 writeSync의 부분 기록을 끝까지 반복한다', () => {
  const harness = makeHarness('neo-file-operation-lock-partial-write-');
  const partialFs = {
    ...fs,
    writeSync(descriptor, content) {
      return fs.writeSync(descriptor, content.slice(0, 3));
    },
  };
  try {
    const locks = createJobOperationLock(harness.settings({ fs: partialFs }));
    const handle = locks.acquire('alpha');
    assert.equal(JSON.parse(fs.readFileSync(harness.lockPath(), 'utf8')).token, 'owner-1');
    handle.release();
  } finally {
    harness.cleanup();
  }
});

test('canonical writeSync 실패는 부분 파일과 guard를 남기지 않는다', () => {
  const harness = makeHarness('neo-file-operation-lock-short-write-');
  const lockPath = harness.lockPath();
  const failingFs = {
    ...fs,
    writeSync(descriptor, content) {
      const descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
      if (descriptorPath === lockPath) return 0;
      return fs.writeSync(descriptor, content);
    },
  };
  try {
    const locks = createJobOperationLock(harness.settings({ fs: failingFs }));
    assert.throws(() => locks.acquire('alpha'), errorCode('EIO'));
    assert.deepEqual(fs.readdirSync(harness.directory), []);

    const recovered = createJobOperationLock(harness.settings()).acquire('alpha');
    recovered.release();
  } finally {
    harness.cleanup();
  }
});

test('timer 생성 실패는 자기 file lock과 guard를 정리한다', () => {
  const harness = makeHarness('neo-file-operation-lock-timer-failure-');
  try {
    const locks = createJobOperationLock(harness.settings({
      setInterval() { throw new Error('timer failed'); },
    }));
    assert.throws(() => locks.acquire('alpha'), /timer failed/);
    assert.deepEqual(fs.readdirSync(harness.directory), []);
  } finally {
    harness.cleanup();
  }
});

test('timer 해제 실패에도 자기 file lock은 정리한다', () => {
  const harness = makeHarness('neo-file-operation-lock-clear-timer-failure-');
  try {
    const locks = createJobOperationLock(harness.settings({
      clearInterval() { throw new Error('clear timer failed'); },
    }));
    const handle = locks.acquire('alpha');
    assert.throws(() => handle.release(), /clear timer failed/);
    assert.equal(fs.existsSync(harness.lockPath()), false);
  } finally {
    harness.cleanup();
  }
});

test('내부 guard 정리 실패가 획득한 canonical file lock을 무효화하지 않는다', () => {
  const harness = makeHarness('neo-file-operation-lock-guard-release-failure-');
  const guardPath = harness.guardPath();
  const failingFs = {
    ...fs,
    rmdirSync(target) {
      if (target === guardPath) {
        const failure = new Error('guard rmdir failed');
        failure.code = 'EIO';
        throw failure;
      }
      return fs.rmdirSync(target);
    },
  };
  try {
    const locks = createJobOperationLock(harness.settings({ fs: failingFs }));
    const handle = locks.acquire('alpha');
    assert.equal(JSON.parse(fs.readFileSync(harness.lockPath(), 'utf8')).token, handle.token);
    assert.equal(fs.existsSync(guardPath), true);
    handle.release();
    assert.equal(fs.existsSync(harness.lockPath()), false);
  } finally {
    harness.cleanup();
  }
});

test('fresh reclaim guard는 충돌하고 stale dead guard는 자동 회수한다', () => {
  const harness = makeHarness('neo-file-operation-lock-guard-');
  const guardPath = harness.guardPath();
  const guardOwnerPath = path.join(guardPath, 'owner.json');
  try {
    fs.mkdirSync(guardPath);
    writeOwnerFile(guardOwnerPath, owner('guard-old', harness.now(), 9123));
    const locks = createJobOperationLock(harness.settings({ isProcessAlive: () => false }));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));

    writeOwnerFile(guardOwnerPath, owner('guard-old', harness.now() - 30001, 9123));
    const replacement = locks.acquire('alpha');
    assert.equal(fs.existsSync(guardPath), false);
    replacement.release();
    assert.deepEqual(fs.readdirSync(harness.directory), []);
  } finally {
    harness.cleanup();
  }
});

test('stale empty/malformed guard는 회수하고 여러 owner guard는 fail-closed다', () => {
  for (const kind of ['empty', 'malformed']) {
    const harness = makeHarness(`neo-file-operation-lock-${kind}-guard-`);
    try {
      fs.mkdirSync(harness.guardPath());
      if (kind === 'malformed') fs.writeFileSync(path.join(harness.guardPath(), 'owner.json'), '{broken');
      const old = new Date(harness.now() - 30001);
      for (const entry of fs.readdirSync(harness.guardPath())) fs.utimesSync(path.join(harness.guardPath(), entry), old, old);
      fs.utimesSync(harness.guardPath(), old, old);
      const handle = createJobOperationLock(harness.settings()).acquire('alpha');
      handle.release();
      assert.deepEqual(fs.readdirSync(harness.directory), []);
    } finally {
      harness.cleanup();
    }
  }

  const harness = makeHarness('neo-file-operation-lock-ambiguous-guard-');
  try {
    fs.mkdirSync(harness.guardPath());
    const old = harness.now() - 30001;
    writeOwnerFile(path.join(harness.guardPath(), 'owner.json'), owner('a', old, 1), old);
    writeOwnerFile(path.join(harness.guardPath(), 'claim-b.json'), owner('b', old, 2), old);
    fs.utimesSync(harness.guardPath(), new Date(old), new Date(old));
    assert.throws(() => createJobOperationLock(harness.settings()).acquire('alpha'), errorCode('JOB_CONFLICT'));
  } finally {
    harness.cleanup();
  }
});

test('이전 owner의 release는 교체된 owner file을 삭제하지 않는다', () => {
  const harness = makeHarness('neo-file-operation-lock-old-release-');
  try {
    const first = createJobOperationLock(harness.settings()).acquire('alpha');
    writeOwnerFile(harness.lockPath(), owner('new-owner', harness.now()));
    first.release();
    assert.equal(JSON.parse(fs.readFileSync(harness.lockPath(), 'utf8')).token, 'new-owner');
  } finally {
    harness.cleanup();
  }
});

test('이전 directory lock은 live 상태면 보호하고 dead stale이면 file lock으로 전환한다', () => {
  const harness = makeHarness('neo-file-operation-lock-legacy-');
  const lockPath = harness.lockPath();
  try {
    writeLegacyLock(lockPath, owner('legacy-owner', harness.now(), 9123));
    const locks = createJobOperationLock(harness.settings({ isProcessAlive: () => false }));
    assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));

    writeOwnerFile(path.join(lockPath, 'owner.json'), owner('legacy-owner', harness.now() - 30001, 9123));
    fs.writeFileSync(path.join(lockPath, 'heartbeat-legacy-owner'), `${harness.now() - 30001}\n`);
    const replacement = locks.acquire('alpha');
    assert.equal(fs.statSync(lockPath).isFile(), true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, replacement.token);
    replacement.release();
    assert.deepEqual(fs.readdirSync(harness.directory), []);
  } finally {
    harness.cleanup();
  }
});

test('acquire/release와 legacy 회수는 directory rename을 호출하지 않는다', () => {
  const harness = makeHarness('neo-file-operation-lock-no-directory-rename-');
  const lockPath = harness.lockPath();
  let renameCalls = 0;
  const noRenameFs = {
    ...fs,
    renameSync() {
      renameCalls += 1;
      const failure = new Error('directory rename unsupported');
      failure.code = 'ENOENT';
      throw failure;
    },
  };
  try {
    writeLegacyLock(lockPath, owner('legacy-owner', harness.now() - 30001, 9123), harness.now() - 30001);
    const handle = createJobOperationLock(harness.settings({ fs: noRenameFs })).acquire('alpha');
    handle.release();
    assert.equal(renameCalls, 0);
    assert.deepEqual(fs.readdirSync(harness.directory), []);
  } finally {
    harness.cleanup();
  }
});

test('JSH stat의 unixMilli만으로 incomplete file lease를 판정한다', () => {
  const harness = makeHarness('neo-file-operation-lock-jsh-stat-');
  const lockPath = harness.lockPath();
  fs.writeFileSync(lockPath, '{broken');
  const jshFs = {
    ...fs,
    statSync(target) {
      const current = fs.statSync(target);
      return {
        isDirectory: () => current.isDirectory(),
        mtime: { unixMilli: () => target === lockPath ? harness.now() - 30001 : current.mtimeMs },
      };
    },
  };
  try {
    const handle = createJobOperationLock(harness.settings({ fs: jshFs })).acquire('alpha');
    handle.release();
  } finally {
    harness.cleanup();
  }
});
