"use strict";

const path = require('path');
const process = require('process');
const root = process.argv[1].slice(0, process.argv[1].indexOf('/cgi-bin/') + '/cgi-bin'.length);
const { JobManager } = require(path.join(root, 'src', 'jobs', 'manager.js'));
const { reply } = require(path.join(root, 'src', 'cgi', 'http.js'));

new JobManager({ cgiRoot: root }).summary((_error, serviceSummary) => {
  reply(200, {
    ok: true,
    data: {
      healthy: serviceSummary.errors.length === 0,
      status: serviceSummary.errors.length === 0 ? 'running' : 'degraded',
      service_summary: serviceSummary,
    },
  });
});
