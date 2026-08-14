'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const { error } = require('../config/errors.js');

const DEFAULT_LEASE_MS = 30 * 1000;
const DEFAULT_HEARTBEAT_MS = 5 * 1000;

function defaultToken() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function jobConflict(name) {
  return error('JOB_CONFLICT', '다른 요청이 같은 Job을 변경하고 있습니다.', { name });
}

function defaultIsProcessAlive(pid) {
  try {
    const result = process.kill(pid, 0);
    if (result && result.code === 'ESRCH') return false;
    return true;
  } catch (failure) {
    return !(failure && failure.code === 'ESRCH');
  }
}

function isConfirmedMissingProcess(result) {
  return result === false || Boolean(result && result.code === 'ESRCH');
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

  function ownerFile(lockDirectory) {
    return path.join(lockDirectory, 'owner.json');
  }

  function heartbeatFile(lockDirectory, token) {
    return path.join(lockDirectory, `heartbeat-${encodeURIComponent(token)}`);
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

  function cleanupDetachedDirectory(detachedDirectory) {
    let entries;
    try {
      entries = fileSystem.readdirSync(detachedDirectory);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return;
      throw failure;
    }
    for (const entry of entries) {
      if (entry === '.' || entry === '..') continue;
      try {
        fileSystem.unlinkSync(path.join(detachedDirectory, entry));
      } catch (failure) {
        if (!failure || failure.code !== 'ENOENT') throw failure;
      }
    }
    try {
      fileSystem.rmdirSync(detachedDirectory);
    } catch (failure) {
      if (!failure || failure.code !== 'ENOENT') throw failure;
    }
  }

  function writeOwnerDocument(ownerPath, owner, name) {
    const temporaryPath = `${ownerPath}.tmp-${defaultToken()}`;
    let remaining = `${JSON.stringify(owner)}\n`;
    let descriptor;
    try {
      descriptor = fileSystem.openSync(temporaryPath, 'wx');
      while (remaining.length > 0) {
        const count = fileSystem.writeSync(descriptor, remaining);
        if (!Number.isInteger(count) || count <= 0 || count > remaining.length) {
          const failure = new Error('owner 문서를 끝까지 기록하지 못했습니다.');
          failure.code = 'EIO';
          throw failure;
        }
        remaining = remaining.slice(count);
      }
      if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
      if (fileSystem.existsSync(ownerPath)) throw jobConflict(name);
      fileSystem.renameSync(temporaryPath, ownerPath);
    } catch (failure) {
      if (descriptor !== undefined) {
        try {
          fileSystem.closeSync(descriptor);
        } catch (closeFailure) {
          failure.closeError = closeFailure;
        }
      }
      try {
        fileSystem.unlinkSync(temporaryPath);
      } catch (cleanupFailure) {
        if (!cleanupFailure || cleanupFailure.code !== 'ENOENT') failure.cleanupError = cleanupFailure;
      }
      throw failure;
    }
  }

  function readCanonicalOwner(lockDirectory, name) {
    let entries;
    try {
      entries = fileSystem.readdirSync(lockDirectory);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return undefined;
      throw jobConflict(name);
    }
    const finalFiles = entries.filter((entry) => /^owner.*\.json$/.test(entry));
    const hasOwner = entries.includes('owner.json');
    const temporaryFiles = entries.filter((entry) => /^owner\.json\.tmp-/.test(entry));
    if (!hasOwner) return finalFiles.length === 0 ? { incomplete: true } : { ambiguous: true };
    if (finalFiles.length !== 1 || temporaryFiles.length !== 0) return { ambiguous: true };
    let owner;
    try {
      owner = JSON.parse(fileSystem.readFileSync(ownerFile(lockDirectory), 'utf8'));
    } catch (_) {
      return { incomplete: true };
    }
    if (!isValidOwner(owner)) return { incomplete: true };
    return owner;
  }

  function readOwner(lockDirectory, name) {
    const owner = readCanonicalOwner(lockDirectory, name);
    if (!owner || owner.incomplete || owner.ambiguous) throw jobConflict(name);
    return owner;
  }

  function writeOwner(lockDirectory, owner, name) {
    writeOwnerDocument(ownerFile(lockDirectory), owner, name);
  }

  function writeHeartbeat(lockDirectory, token, timestamp) {
    fileSystem.writeFileSync(heartbeatFile(lockDirectory, token), `${timestamp}\n`);
  }

  function heartbeatAt(lockDirectory, owner) {
    try {
      const value = Number(String(fileSystem.readFileSync(heartbeatFile(lockDirectory, owner.token), 'utf8')).trim());
      if (Number.isFinite(value) && value >= owner.acquiredAt) return value;
    } catch (_) {}
    return owner.heartbeatAt;
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

  function cleanupQuarantine(reclaimedDirectory) {
    cleanupDetachedDirectory(reclaimedDirectory);
  }

  function discardCanonical(lockDirectory, name, token, suffix) {
    if (readOwner(lockDirectory, name).token !== token) throw jobConflict(name);
    const detachedDirectory = `${lockDirectory}.${suffix}-${token}`;
    fileSystem.renameSync(lockDirectory, detachedDirectory);
    cleanupDetachedDirectory(detachedDirectory);
  }

  function discardUnownedCanonical(lockDirectory, token) {
    const detachedDirectory = `${lockDirectory}.failed-${token}`;
    fileSystem.renameSync(lockDirectory, detachedDirectory);
    cleanupDetachedDirectory(detachedDirectory);
  }

  function reclaimOwnerFile(reclaimMutex, token) {
    return path.join(reclaimMutex, `owner-${encodeURIComponent(token)}.json`);
  }

  function writeReclaimOwner(reclaimMutex, token) {
    const timestamp = now();
    const ownerPath = reclaimOwnerFile(reclaimMutex, token);
    writeOwnerDocument(ownerPath, {
      token,
      pid: process.pid,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    }, 'reclaim-mutex');
  }

  function readReclaimOwner(reclaimMutex, name) {
    let entries;
    try {
      entries = fileSystem.readdirSync(reclaimMutex);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return undefined;
      throw jobConflict(name);
    }
    const ownerFiles = entries.filter((entry) => /^owner-.*\.json$/.test(entry));
    const temporaryFiles = entries.filter((entry) => /^owner-.*\.tmp-/.test(entry));
    if (ownerFiles.length === 0) return temporaryFiles.length === 0 ? null : { incomplete: true };
    if (ownerFiles.length !== 1 || temporaryFiles.length !== 0) return { ambiguous: true };
    let owner;
    try {
      owner = JSON.parse(fileSystem.readFileSync(path.join(reclaimMutex, ownerFiles[0]), 'utf8'));
    } catch (_) {
      return { incomplete: true };
    }
    if (!isValidOwner(owner)
      || ownerFiles[0] !== path.basename(reclaimOwnerFile(reclaimMutex, owner.token))) {
      return { incomplete: true };
    }
    return owner;
  }

  function mayReclaimMutex(reclaimMutex, name) {
    let fallbackModifiedAt;
    try {
      fallbackModifiedAt = modifiedAt(reclaimMutex);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return undefined;
      throw jobConflict(name);
    }
    let owner;
    try {
      owner = readReclaimOwner(reclaimMutex, name);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return undefined;
      throw jobConflict(name);
    }
    let lastActivity;
    if (owner && !owner.incomplete && !owner.ambiguous) lastActivity = owner.heartbeatAt;
    else {
      lastActivity = fallbackModifiedAt;
    }
    if (!Number.isFinite(lastActivity) || now() - lastActivity < leaseMs) throw jobConflict(name);
    if (owner === null) return null;
    if (owner === undefined) return undefined;
    if (owner.incomplete) return null;
    if (owner.ambiguous) throw jobConflict(name);
    let alive = true;
    try {
      alive = isProcessAlive(owner.pid);
    } catch (_) {
      alive = true;
    }
    if (!isConfirmedMissingProcess(alive)) throw jobConflict(name);
    return owner;
  }

  function quarantineStaleReclaimMutex(reclaimMutex, name) {
    if (mayReclaimMutex(reclaimMutex, name) === undefined) return false;
    const quarantineToken = randomReclaimToken();
    const detachedMutex = `${reclaimMutex}.reclaimed-${quarantineToken}`;
    try {
      fileSystem.renameSync(reclaimMutex, detachedMutex);
    } catch (renameFailure) {
      if (renameFailure && renameFailure.code === 'ENOENT') return false;
      throw jobConflict(name);
    }
    cleanupDetachedDirectory(detachedMutex);
    return true;
  }

  function acquireReclaimMutex(reclaimMutex, name) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (fileSystem.existsSync(reclaimMutex)) {
        quarantineStaleReclaimMutex(reclaimMutex, name);
        continue;
      }

      const token = randomReclaimToken();
      const pendingMutex = `${reclaimMutex}.pending-${encodeURIComponent(token)}`;
      try {
        fileSystem.mkdirSync(pendingMutex);
      } catch (failure) {
        if (failure && failure.code === 'EEXIST') throw jobConflict(name);
        throw failure;
      }

      try {
        writeReclaimOwner(pendingMutex, token);
      } catch (failure) {
        try {
          cleanupDetachedDirectory(pendingMutex);
        } catch (cleanupFailure) {
          failure.cleanupError = cleanupFailure;
        }
        if (failure && failure.code === 'ENOENT') throw jobConflict(name);
        throw failure;
      }

      if (fileSystem.existsSync(reclaimMutex)) {
        cleanupDetachedDirectory(pendingMutex);
        quarantineStaleReclaimMutex(reclaimMutex, name);
        continue;
      }
      try {
        fileSystem.renameSync(pendingMutex, reclaimMutex);
      } catch (failure) {
        let cleanupFailure;
        try {
          cleanupDetachedDirectory(pendingMutex);
        } catch (pendingCleanupFailure) {
          cleanupFailure = pendingCleanupFailure;
        }
        if (cleanupFailure) {
          cleanupFailure.publishError = failure;
          throw cleanupFailure;
        }
        if (failure && failure.code === 'ENOENT') throw jobConflict(name);
        if (failure && (failure.code === 'EEXIST' || failure.code === 'ENOTEMPTY')) continue;
        throw failure;
      }
      return token;
    }
    throw jobConflict(name);
  }

  function releaseReclaimMutex(reclaimMutex, name, token) {
    const owner = readReclaimOwner(reclaimMutex, name);
    if (!owner || owner.token !== token) return;
    try {
      fileSystem.unlinkSync(reclaimOwnerFile(reclaimMutex, token));
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return;
      throw failure;
    }
    try {
      fileSystem.rmdirSync(reclaimMutex);
    } catch (failure) {
      if (failure && (failure.code === 'ENOENT' || failure.code === 'ENOTEMPTY')) return;
      throw failure;
    }
  }

  function createHandle(name, lockDirectory, token) {
    function assertOwned() {
      if (readOwner(lockDirectory, name).token !== token) throw jobConflict(name);
    }

    let timer;
    try {
      timer = startTimer(() => {
        try {
          assertOwned();
          writeHeartbeat(lockDirectory, token, now());
        } catch (_) {}
      }, heartbeatMs);
    } catch (failure) {
      try {
        discardCanonical(lockDirectory, name, token, 'failed');
      } catch (cleanupFailure) {
        failure.cleanupError = cleanupFailure;
      }
      throw failure;
    }

    function release() {
      stopTimer(timer);
      let owner;
      try {
        owner = readOwner(lockDirectory, name);
      } catch (_) {
        return;
      }
      if (owner.token !== token) return;
      const releasedDirectory = `${lockDirectory}.released-${token}`;
      fileSystem.renameSync(lockDirectory, releasedDirectory);
      cleanupDetachedDirectory(releasedDirectory);
    }

    return { token, assertOwned, release };
  }

  function installOwnerDocument(lockDirectory, name, token) {
    const timestamp = now();
    try {
      writeOwner(lockDirectory, {
        token,
        pid: process.pid,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
      }, name);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') throw jobConflict(name);
      throw failure;
    }
  }

  function mayReclaim(lockDirectory, name) {
    let fallbackModifiedAt;
    try {
      fallbackModifiedAt = modifiedAt(lockDirectory);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return null;
      throw jobConflict(name);
    }
    let owner;
    try {
      owner = readCanonicalOwner(lockDirectory, name);
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') return null;
      throw jobConflict(name);
    }
    let lastActivity;
    if (owner && !owner.incomplete && !owner.ambiguous) lastActivity = heartbeatAt(lockDirectory, owner);
    else {
      lastActivity = fallbackModifiedAt;
    }
    if (!Number.isFinite(lastActivity) || now() - lastActivity < leaseMs) throw jobConflict(name);
    if (owner === undefined || owner === null) return null;
    if (owner.incomplete) return owner;
    if (owner.ambiguous) throw jobConflict(name);
    let alive = true;
    try {
      alive = isProcessAlive(owner.pid);
    } catch (_) {
      alive = true;
    }
    if (!isConfirmedMissingProcess(alive)) throw jobConflict(name);
    return owner;
  }

  function acquire(name) {
    const lockDirectory = path.join(directory, `${name}.lock`);
    const reclaimMutex = `${lockDirectory}.reclaim`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (fileSystem.existsSync(reclaimMutex)) {
        quarantineStaleReclaimMutex(reclaimMutex, name);
        continue;
      }
      try {
        fileSystem.mkdirSync(lockDirectory);
      } catch (failure) {
        if (!failure || failure.code !== 'EEXIST') throw failure;
        const mutexToken = acquireReclaimMutex(reclaimMutex, name);
        let mutexHeld = true;
        let reclaimedDirectory = null;
        let installedToken = null;
        let replacementDirectoryCreated = false;
        let replacementToken = null;
        let cleanupStarted = false;
        try {
          if (mayReclaim(lockDirectory, name) === null) continue;

          const token = randomToken();
          replacementToken = token;
          reclaimedDirectory = `${lockDirectory}.reclaimed-${token}`;
          try {
            fileSystem.renameSync(lockDirectory, reclaimedDirectory);
          } catch (renameFailure) {
            if (renameFailure && renameFailure.code === 'ENOENT') continue;
            throw jobConflict(name);
          }

          fileSystem.mkdirSync(lockDirectory);
          replacementDirectoryCreated = true;
          installOwnerDocument(lockDirectory, name, token);
          installedToken = token;
          cleanupStarted = true;
          cleanupQuarantine(reclaimedDirectory);
          reclaimedDirectory = null;

          mutexHeld = false;
          releaseReclaimMutex(reclaimMutex, name, mutexToken);
          return createHandle(name, lockDirectory, token);
        } catch (reclaimFailure) {
          if (installedToken !== null) {
            try {
              discardCanonical(lockDirectory, name, installedToken, 'failed');
            } catch (cleanupFailure) {
              reclaimFailure.cleanupError = cleanupFailure;
            }
          } else if (replacementDirectoryCreated && fileSystem.existsSync(lockDirectory)) {
            try {
              discardUnownedCanonical(lockDirectory, replacementToken);
            } catch (cleanupFailure) {
              reclaimFailure.cleanupError = cleanupFailure;
            }
          }
          if (reclaimedDirectory !== null && !cleanupStarted && !fileSystem.existsSync(lockDirectory)) {
            try {
              fileSystem.renameSync(reclaimedDirectory, lockDirectory);
              reclaimedDirectory = null;
            } catch (restoreFailure) {
              reclaimFailure.restoreError = restoreFailure;
            }
          }
          throw reclaimFailure;
        } finally {
          if (mutexHeld) {
            mutexHeld = false;
            releaseReclaimMutex(reclaimMutex, name, mutexToken);
          }
        }
      }

      let token;
      try {
        token = randomToken();
        installOwnerDocument(lockDirectory, name, token);
      } catch (failure) {
        throw failure;
      }
      return createHandle(name, lockDirectory, token);
    }
    throw jobConflict(name);
  }

  function assertAvailable(name) {
    const lockDirectory = path.join(directory, `${name}.lock`);
    mayReclaim(lockDirectory, name);
  }

  return { acquire, assertAvailable };
}

module.exports = { createJobOperationLock };
