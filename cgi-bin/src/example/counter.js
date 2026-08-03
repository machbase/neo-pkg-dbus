'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

class CounterStore {
  constructor(dataDir, options) {
    this.dataDir = dataDir;
    this.resultDir = (options && options.resultDir) || path.join(this.dataDir, 'jobs');
    this.now = (options && options.now) || (() => new Date().toISOString());
    fs.mkdirSync(this.resultDir, { recursive: true });
  }

  validateName(name) {
    const value = String(name || '');
    if (!NAME_PATTERN.test(value)) {
      throw new Error('카운터 이름은 소문자, 숫자, 하이픈만 사용하고 처음과 끝은 문자 또는 숫자여야 합니다.');
    }
    return value;
  }

  resultPath(name) {
    return path.join(this.resultDir, `${this.validateName(name)}.counter.json`);
  }

  read(name) {
    const resultPath = this.resultPath(name);
    if (!fs.existsSync(resultPath)) return null;
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (
      !Number.isInteger(result.count)
      || result.count < 0
      || typeof result.startedAt !== 'string'
      || !result.startedAt
      || typeof result.updatedAt !== 'string'
      || !result.updatedAt
    ) {
      throw new Error(`카운터 결과 형식이 올바르지 않습니다: ${this.validateName(name)}`);
    }
    return {
      count: result.count,
      startedAt: result.startedAt,
      updatedAt: result.updatedAt,
    };
  }

  increment(name) {
    const value = this.validateName(name);
    const current = this.read(value);
    const now = this.now();
    const result = {
      count: (current ? current.count : 0) + 1,
      startedAt: (current && current.startedAt) || now,
      updatedAt: now,
    };
    const resultPath = this.resultPath(value);
    const temporaryPath = path.join(
      this.resultDir,
      `.${value}.${process.pid || 'jsh'}.${Date.now()}.${Math.random()}.tmp`,
    );
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, resultPath);
      return result;
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
  }

  remove(name) {
    const value = this.validateName(name);
    const resultName = `${value}.counter.json`;
    const temporaryPrefix = `.${value}.`;
    let removed = false;
    for (const entry of fs.readdirSync(this.resultDir)) {
      const isTemporary = entry.startsWith(temporaryPrefix) && entry.endsWith('.tmp');
      if (entry !== resultName && !isTemporary) continue;
      try {
        fs.unlinkSync(path.join(this.resultDir, entry));
        removed = true;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }
}

module.exports = { CounterStore, NAME_PATTERN };
