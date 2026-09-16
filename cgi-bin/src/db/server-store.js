'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../config/atomic-json.js');
const { error } = require('../config/errors.js');
const { createJobOperationLock } = require('../jobs/operation-lock.js');

const SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SERVER_JSON_BYTES = 64 * 1024;

function validateName(name) {
  if (typeof name !== 'string' || !SERVER_NAME.test(name) || /[\\/]/.test(name)) {
    throw error('DB_SERVER_INVALID', 'DB server name 형식이 잘못되었습니다.');
  }
  return name;
}

function validateDocument(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error('DB_SERVER_INVALID', '등록 DB server 설정은 객체여야 합니다.', { name });
  }
  if (value.schemaVersion !== 1 || value.name !== name) {
    throw error('DB_SERVER_INVALID', '등록 DB server의 schemaVersion 또는 name이 잘못되었습니다.', { name });
  }
  if (typeof value.host !== 'string' || !value.host.trim()
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.user !== 'string' || !value.user
    || typeof value.password !== 'string' || !value.password
    || typeof value.defaultTable !== 'string' || typeof value.valueColumn !== 'string'
    || typeof value.stringValueColumn !== 'string') {
    throw error('DB_SERVER_INVALID', '등록 DB server 연결 설정이 잘못되었습니다.', { name });
  }
  return value;
}

function createServerStore(options) {
  const settings = options || {};
  const directory = settings.directory || path.join(settings.cgiRoot, 'conf.d', 'db-servers');
  const jobDirectory = settings.jobDir || (settings.cgiRoot
    ? path.join(settings.cgiRoot, 'conf.d', 'jobs')
    : path.join(path.dirname(directory), 'jobs'));
  const atomicWriter = settings.atomicWriter || writeJsonAtomic;
  const operationLock = settings.operationLock || createJobOperationLock({
    directory: settings.lockDirectory || path.join(directory, '.operation-locks'),
  });

  function file(name) {
    return path.join(directory, `${validateName(name)}.json`);
  }

  function read(name) {
    const validName = validateName(name);
    let source;
    try {
      source = fs.readFileSync(file(validName), 'utf8');
    } catch (readError) {
      if (readError && readError.code === 'ENOENT') return null;
      throw readError;
    }
    if (source.length > MAX_SERVER_JSON_BYTES) {
      throw error('DB_SERVER_INVALID', `등록 DB server JSON은 ${MAX_SERVER_JSON_BYTES} bytes 이하여야 합니다.`, {
        name: validName,
      });
    }
    try {
      const document = validateDocument(validName, {
        defaultTable: '', valueColumn: '', stringValueColumn: '',
        ...JSON.parse(source),
      });
      // Profiles written by versions before 1.0.1 may contain only the table
      // name. VALUE is the package convention for that incomplete mapping.
      // Keep the fallback in memory so an existing standard table is usable
      // immediately; the next profile save persists it through documentFrom().
      if (document.defaultTable && !document.valueColumn) document.valueColumn = 'VALUE';
      return document;
    } catch (parseError) {
      if (parseError && parseError.code) throw parseError;
      throw error('DB_SERVER_INVALID', '등록 DB server JSON을 읽을 수 없습니다.', { name: validName });
    }
  }

  function publicValue(value) {
    if (!value) return null;
    return {
      schemaVersion: value.schemaVersion,
      name: value.name,
      host: value.host,
      port: value.port,
      user: value.user,
      hasPassword: Boolean(value.password),
      defaultTable: value.defaultTable,
      valueColumn: value.valueColumn,
      stringValueColumn: value.stringValueColumn,
    };
  }

  function documentFrom(payload, current) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw error('DB_SERVER_INVALID', 'DB server 요청은 객체여야 합니다.');
    }
    const name = validateName(current ? current.name : payload.name);
    const defaultTable = typeof payload.defaultTable === 'string' ? payload.defaultTable.toUpperCase() : '';
    return validateDocument(name, {
      schemaVersion: 1,
      name,
      host: payload.host,
      port: Number(payload.port),
      user: payload.user,
      password: payload.password,
      defaultTable,
      valueColumn: typeof payload.valueColumn === 'string' && payload.valueColumn.trim()
        ? payload.valueColumn.toUpperCase() : (defaultTable ? 'VALUE' : ''),
      stringValueColumn: typeof payload.stringValueColumn === 'string' ? payload.stringValueColumn.toUpperCase() : '',
    });
  }

  function ensureLocalhost() {
    const name = 'localhost';
    if (read(name)) return;
    fs.mkdirSync(directory, { recursive: true });
    atomicWriter(file(name), validateDocument(name, {
      schemaVersion: 1, name, host: '127.0.0.1', port: 5656, user: 'sys', password: 'manager',
      defaultTable: 'DEFAULT_DBUS', valueColumn: 'VALUE', stringValueColumn: '',
    }));
  }

  function referencedJobs(name) {
    let entries;
    try { entries = fs.readdirSync(jobDirectory); } catch (readError) {
      if (readError && readError.code === 'ENOENT') return [];
      throw error('DB_SERVER_REFERENCE_UNKNOWN', 'Job 참조 목록을 읽을 수 없어 DB server 삭제를 중단했습니다.', {
        problem: 'directory-read-failed',
      });
    }
    return entries.filter((entry) => entry.endsWith('.json')).sort().reduce((result, entry) => {
      const stem = entry.slice(0, -5);
      if (!JOB_NAME.test(stem)) {
        throw error('DB_SERVER_REFERENCE_UNKNOWN', 'Job 참조 상태를 안전하게 확인할 수 없습니다.', {
          file: entry, problem: 'invalid-file-name',
        });
      }
      let source;
      try {
        source = fs.readFileSync(path.join(jobDirectory, entry), 'utf8');
      } catch (_) {
        throw error('DB_SERVER_REFERENCE_UNKNOWN', 'Job 참조 파일을 읽을 수 없어 DB server 삭제를 중단했습니다.', {
          file: entry, problem: 'read-failed',
        });
      }
      let document;
      try { document = JSON.parse(source); } catch (_) {
        throw error('DB_SERVER_REFERENCE_UNKNOWN', 'Job 참조 JSON을 해석할 수 없어 DB server 삭제를 중단했습니다.', {
          file: entry, problem: 'invalid-json',
        });
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)
        || document.schemaVersion !== 1 || document.name !== stem
        || !document.database || typeof document.database !== 'object' || Array.isArray(document.database)
        || typeof document.database.server !== 'string' || !document.database.server) {
        throw error('DB_SERVER_REFERENCE_UNKNOWN', 'Job 참조 schema를 확인할 수 없어 DB server 삭제를 중단했습니다.', {
          file: entry, problem: document && document.name !== stem ? 'name-mismatch' : 'invalid-schema',
        });
      }
      if (document.database.server === name) result.push(stem);
      return result;
    }, []);
  }

  function complete(callback, operation) {
    try { callback(null, operation()); } catch (failure) { callback(failure); }
  }

  function withLock(name, callback, operation) {
    let handle;
    try {
      handle = operationLock.acquire(`db-server-${validateName(name)}`);
      const value = operation(handle);
      handle.release();
      handle = null;
      callback(null, value);
    } catch (failure) {
      if (handle) {
        try { handle.release(); } catch (cleanupError) { failure.cleanupError = cleanupError; }
      }
      callback(failure);
    }
  }

  return {
    get(name, callback) {
      complete(callback, () => read(name));
    },
    getPublic(name, callback) {
      complete(callback, () => {
        const value = read(name);
        if (!value) throw error('DB_SERVER_NOT_FOUND', '등록 DB server를 찾을 수 없습니다.', { name });
        return publicValue(value);
      });
    },
    list(callback) {
      complete(callback, () => {
        ensureLocalhost();
        let entries;
        try { entries = fs.readdirSync(directory); } catch (readError) {
          if (readError && readError.code === 'ENOENT') return [];
          throw readError;
        }
        return entries.filter((entry) => entry.endsWith('.json')).sort()
          .map((entry) => publicValue(read(entry.slice(0, -5))));
      });
    },
    create(payload, callback) {
      let document;
      try { document = documentFrom(payload, null); } catch (failure) { callback(failure); return; }
      withLock(document.name, (failure, value) => {
        if (failure && failure.code === 'JOB_CONFLICT') {
          callback(error('DB_SERVER_CREATE_LOCKED', '같은 이름의 DB server 생성이 이미 진행 중입니다.', {
            name: document.name,
          }));
          return;
        }
        callback(failure, value);
      }, (handle) => {
        if (fs.existsSync(file(document.name))) {
          throw error('DB_SERVER_ALREADY_EXISTS', '같은 이름의 DB server가 이미 있습니다.', { name: document.name });
        }
        handle.assertOwned();
        atomicWriter(file(document.name), document);
        return publicValue(document);
      });
    },
    update(name, payload, callback) {
      withLock(name, callback, (handle) => {
        const current = read(name);
        if (!current) throw error('DB_SERVER_NOT_FOUND', '등록 DB server를 찾을 수 없습니다.', { name });
        const document = documentFrom(payload, current);
        handle.assertOwned();
        writeJsonAtomic(file(name), document);
        return publicValue(document);
      });
    },
    setDefaultTableColumns(name, table, valueColumn, stringValueColumn, callback) {
      withLock(name, callback, (handle) => {
        const current = read(name);
        if (!current) throw error('DB_SERVER_NOT_FOUND', '등록 DB server를 찾을 수 없습니다.', { name });
        const normalizedTable = String(table || '').trim().toUpperCase();
        const normalizedValue = String(valueColumn || '').trim().toUpperCase();
        const normalizedStringValue = String(stringValueColumn || '').trim().toUpperCase();
        if (!SQL_IDENTIFIER.test(normalizedTable) || !SQL_IDENTIFIER.test(normalizedValue)
          || (normalizedStringValue && !SQL_IDENTIFIER.test(normalizedStringValue))) {
          throw error('DB_SERVER_INVALID', '기본 Table column 형식이 잘못되었습니다.', { name });
        }
        if (String(current.defaultTable || '').toUpperCase() !== normalizedTable) return publicValue(current);
        const document = validateDocument(current.name, {
          ...current,
          valueColumn: normalizedValue,
          stringValueColumn: normalizedStringValue,
        });
        handle.assertOwned();
        writeJsonAtomic(file(current.name), document);
        return publicValue(document);
      });
    },
    remove(name, callback) {
      withLock(name, callback, (handle) => {
        const current = read(name);
        if (!current) throw error('DB_SERVER_NOT_FOUND', '등록 DB server를 찾을 수 없습니다.', { name });
        const jobs = referencedJobs(current.name);
        if (jobs.length) {
          throw error('DB_SERVER_IN_USE', 'Job이 사용하는 DB server는 지울 수 없습니다.', {
            name: current.name, jobs,
          });
        }
        handle.assertOwned();
        fs.unlinkSync(file(current.name));
        return { name: current.name };
      });
    },
  };
}

module.exports = { MAX_SERVER_JSON_BYTES, createServerStore };
