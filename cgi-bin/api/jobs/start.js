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
  const query = http.readQuery();
  if (!query.ok) {
    http.fail(query.error, 400);
  } else {
    const name = query.value.name;
    const manager = new JobManager({ cgiRoot: root });
    let valid = true;
    try {
      manager.validateName(name);
    } catch (error) {
      http.fail(error, 400);
      valid = false;
    }
    if (valid) {
      manager.start(name, (error, result) => {
        if (error) {
          http.fail(error, http.statusForError(error), error.kind);
        }
        else http.reply(200, { ok: true, data: result });
      });
    }
  }
}
