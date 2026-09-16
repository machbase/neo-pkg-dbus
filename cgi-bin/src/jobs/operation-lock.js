'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const { error } = require('../config/errors.js');

const DEFAULT_LEASE_MS = 30 * 1000;
const DEFAULT_HEARTBEAT_MS = 5 * 1000;
const MAX_ACQUIRE_ATTEMPTS = 8;

function defaultToken() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function jobConflict(name) {
  return error('JOB_CONFLICT', '다른 요청이 같은 Job을 변경하고 있습니다.', { name });
}

function defaultIsProcessAlive(pid) {
  try {
    const result = process.kill(pid, 0);
    return !isConfirmedMissingProcess(result);
  } catch (failure) {
    return !isConfirmedMissingProcess(failure);
  }
}

function isConfirmedMissingProcess(result) {
  if (result === false || Boolean(result && result.code === 'ESRCH')) return true;
  // Node throws an ESRCH Error for a missing PID. Neo JSH 8.5.11 instead
  // returns a GoError value with no `code`, for example:
  //   GoError: kill 4075 with 0: os: process already finished
  // Match only the platform's explicit missing-process messages. Unknown
  // probe errors (including EPERM) remain fail-closed and protect the lock.
  let message = '';
  try { message = String(result && result.message ? result.message : result || ''); } catch (_) {}
  return /\b(?:no such process|process already finished)\b/i.test(message);
}

function createJobOperationLock(options) {
  const settings = options || {};
  const fileSystem = settings.fs || fs;
  const directory = settings.directory || path.join(settings.cgiRoot, 'conf.d', '.job-operation-locks');
  const now = settings.now || Date.now;
  const randomToken = settings.randomToken || defaultToken;
  const randomReclaimToken = settings.randomReclaimToken || defaultToken;
  const startTimer = settings.setInterval || setInterval;
  const stopTimer = settings.clearInterval || clearInterval;
  const isProcessAlive = settings.isProcessAlive || defaultIsProcessAlive;
  const leaseMs = settings.leaseMs === undefined ? DEFAULT_LEASE_MS : settings.leaseMs;
  const heartbeatMs = settings.heartbeatMs === undefined ? DEFAULT_HEARTBEAT_MS : settings.heartbeatMs;

  fileSystem.mkdirSync(directory, { recursive: true });

  function isMissing(failure) {
    return Boolean(failure && failure.code === 'ENOENT');
  }

  function isAlreadyPresent(failure, target) {
    if (failure && failure.code === 'EEXIST') return true;
    // Neo JSH 8.5.11 wraps an O_EXCL collision as ENOENT. The path state is
    // authoritative; the wrapper's error code alone cannot identify absence.
    try {
      return fileSystem.existsSync(target);
    } catch (_) {
      return false;
    }
  }

  function modifiedAt(target) {
    const stat = fileSystem.statSync(target);
    if (stat.mtime && typeof stat.mtime.unixMilli === 'function') {
      const value = stat.mtime.unixMilli();
      if (Number.isFinite(value)) return value;
    }
    if (stat.mtime && typeof stat.mtime.getTime === 'function') {
      const value = stat.mtime.getTime();
      if (Number.isFinite(value)) return value;
    }
    return null;
  }

  function isDirectory(target) {
    const stat = fileSystem.statSync(target);
    return typeof stat.isDirectory === 'function' ? stat.isDirectory() : Boolean(stat.isDirectory);
  }

  function isValidOwner(owner) {
    return Boolean(owner)
      && typeof owner.token === 'string'
      && owner.token.length > 0
      && Number.isSafeInteger(owner.pid)
      && owner.pid > 0
      && Number.isFinite(owner.acquiredAt)
      && Number.isFinite(owner.heartbeatAt)
      && owner.heartbeatAt >= owner.acquiredAt;
  }

  function writeAll(descriptor, content) {
    let remaining = content;
    while (remaining.length > 0) {
      const count = fileSystem.writeSync(descriptor, remaining);
      if (!Number.isInteger(count) || count <= 0 || count > remaining.length) {
        const failure = new Error('lock 문서를 끝까지 기록하지 못했습니다.');
        failure.code = 'EIO';
        throw failure;
      }
      remaining = remaining.slice(count);
    }
  }

  function unlinkIfPresent(target) {
    try {
      fileSystem.unlinkSync(target);
      return true;
    } catch (failure) {
      if (isMissing(failure)) return false;
      throw failure;
    }
  }

  function writeExclusive(target, document) {
    let descriptor;
    let created = false;
    try {
      descriptor = fileSystem.openSync(target, 'wx', 0o600);
      created = true;
      writeAll(descriptor, `${JSON.stringify(document)}\n`);
      if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
    } catch (failure) {
      if (descriptor !== undefined) {
        try { fileSystem.closeSync(descriptor); } catch (closeFailure) { failure.closeError = closeFailure; }
      }
      if (created) {
        try { unlinkIfPresent(target); } catch (cleanupFailure) { failure.cleanupError = cleanupFailure; }
      }
      throw failure;
    }
  }

  function ownerDocument(token, timestamp) {
    return {
      token,
      pid: process.pid,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    };
  }

  function readJsonOwner(target) {
    try {
      const owner = JSON.parse(fileSystem.readFileSync(target, 'utf8'));
      return isValidOwner(owner) ? owner : null;
    } catch (_) {
      return null;
    }
  }

  function normalizedEntries(target) {
    return fileSystem.readdirSync(target).filter((entry) => entry !== '.' && entry !== '..');
  }

  function newestModifiedAt(target, entries) {
    let newest = modifiedAt(target);
    for (const entry of entries || []) {
      try {
        const value = modifiedAt(path.join(target, entry));
        if (Number.isFinite(value) && (!Number.isFinite(newest) || value > newest)) newest = value;
      } catch (_) {}
    }
    return newest;
  }

  function inspectLegacyLock(lockPath) {
    let entries;
    try {
      entries = normalizedEntries(lockPath);
    } catch (failure) {
      if (isMissing(failure)) return { missing: true };
      throw failure;
    }
    const ownerFiles = entries.filter((entry) => /^owner.*\.json$/.test(entry));
    const temporaryFiles = entries.filter((entry) => /^owner\.json\.tmp-/.test(entry));
    const heartbeatFiles = entries.filter((entry) => /^heartbeat-/.test(entry));
    const unexpected = entries.filter((entry) => !ownerFiles.includes(entry)
      && !temporaryFiles.includes(entry) && !heartbeatFiles.includes(entry));
    const lastModified = newestModifiedAt(lockPath, entries);
    if (!entries.includes('owner.json')) {
      return ownerFiles.length === 0 && unexpected.length === 0
        ? { missing: false, type: 'legacy-directory', incomplete: true, entries, lastActivity: lastModified }
        : { missing: false, type: 'legacy-directory', ambiguous: true, entries, lastActivity: lastModified };
    }
    if (ownerFiles.length !== 1 || temporaryFiles.length !== 0 || unexpected.length !== 0) {
      return { missing: false, type: 'legacy-directory', ambiguous: true, entries, lastActivity: lastModified };
    }
    const owner = readJsonOwner(path.join(lockPath, 'owner.json'));
    if (!owner) return { missing: false, type: 'legacy-directory', incomplete: true, entries, lastActivity: lastModified };
    let heartbeat = owner.heartbeatAt;
    try {
      const value = Number(String(fileSystem.readFileSync(
        path.join(lockPath, `heartbeat-${encodeURIComponent(owner.token)}`), 'utf8',
      )).trim());
      if (Number.isFinite(value) && value >= owner.acquiredAt) heartbeat = value;
    } catch (_) {}
    return { missing: false, type: 'legacy-directory', owner, entries, lastActivity: heartbeat };
  }

  function inspectLock(lockPath) {
    try {
      if (isDirectory(lockPath)) return inspectLegacyLock(lockPath);
    } catch (failure) {
      if (isMissing(failure)) return { missing: true };
      throw failure;
    }
    let lastActivity;
    try {
      lastActivity = modifiedAt(lockPath);
    } catch (failure) {
      if (isMissing(failure)) return { missing: true };
      throw failure;
    }
    const owner = readJsonOwner(lockPath);
    if (!owner) return { missing: false, type: 'file', incomplete: true, lastActivity };
    return { missing: false, type: 'file', owner, lastActivity: owner.heartbeatAt };
  }

  function requireReclaimable(state, name) {
    if (!state || state.missing) return;
    if (state.ambiguous) throw jobConflict(name);
    if (!Number.isFinite(state.lastActivity) || now() - state.lastActivity < leaseMs) throw jobConflict(name);
    if (state.incomplete) return;
    let alive = true;
    try { alive = isProcessAlive(state.owner.pid); } catch (_) { alive = true; }
    if (!isConfirmedMissingProcess(alive)) throw jobConflict(name);
  }

  function guardOwnerFile(guardPath) {
    return path.join(guardPath, 'owner.json');
  }

  function guardClaimFile(guardPath, token) {
    return path.join(guardPath, `claim-${encodeURIComponent(token)}.json`);
  }

  function writeExisting(target, document) {
    let descriptor;
    try {
      descriptor = fileSystem.openSync(target, 'w', 0o600);
      if (typeof fileSystem.fchmodSync === 'function') fileSystem.fchmodSync(descriptor, 0o600);
      writeAll(descriptor, `${JSON.stringify(document)}\n`);
      if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
    } catch (failure) {
      if (descriptor !== undefined) {
        try { fileSystem.closeSync(descriptor); } catch (closeFailure) { failure.closeError = closeFailure; }
      }
      throw failure;
    }
  }

  function inspectGuard(guardPath) {
    let entries;
    try {
      entries = normalizedEntries(guardPath);
    } catch (failure) {
      if (isMissing(failure)) return { missing: true };
      throw failure;
    }
    const lastActivity = newestModifiedAt(guardPath, entries);
    if (entries.length === 0) return { missing: false, empty: true, entries, lastActivity };
    if (entries.length !== 1) {
      return { missing: false, ambiguous: true, entries, lastActivity };
    }
    const entry = entries[0];
    const isOwner = entry === 'owner.json';
    const isClaim = /^claim-.*\.json$/.test(entry);
    if (!isOwner && !isClaim) return { missing: false, ambiguous: true, entries, lastActivity };
    const owner = readJsonOwner(path.join(guardPath, entry));
    if (!owner || (isClaim && entry !== path.basename(guardClaimFile(guardPath, owner.token)))) {
      return { missing: false, incomplete: true, entry, entries, lastActivity };
    }
    return { missing: false, owner, entry, entries, lastActivity: owner.heartbeatAt };
  }

  function releaseGuard(guardPath, ownerPath, token) {
    const current = readJsonOwner(ownerPath);
    if (!current || current.token !== token) return;
    try {
      if (!unlinkIfPresent(ownerPath)) return;
    } catch (_) {
      return;
    }
    try {
      fileSystem.rmdirSync(guardPath);
    } catch (_) {}
  }

  function acquireGuard(guardPath, name) {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        fileSystem.mkdirSync(guardPath);
      } catch (failure) {
        if (!isAlreadyPresent(failure, guardPath)) throw failure;
      }

      const state = inspectGuard(guardPath);
      if (state.missing) continue;
      if (state.empty) {
        const token = randomReclaimToken();
        const ownerPath = guardOwnerFile(guardPath);
        try {
          writeExclusive(ownerPath, ownerDocument(token, now()));
          return { token, release() { releaseGuard(guardPath, ownerPath, token); } };
        } catch (failure) {
          if (isAlreadyPresent(failure, ownerPath) || isMissing(failure)) continue;
          throw failure;
        }
      }

      requireReclaimable(state, name);
      const current = inspectGuard(guardPath);
      if (current.missing || current.empty) continue;
      requireReclaimable(current, name);
      if (state.entry !== current.entry) throw jobConflict(name);
      if (state.owner && (!current.owner || current.owner.token !== state.owner.token)) throw jobConflict(name);

      const currentPath = path.join(guardPath, current.entry);
      if (current.entry !== 'owner.json') {
        if (!unlinkIfPresent(currentPath)) continue;
        continue;
      }

      const token = randomReclaimToken();
      const claimPath = guardClaimFile(guardPath, token);
      try {
        fileSystem.renameSync(currentPath, claimPath);
      } catch (failure) {
        if (isMissing(failure)) continue;
        throw failure;
      }
      try {
        writeExisting(claimPath, ownerDocument(token, now()));
      } catch (failure) {
        throw failure;
      }
      return { token, release() { releaseGuard(guardPath, claimPath, token); } };
    }
    throw jobConflict(name);
  }

  function removeLegacyLock(lockPath, expected, name) {
    const current = inspectLegacyLock(lockPath);
    requireReclaimable(current, name);
    if (expected.owner && (!current.owner || current.owner.token !== expected.owner.token)) throw jobConflict(name);
    if (current.ambiguous) throw jobConflict(name);
    for (const entry of current.entries || []) {
      const target = path.join(lockPath, entry);
      try {
        if (isDirectory(target)) throw jobConflict(name);
      } catch (failure) {
        if (failure && failure.code === 'JOB_CONFLICT') throw failure;
        if (!isMissing(failure)) throw failure;
        continue;
      }
      unlinkIfPresent(target);
    }
    try {
      fileSystem.rmdirSync(lockPath);
    } catch (failure) {
      if (!isMissing(failure)) throw failure;
    }
  }

  function removeStaleLock(lockPath, state, name) {
    const current = inspectLock(lockPath);
    if (current.missing) return;
    requireReclaimable(current, name);
    if (state.owner && (!current.owner || current.owner.token !== state.owner.token)) throw jobConflict(name);
    if (current.type === 'legacy-directory') removeLegacyLock(lockPath, current, name);
    else unlinkIfPresent(lockPath);
  }

  function readOwnedFile(lockPath, name, token) {
    const state = inspectLock(lockPath);
    if (state.missing || state.type !== 'file' || !state.owner || state.owner.token !== token) throw jobConflict(name);
    return state.owner;
  }

  function replaceOwner(lockPath, name, token, owner) {
    const temporaryPath = `${lockPath}.tmp-${defaultToken()}`;
    try {
      writeExclusive(temporaryPath, owner);
      readOwnedFile(lockPath, name, token);
      fileSystem.renameSync(temporaryPath, lockPath);
    } catch (failure) {
      try { unlinkIfPresent(temporaryPath); } catch (cleanupFailure) { failure.cleanupError = cleanupFailure; }
      throw failure;
    }
  }

  function removeOwnedFile(lockPath, name, token) {
    let owner;
    try { owner = readOwnedFile(lockPath, name, token); } catch (_) { return false; }
    if (owner.token !== token) return false;
    return unlinkIfPresent(lockPath);
  }

  function createHandle(name, lockPath, token) {
    function assertOwned() {
      readOwnedFile(lockPath, name, token);
    }

    let timer;
    try {
      timer = startTimer(() => {
        try {
          const owner = readOwnedFile(lockPath, name, token);
          replaceOwner(lockPath, name, token, { ...owner, heartbeatAt: now() });
        } catch (_) {}
      }, heartbeatMs);
    } catch (failure) {
      try { removeOwnedFile(lockPath, name, token); } catch (cleanupFailure) { failure.cleanupError = cleanupFailure; }
      throw failure;
    }

    function release() {
      let timerFailure = null;
      try { stopTimer(timer); } catch (failure) { timerFailure = failure; }
      // A timer implementation failure must never turn a completed CGI
      // mutation into a permanent Job lock.
      removeOwnedFile(lockPath, name, token);
      if (timerFailure) throw timerFailure;
    }

    return { token, assertOwned, release };
  }

  function acquire(name) {
    const lockPath = path.join(directory, `${name}.lock`);
    const guardPath = `${lockPath}.reclaim`;
    const guard = acquireGuard(guardPath, name);
    let handle;
    try {
      const state = inspectLock(lockPath);
      if (!state.missing) {
        requireReclaimable(state, name);
        removeStaleLock(lockPath, state, name);
      }

      const token = randomToken();
      const timestamp = now();
      try {
        writeExclusive(lockPath, ownerDocument(token, timestamp));
      } catch (failure) {
        if (isAlreadyPresent(failure, lockPath)) throw jobConflict(name);
        throw failure;
      }
      handle = createHandle(name, lockPath, token);
    } finally {
      guard.release();
    }
    return handle;
  }

  function assertAvailable(name) {
    const state = inspectLock(path.join(directory, `${name}.lock`));
    if (!state.missing) requireReclaimable(state, name);
  }

  return { acquire, assertAvailable };
}

module.exports = { createJobOperationLock };
