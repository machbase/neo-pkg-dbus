'use strict';

const { sanitizeLastRun } = require('../collector/cycle.js');

function createServiceDetailsAdapter(explicit, serviceName) {
  let module = explicit;
  if (module === undefined) module = require('service');
  let details = module && module.details;
  if (module && typeof module.Client === 'function') {
    const client = new module.Client();
    details = client.details;
  }
  return {
    setLastRun(lastRun, callback) {
      if (!details || typeof details.set !== 'function') {
        callback(new Error('service details.set()을 사용할 수 없습니다.'));
        return;
      }
      try { details.set(serviceName, 'lastRun', sanitizeLastRun(lastRun), callback); }
      catch (writeError) { callback(writeError); }
    },
  };
}

module.exports = { createServiceDetailsAdapter };
