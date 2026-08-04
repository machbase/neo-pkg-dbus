'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../config/atomic-json.js');
const { error } = require('../config/errors.js');
const { validateJobName } = require('./validator.js');

function invalidConfig(name, documentName, reason) {
  return error('JOB_INVALID_CONFIG', reason || 'Job 파일명과 document name이 다릅니다.', {
    name,
    documentName,
  });
}

function revisionOf(document) {
  return Number.isSafeInteger(document && document.revision) && document.revision >= 1
    ? document.revision
    : 1;
}

class JobRepository {
  constructor(options) {
    this.directory = (options && options.jobDir)
      || path.join(options.cgiRoot, 'conf.d', 'jobs');
    fs.mkdirSync(this.directory, { recursive: true });
  }

  file(name) {
    return path.join(this.directory, `${validateJobName(name)}.json`);
  }

  parse(name) {
    let document;
    try {
      document = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (readError) {
      if (readError && readError.code === 'ENOENT') {
        throw error('JOB_NOT_FOUND', 'Job을 찾을 수 없습니다.', { name });
      }
      throw invalidConfig(name, null, `Job JSON을 읽을 수 없습니다: ${readError.message}`);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw invalidConfig(name, null, 'Job document는 객체여야 합니다.');
    }
    if (document.name !== name) throw invalidConfig(name, document.name);
    return document;
  }

  read(name) {
    validateJobName(name);
    return this.parse(name);
  }

  create(name, config) {
    validateJobName(name);
    const file = this.file(name);
    const document = { ...config, name, revision: 1 };
    let descriptor = null;
    try {
      descriptor = fs.openSync(file, 'wx');
      fs.writeSync(descriptor, `${JSON.stringify(document, null, 2)}\n`);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
    } catch (writeError) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch (_) {}
        try { fs.unlinkSync(file); } catch (_) {}
      }
      if (writeError && writeError.code === 'EEXIST') {
        throw error('JOB_ALREADY_EXISTS', '같은 이름의 Job이 이미 있습니다.', { name });
      }
      throw writeError;
    }
    return document;
  }

  save(name, document, expectedRevision) {
    validateJobName(name);
    const file = this.file(name);
    const current = this.read(name);
    if (!document || document.name !== name) throw invalidConfig(name, document && document.name);
    const currentRevision = revisionOf(current);
    if (expectedRevision !== currentRevision) {
      throw error('JOB_CONFLICT', '다른 관리자가 Job을 수정했습니다. 최신 설정을 다시 읽은 뒤 수정하세요.', {
        name,
        expectedRevision,
        currentRevision,
      });
    }
    writeJsonAtomic(file, document);
    return document;
  }

  remove(name) {
    this.read(name);
    fs.unlinkSync(this.file(name));
    return { name };
  }

  list() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter((entry) => entry.endsWith('.json')).sort().map((entry) => {
      const name = entry.slice(0, -5);
      try {
        validateJobName(name);
        const document = this.read(name);
        return { name, document, documentName: document.name, error: null };
      } catch (readError) {
        let documentName = null;
        try {
          documentName = JSON.parse(fs.readFileSync(path.join(this.directory, entry), 'utf8')).name;
        } catch (_) {}
        return { name, document: null, documentName, error: readError };
      }
    });
  }
}

module.exports = { JobRepository, revisionOf };
