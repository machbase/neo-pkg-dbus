'use strict';

const { sha256 } = require('./sha256.js');

function profileLockKey(profileId) {
  return sha256(String(profileId));
}

module.exports = { profileLockKey };
