'use strict';

class ConfigError extends Error {
  constructor(code, reason, details) {
    super(reason);
    this.name = 'ConfigError';
    this.code = code;
    this.details = details || {};
  }
}

function error(code, reason, details) {
  return new ConfigError(code, reason, details);
}

module.exports = { ConfigError, error };
