'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');
const { writeJsonAtomic } = require('../config/atomic-json.js');
const { error } = require('../config/errors.js');
const { validateProfile, validateProfileJsonSize } = require('./validator.js');
const { compareSemVer, parseSemVer } = require('./version.js');

function environmentValue(name) {
  if (process.env && typeof process.env.get === 'function') return process.env.get(name);
  return process.env && process.env[name];
}

function resolveRuntimeNeoVersion(cgiRoot, explicit) {
  let value = explicit || environmentValue('MACHBASE_NEO_VERSION') || environmentValue('NEO_VERSION');
  if (!value) {
    try {
      value = JSON.parse(fs.readFileSync(path.join(cgiRoot, 'package.json'), 'utf8')).minServerVersion;
    } catch (_) {
      value = '8.5.8';
    }
  }
  const normalized = String(value).replace(/^v(?=\d)/, '');
  parseSemVer(normalized, 'RUNTIME_VERSION_INVALID');
  return normalized;
}

class ProfileStore {
  constructor(options) {
    const settings = options || {};
    this.cgiRoot = settings.cgiRoot;
    this.builtInDir = path.join(this.cgiRoot, 'profiles.d');
    this.customDir = path.join(this.cgiRoot, 'conf.d', 'profiles');
    this.runtimeNeoVersion = resolveRuntimeNeoVersion(this.cgiRoot, settings.runtimeNeoVersion);
  }

  readDirectory(directory, builtIn) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => {
      let value;
      try {
        const source = fs.readFileSync(path.join(directory, name), 'utf8');
        validateProfileJsonSize(source);
        value = JSON.parse(source);
      } catch (readError) {
        throw error('PROFILE_INVALID', 'Profile 파일을 읽을 수 없습니다.', { file: name, message: readError.message });
      }
      const profile = validateProfile(value);
      if (`${profile.id}.json` !== name) throw error('PROFILE_INVALID', 'Profile ID와 파일명이 다릅니다.', { file: name });
      return { ...profile, builtIn };
    });
  }

  list() {
    const profiles = [...this.readDirectory(this.builtInDir, true), ...this.readDirectory(this.customDir, false)];
    const seen = new Set();
    profiles.forEach((profile) => {
      if (seen.has(profile.id)) throw error('PROFILE_INVALID', 'Profile ID가 중복되었습니다.', { id: profile.id });
      seen.add(profile.id);
    });
    return profiles;
  }

  find(id) {
    return this.list().find((profile) => profile.id === id) || null;
  }

  isCompatible(profile) {
    return compareSemVer(profile.compatibility.minNeoVersion, this.runtimeNeoVersion) <= 0;
  }

  save(profile) {
    const value = { ...validateProfile(profile), builtIn: false };
    writeJsonAtomic(path.join(this.customDir, `${value.id}.json`), value);
    return value;
  }

  remove(id) {
    fs.unlinkSync(path.join(this.customDir, `${id}.json`));
  }
}

module.exports = { ProfileStore, resolveRuntimeNeoVersion };
