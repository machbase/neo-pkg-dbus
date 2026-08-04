'use strict';

const path = require('path');
const { writeJsonAtomic } = require('./atomic-json.js');
const { loadSettings } = require('./settings-loader.js');
const { validateSettings } = require('./settings-validator.js');
const { error } = require('./errors.js');
const { ProfileStore } = require('../profiles/store.js');

class SettingsManager {
  constructor(options) {
    const settings = options || {};
    this.cgiRoot = settings.cgiRoot;
    this.file = path.join(this.cgiRoot, 'conf.d', 'settings.json');
    this.profileStore = settings.profileStore || new ProfileStore({
      cgiRoot: this.cgiRoot,
      runtimeNeoVersion: settings.runtimeNeoVersion,
    });
  }

  get(callback) {
    try {
      callback(null, loadSettings(this.file));
    } catch (loadError) {
      callback(loadError);
    }
  }

  update(patch, callback) {
    try {
      const current = loadSettings(this.file);
      const candidate = validateSettings({
        schemaVersion: 1,
        defaultProfileId: patch && patch.defaultProfileId,
        limits: patch && patch.limits,
      });
      const available = this.profileStore.find(candidate.defaultProfileId);
      if (!available || !this.profileStore.isCompatible(available)) {
        throw error('PROFILE_NOT_AVAILABLE', '기본 Profile을 사용할 수 없습니다.', {
          profileId: candidate.defaultProfileId,
        });
      }
      const next = { ...current, ...candidate };
      writeJsonAtomic(this.file, next);
      callback(null, next);
    } catch (updateError) {
      callback(updateError);
    }
  }
}

module.exports = { SettingsManager };
