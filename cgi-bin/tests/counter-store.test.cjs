'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CounterStore } = require('../src/example/counter.js');

function temporaryEntries(store, name) {
  return fs.readdirSync(store.resultDir)
    .filter((entry) => entry.startsWith(`.${name}.`) && entry.endsWith('.tmp'));
}

function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pkg-counter-test-'));
  try {
    const times = [
      '2026-07-28T00:00:00.000Z',
      '2026-07-28T00:00:01.000Z',
    ];
    const store = new CounterStore(dataDir, { now: () => times.shift() });
    assert.equal(store.read('example'), null);

    const originalOpenSync = fs.openSync;
    fs.openSync = function rejectCounterLocks(file, ...args) {
      if (/\.counter(?:\.commit)?\.lock$/.test(String(file))) {
        throw new Error(`counter lock을 만들면 안 됩니다: ${file}`);
      }
      return originalOpenSync.call(fs, file, ...args);
    };
    try {
      assert.deepEqual(store.increment('example'), {
        count: 1,
        startedAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      });
    } finally {
      fs.openSync = originalOpenSync;
    }

    assert.deepEqual(store.increment('example'), {
      count: 2,
      startedAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:01.000Z',
    });
    assert.deepEqual(store.read('example'), {
      count: 2,
      startedAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:01.000Z',
    });
    assert.deepEqual(temporaryEntries(store, 'example'), []);
    assert.equal(
      fs.readdirSync(store.resultDir).some((entry) => entry.includes('.lock')),
      false,
    );

    const serviceStore = new CounterStore(dataDir, {
      resultDir: dataDir,
      now: () => '2026-07-28T00:00:02.000Z',
    });
    assert.deepEqual(serviceStore.increment('service'), {
      count: 1,
      startedAt: '2026-07-28T00:00:02.000Z',
      updatedAt: '2026-07-28T00:00:02.000Z',
    });
    assert.equal(fs.existsSync(path.join(dataDir, 'service.counter.json')), true);

    const atomicStore = new CounterStore(dataDir, {
      now: () => '2026-07-28T00:00:03.000Z',
    });
    const atomicPath = atomicStore.resultPath('atomic');
    fs.writeFileSync(atomicPath, `${JSON.stringify({
      count: 4,
      startedAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:02.000Z',
    })}\n`, 'utf8');
    const originalRenameSync = fs.renameSync;
    let observedTemporaryPath = '';
    fs.renameSync = function observeAtomicReplace(source, destination) {
      observedTemporaryPath = source;
      assert.equal(path.dirname(source), path.dirname(destination));
      assert.equal(destination, atomicPath);
      assert.equal(JSON.parse(fs.readFileSync(atomicPath, 'utf8')).count, 4);
      assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).count, 5);
      return originalRenameSync.call(fs, source, destination);
    };
    try {
      assert.equal(atomicStore.increment('atomic').count, 5);
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.notEqual(observedTemporaryPath, '');
    assert.equal(atomicStore.read('atomic').count, 5);
    assert.deepEqual(temporaryEntries(atomicStore, 'atomic'), []);

    const preserved = atomicStore.read('atomic');
    fs.renameSync = function failRename() {
      const error = new Error('rename failed');
      error.code = 'EACCES';
      throw error;
    };
    try {
      assert.throws(() => atomicStore.increment('atomic'), /rename failed/);
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.deepEqual(atomicStore.read('atomic'), preserved);
    assert.deepEqual(
      temporaryEntries(atomicStore, 'atomic'),
      [],
      'rename 실패 뒤 임시 파일을 남기면 안 됩니다.',
    );

    fs.writeFileSync(store.resultPath('broken'), '{broken', 'utf8');
    assert.throws(() => store.read('broken'), /JSON|Unexpected|position/i);
    assert.throws(() => store.increment('INVALID'), /카운터 이름/);

    assert.equal(store.remove('example'), true);
    assert.equal(store.read('example'), null);
    assert.equal(store.remove('example'), false);

    const cleanupName = 'cleanup';
    store.increment(cleanupName);
    const realTemporary = path.join(store.resultDir, `.${cleanupName}.123.tmp`);
    const unrelatedFile = path.join(store.resultDir, `.${cleanupName}.keep.json`);
    fs.writeFileSync(realTemporary, 'unfinished', 'utf8');
    fs.writeFileSync(unrelatedFile, 'keep me', 'utf8');
    assert.equal(store.remove(cleanupName), true);
    assert.equal(store.read(cleanupName), null);
    assert.equal(fs.existsSync(realTemporary), false);
    assert.equal(fs.readFileSync(unrelatedFile, 'utf8'), 'keep me');

    console.log('atomic single-writer counter store: ok');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run();
