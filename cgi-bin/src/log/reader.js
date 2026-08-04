'use strict';

const fs = require('fs');
const path = require('path');
const { error } = require('../config/errors.js');
const { sanitizeText } = require('./sanitize.js');

const JOB_NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const ROTATION = /^(.*)_(\d{8}_\d{6}(?:_\d{3})?)\.log$/;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_LINES = 1000;
const DEFAULT_MAX_ALL_BYTES = 2 * 1024 * 1024;

function invalid(reason, details) { return error('LOG_REQUEST_INVALID', reason, details); }

function jobName(value) {
  const name = String(value || '');
  if (!JOB_NAME.test(name) || /[\\/]/.test(name)) throw invalid('Job name 형식이 잘못되었습니다.');
  return name;
}

function fileNameForJob(name, value) {
  const file = String(value || `${name}.log`);
  if (path.basename(file) !== file || file.includes('..')) throw invalid('로그 파일 name 형식이 잘못되었습니다.');
  if (file === `${name}.log`) return file;
  const match = file.match(ROTATION);
  if (!match || match[1] !== name) throw invalid('선택한 Job의 로그 파일이 아닙니다.', { name, file });
  return file;
}

function integer(value, fallback, maximum, label) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw invalid(`${label} 범위가 잘못되었습니다.`);
  return parsed;
}

function createLogReader(options) {
  const settings = options || {};
  const logDir = settings.logDir || path.join(path.dirname(settings.cgiRoot), 'logs');
  const maxFileBytes = settings.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const maxLines = settings.maxLines || DEFAULT_MAX_LINES;
  const maxAllBytes = settings.maxAllBytes || DEFAULT_MAX_ALL_BYTES;

  function complete(callback, operation) {
    try { callback(null, operation()); } catch (failure) { callback(failure); }
  }

  function files() {
    try { return fs.readdirSync(logDir).filter((file) => file.endsWith('.log')).sort(); } catch (failure) {
      if (failure && failure.code === 'ENOENT') return [];
      throw error('LOG_UNAVAILABLE', '로그 목록을 읽을 수 없습니다.');
    }
  }

  function stat(file) {
    try { return fs.statSync(path.join(logDir, file)); } catch (failure) {
      if (failure && failure.code === 'ENOENT') throw error('LOG_NOT_FOUND', '로그 파일을 찾을 수 없습니다.', { file });
      throw error('LOG_UNAVAILABLE', '로그 파일 정보를 읽을 수 없습니다.', { file });
    }
  }

  function read(name, requestedFile, maximum) {
    const file = fileNameForJob(name, requestedFile);
    const info = stat(file);
    if (!info.isFile()) throw error('LOG_NOT_FOUND', '로그 파일을 찾을 수 없습니다.', { file });
    if (info.size > maxFileBytes || info.size > maximum) {
      throw error('LOG_TOO_LARGE', '로그 파일이 읽기 상한을 넘었습니다.', {
        file, size: info.size, maximum: Math.min(maxFileBytes, maximum),
      });
    }
    try { return { file, info, content: sanitizeText(fs.readFileSync(path.join(logDir, file), 'utf8')) }; } catch (_) {
      throw error('LOG_UNAVAILABLE', '로그 파일을 읽을 수 없습니다.', { file });
    }
  }

  function info(file, name) {
    const value = stat(file);
    return { name: file, size: value.size, active: file === `${name}.log` };
  }

  return {
    all(callback) {
      complete(callback, () => {
        const grouped = {};
        files().forEach((file) => {
          const rotation = file.match(ROTATION);
          const name = rotation ? rotation[1] : file.slice(0, -4);
          if (!JOB_NAME.test(name)) return;
          if (!grouped[name]) grouped[name] = [];
          grouped[name].push(info(file, name));
        });
        return {
          jobs: Object.keys(grouped).sort().map((name) => ({
            name,
            fileCount: grouped[name].length,
            totalSize: grouped[name].reduce((sum, file) => sum + file.size, 0),
            active: grouped[name].some((file) => file.active),
            files: grouped[name].sort((left, right) => {
              if (left.active !== right.active) return left.active ? -1 : 1;
              return left.name.localeCompare(right.name);
            }),
          })),
        };
      });
    },
    list(params, callback) {
      complete(callback, () => {
        const name = jobName(params && params.name);
        const result = files().filter((file) => {
          try { fileNameForJob(name, file); return true; } catch (_) { return false; }
        }).map((file) => info(file, name)).sort((left, right) => {
          if (left.active !== right.active) return left.active ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
        return { name, files: result };
      });
    },
    content(params, callback) {
      complete(callback, () => {
        const name = jobName(params && params.name);
        const page = integer(params && params.page, 1, 1000000, 'page');
        const linesPerPage = integer(params && params.lines, Math.min(200, maxLines), maxLines, 'lines');
        const value = read(name, params && params.file, maxFileBytes);
        const lines = value.content.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        const start = (page - 1) * linesPerPage;
        return {
          name,
          file: value.file,
          page,
          linesPerPage,
          totalLines: lines.length,
          lines: lines.slice(start, start + linesPerPage),
          nextPage: start + linesPerPage < lines.length ? page + 1 : null,
          previousPage: page > 1 ? page - 1 : null,
        };
      });
    },
    contentAll(params, callback) {
      complete(callback, () => {
        const name = jobName(params && params.name);
        const value = read(name, params && params.file, maxAllBytes);
        return { name, file: value.file, size: value.info.size, content: value.content };
      });
    },
    tail(params, callback) {
      complete(callback, () => {
        const name = jobName(params && params.name);
        const lineCount = integer(params && params.lines, Math.min(200, maxLines), maxLines, 'lines');
        const value = read(name, params && params.file, maxFileBytes);
        const lines = value.content.split('\n');
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        return { name, file: value.file, lines: lines.slice(Math.max(0, lines.length - lineCount)), totalLines: lines.length };
      });
    },
  };
}

module.exports = {
  DEFAULT_MAX_ALL_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_LINES,
  createLogReader,
  fileNameForJob,
  jobName,
};
