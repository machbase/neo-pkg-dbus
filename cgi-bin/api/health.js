'use strict';

const api = require('../src/cgi/job-api.js');
const factory = api.manager();

if (!factory.ok) api.http.fail(factory.error);
else factory.value.list((listError, jobs) => {
  if (listError) { api.http.fail(listError); return; }
  const errors = [];
  jobs.forEach((job) => {
    if (job.error) errors.push({ name: job.name, kind: 'config', ...job.error });
    if (job.controllerError) errors.push({ name: job.name, kind: 'controller', ...job.controllerError });
  });
  api.http.reply(200, {
    ok: true,
    data: {
      healthy: errors.length === 0,
      status: errors.length === 0 ? 'running' : 'degraded',
      service_summary: {
        scope: 'neo-pkg-dbus',
        total: jobs.length,
        running: jobs.filter((job) => job.controllerState === 'RUNNING').length,
        errors,
      },
    },
  });
});
