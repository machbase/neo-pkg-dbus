"use strict";

const path = require('path');
const process = require('process');
const root = process.argv[1].slice(0, process.argv[1].indexOf('/cgi-bin/') + '/cgi-bin'.length);
const { JobManager } = require(path.join(root, 'src', 'jobs', 'manager.js'));
const http = require(path.join(root, 'src', 'cgi', 'http.js'));

new JobManager({ cgiRoot: root }).list((error, jobs) => {
  if (error) http.fail(error, 500);
  else http.reply(200, { ok: true, data: jobs });
});
