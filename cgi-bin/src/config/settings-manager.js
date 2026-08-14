'use strict';

const path = require('path');
const { writeJsonAtomic } = require('./atomic-json.js');
const { loadSettings } = require('./settings-loader.js');
const { loadProviderProfile } = require('./provider-profile.js');
const { validateSettings } = require('./settings-validator.js');
const { createServerStore } = require('../db/server-store.js');
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
      callback(null, {
        ...loadSettings(this.file),
        provider: loadProviderProfile(this.cgiRoot),
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
      const candidate = validateSettings({
        schemaVersion: 1,
        limits: patch && patch.limits ? patch.limits : current.limits,
        defaults: patch && patch.defaults ? patch.defaults : current.defaults,
      });
      if (patch && patch.defaults) validateDatabaseDefault(this.cgiRoot, candidate.defaults);
      const next = { ...current, ...candidate };
      writeJsonAtomic(this.file, next);
      callback(null, next);
    } catch (updateError) {
      callback(updateError);
    }
  }
}

module.exports = { SettingsManager };
