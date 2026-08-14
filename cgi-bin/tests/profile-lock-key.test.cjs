'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

function loadWithoutCrypto() {
  const helperPath = require.resolve('../src/config/profile-lock-key.js');
  delete require.cache[helperPath];
  const originalLoad = Module._load;
  Module._load = function loadWithoutCrypto(request, parent, isMain) {
    if (request === 'crypto') throw new Error('crypto module is unavailable');
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(helperPath); } finally { Module._load = originalLoad; }
}

const { profileLockKey } = loadWithoutCrypto();
const vectors = ['', 'abc', '한글 Profile 키', 'p'.repeat(300)];

vectors.forEach((source) => {
  const expected = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  const actual = profileLockKey(source);
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{64}$/);
});

console.log('Profile lock key SHA-256: ok');
