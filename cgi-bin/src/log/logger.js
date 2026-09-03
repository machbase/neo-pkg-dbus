'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const { sanitizeFields, sanitizeText } = require('./sanitize.js');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const LEVELS = { trace: -1, debug: 0, info: 1, warn: 2, error: 3 };
const LABELS = { trace: 'TRACE', debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };

function defaultLogDir() {
  const script = String(process.argv[1] || '');
  const marker = `${path.sep}cgi-bin${path.sep}`;
  const index = script.lastIndexOf(marker);
  const appDir = index >= 0 ? script.slice(0, index) : path.dirname(path.dirname(script));
  return path.join(appDir || '.', 'logs');
}

function pad(value, length) { return String(value).padStart(length || 2, '0'); }

function timestamp(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} `
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function bytes(value) {
  if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(value, 'utf8');
  return unescape(encodeURIComponent(value)).length;
}

function quote(value) {
  const text = String(value);
  return /[ ="]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

class Logger {
  constructor(config, options) {
    const logging = config || {};
    const settings = options || {};
    this.disabled = logging.disable === true;
    this.level = Object.prototype.hasOwnProperty.call(LEVELS, logging.level) ? LEVELS[logging.level] : LEVELS.info;
    this.maxFiles = Number.isInteger(settings.maxFiles) && settings.maxFiles > 0
      ? Math.min(settings.maxFiles, 10)
      : (Number.isInteger(logging.maxFiles) && logging.maxFiles > 0 ? Math.min(logging.maxFiles, 10) : 3);
    this.name = settings.name || 'neo-pkg-dbus';
    this.logDir = settings.logDir || (settings.cgiRoot ? path.join(path.dirname(settings.cgiRoot), 'logs') : defaultLogDir());
    this.maxFileBytes = settings.maxFileBytes || MAX_FILE_SIZE;
    this.filePath = path.join(this.logDir, `${this.name}.log`);
    this.fileSize = 0;
    if (!this.disabled) {
      try { fs.mkdirSync(this.logDir, { recursive: true }); } catch (_) {}
      try { this.fileSize = fs.statSync(this.filePath).size; } catch (_) {}
    }
  }

  trace(stage, fields) { this.write('trace', stage, fields); }
  debug(stage, fields) { this.write('debug', stage, fields); }
  info(stage, fields) { this.write('info', stage, fields); }
  warn(stage, fields) { this.write('warn', stage, fields); }
  error(stage, fields) { this.write('error', stage, fields); }
  close() {}

  write(level, stage, fields) {
    if (this.disabled || LEVELS[level] < this.level) return;
    const safe = sanitizeFields(fields || {});
    const message = safe.msg === undefined ? '' : String(safe.msg);
    const rest = Object.keys(safe).filter((key) => key !== 'msg' && safe[key] !== undefined && safe[key] !== null)
      .map((key) => `${key}=${quote(safe[key])}`);
    const line = `[${LABELS[level]}] ${timestamp(new Date())}  ${sanitizeText(String(stage || 'app'))}  ${message}`
      + (rest.length ? `  (${rest.join(' ')})` : '') + '\n';
    this.append(line);
  }

  rotate() {
    const now = new Date();
    let attempt = 0;
    let rotated;
    do {
      const instant = new Date(now.getTime() + attempt);
      const suffix = `${instant.getFullYear()}${pad(instant.getMonth() + 1)}${pad(instant.getDate())}_${pad(instant.getHours())}${pad(instant.getMinutes())}${pad(instant.getSeconds())}_${pad(instant.getMilliseconds(), 3)}`;
      rotated = path.join(this.logDir, `${this.name}_${suffix}.log`);
      attempt += 1;
    } while (fs.existsSync(rotated));
    try { fs.renameSync(this.filePath, rotated); } catch (_) {}
    this.fileSize = 0;
    try {
      const prefix = `${this.name}_`;
      const files = fs.readdirSync(this.logDir).filter((file) => file.startsWith(prefix) && file.endsWith('.log')).sort();
      while (files.length > this.maxFiles) {
        try { fs.unlinkSync(path.join(this.logDir, files.shift())); } catch (_) {}
      }
    } catch (_) {}
  }

  append(line) {
    const size = bytes(line);
    if (this.fileSize > 0 && this.fileSize + size > this.maxFileBytes) this.rotate();
    try {
      fs.appendFileSync(this.filePath, line);
      this.fileSize += size;
    } catch (_) {
      this.fileSize = 0;
    }
  }
}

let instance = new Logger();

function init(config, options) { instance.close(); instance = new Logger(config, options); return instance; }
function getInstance() { return instance; }

module.exports = { Logger, MAX_FILE_SIZE, getInstance, init };
