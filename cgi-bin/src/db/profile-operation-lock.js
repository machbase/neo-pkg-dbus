'use strict';

const path = require('path');
const { error } = require('../config/errors.js');
const { createJobOperationLock } = require('../jobs/operation-lock.js');

const DATABASE_PROFILE_LOCK_NAME = 'ls-shared-database-profile';

function createDatabaseProfileOperationLock(options) {
  const settings = options || {};
  return createJobOperationLock({
    directory: settings.directory || path.join(
      settings.cgiRoot,
      'conf.d',
      '.database-profile-operation-locks',
    ),
  });
}

function databaseProfileConflict(operation, name) {
  return error(
    'JOB_CONFLICT',
    operation === 'start'
      ? 'Database 설정 저장 또는 다른 Job 시작이 진행 중입니다. 완료 후 다시 시도하십시오.'
      : 'Job 시작 또는 Database 설정 저장이 진행 중입니다. 모든 Job을 중지한 후 다시 저장하십시오.',
    { operation, ...(name ? { name } : {}) },
  );
}

module.exports = {
  DATABASE_PROFILE_LOCK_NAME,
  createDatabaseProfileOperationLock,
  databaseProfileConflict,
};
