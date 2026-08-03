"use strict";

const path = require('path');
const process = require('process');
const root = process.argv[1].slice(0, process.argv[1].indexOf('/cgi-bin/') + '/cgi-bin'.length);
const { JobManager } = require(path.join(root, 'src', 'jobs', 'manager.js'));
const http = require(path.join(root, 'src', 'cgi', 'http.js'));

function requestMethod() {
  if (process.env && typeof process.env.get === 'function') {
    return String(process.env.get('REQUEST_METHOD') || '');
  }
  return String((process.env && process.env.REQUEST_METHOD) || '');
}

if (requestMethod() !== 'POST') {
  http.fail(new Error('POST 요청만 사용할 수 있습니다.'), 405);
} else {
  const body = http.readBody();
  if (!body.ok) {
    http.fail(body.error, 400);
  } else {
    const manager = new JobManager({ cgiRoot: root });
    manager.create(body.value, (error, job) => {
      if (error) {
        const status = error.kind === 'validation' ? 400 : http.statusForError(error);
        http.fail(error, status, error.kind === 'validation' ? undefined : error.kind);
      } else http.reply(201, { ok: true, data: job });
    });
  }
}
