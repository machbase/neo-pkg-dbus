'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function withoutGlobalProcess(operation) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'process');
  try {
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      enumerable: original.enumerable,
      writable: true,
      value: undefined,
    });
    return operation();
  } finally {
    Object.defineProperty(globalThis, 'process', original);
  }
}

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

test('JSH처럼 전역 process가 없어도 Job operation lock을 획득하고 해제한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-jsh-operation-lock-'));
  const modulePath = path.join(__dirname, '..', 'src', 'jobs', 'operation-lock.js');
  try {
    withoutGlobalProcess(() => {
      const { createJobOperationLock } = loadFresh(modulePath);
      const lock = createJobOperationLock({
        directory,
        setInterval: () => undefined,
        clearInterval: () => undefined,
      });
      const handle = lock.acquire('alpha');
      assert.doesNotThrow(() => handle.assertOwned());
      handle.release();
    });
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    delete require.cache[require.resolve(modulePath)];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('JSH처럼 전역 process가 없어도 ProfileStore를 만들고 빈 목록을 읽는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-jsh-profile-store-'));
  const modulePath = path.join(__dirname, '..', 'src', 'profiles', 'store.js');
  try {
    withoutGlobalProcess(() => {
      const { ProfileStore } = loadFresh(modulePath);
      const store = new ProfileStore({ cgiRoot: root });
      assert.deepEqual(store.list(), []);
    });
  } finally {
    delete require.cache[require.resolve(modulePath)];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
