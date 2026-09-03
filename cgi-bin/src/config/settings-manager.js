'use strict';

const path = require('path');
const { writeJsonAtomic } = require('./atomic-json.js');
const { loadSettings } = require('./settings-loader.js');
const { loadProviderProfile } = require('./provider-profile.js');
const { validateSettings } = require('./settings-validator.js');
const { createServerStore } = require('../db/server-store.js');
const { loadProductPolicy } = require('./product-policy.js');
const { resolveIntervalPolicy } = require('../ls/interval-policy.js');
const { error } = require('./errors.js');

function validateDatabaseDefault(cgiRoot, defaults) {
  const store = createServerStore({ cgiRoot });
  let servers = null;
  let listFailure = null;
  store.list((failure, values) => { listFailure = failure; servers = values; });
  if (listFailure) throw listFailure;
  if (!(servers || []).some((server) => server.name === defaults.database.server)) {
    throw error('SETTINGS_INVALID', '기본 Database Server를 찾을 수 없습니다.', { server: defaults.database.server });
  }
}

class SettingsManager {
  constructor(options) {
    const settings = options || {};
    this.cgiRoot = settings.cgiRoot;
    this.file = path.join(this.cgiRoot, 'conf.d', 'settings.json');
  }

  get(callback) {
    try {
      const settings = loadSettings(this.file);
      const productPolicy = loadProductPolicy(this.cgiRoot);
      const provider = loadProviderProfile(this.cgiRoot);
      const { ls, ...publicSettings } = settings;
      callback(null, {
        ...publicSettings,
        provider,
        ...(productPolicy.target === 'ls' && provider ? { intervalPolicy: resolveIntervalPolicy({ settings, productPolicy }) } : {}),
      });
    } catch (loadError) {
      callback(loadError);
    }
  }

  update(patch, callback) {
    try {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'provider')) {
        throw error('SETTINGS_INVALID', 'provider는 읽기 전용 build profile입니다.');
      }
      const current = loadSettings(this.file);
      const productPolicy = loadProductPolicy(this.cgiRoot);
      if (productPolicy.target === 'ls' && patch && patch.defaults
        && patch.defaults.database && patch.defaults.database.server
        && patch.defaults.database.server !== current.defaults.database.server) {
        throw error('LS_DATABASE_PROFILE_FIXED', 'LS에서는 기본 Database Server를 변경할 수 없습니다. 기존 Database 설정을 수정하십시오.');
      }
      const candidate = validateSettings({
        schemaVersion: 1,
        limits: patch && patch.limits ? patch.limits : current.limits,
        defaults: patch && patch.defaults ? patch.defaults : current.defaults,
        logging: patch && patch.logging ? patch.logging : current.logging,
        ls: patch && patch.ls ? patch.ls : current.ls,
      });
      if (patch && patch.defaults) validateDatabaseDefault(this.cgiRoot, candidate.defaults);
      const next = { ...current, ...candidate };
      if (productPolicy.target !== 'ls') delete next.ls;
      writeJsonAtomic(this.file, next);
      const { ls, ...publicSettings } = next;
      const provider = loadProviderProfile(this.cgiRoot);
      callback(null, {
        ...publicSettings,
        ...(productPolicy.target === 'ls' && provider ? { intervalPolicy: resolveIntervalPolicy({ settings: next, productPolicy }) } : {}),
      });
    } catch (updateError) {
      callback(updateError);
    }
  }
}

module.exports = { SettingsManager };
