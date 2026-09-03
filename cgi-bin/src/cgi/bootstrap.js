'use strict';

const path = require('path');
const process = require('process');
const { createDbApi } = require('./db-api.js');
const { createLogApi } = require('./log-api.js');

function cgiRoot(script) {
  const source = String(script || process.argv[1] || '');
  const marker = `${path.sep}cgi-bin${path.sep}`;
  const index = source.lastIndexOf(marker);
  if (index < 0) throw new Error('cgi-bin root를 찾을 수 없습니다.');
  return source.slice(0, index + marker.length - 1);
}

function runDb(kind) {
  const root = cgiRoot();
  createDbApi({ cgiRoot: root }).run(kind);
}

function runLog(kind) {
  const root = cgiRoot();
  createLogApi({ cgiRoot: root }).run(kind);
}

module.exports = { cgiRoot, runDb, runLog };
