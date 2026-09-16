'use strict';

const path = require('path');
const process = require('process');
const source = String(process.argv[1] || '');
const root = source.slice(0, source.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const api = require(path.join(root, 'runtime.js')).jobApi;
const factory = api.manager();

function controllerError(state) {
  if (!state || !state.statusError) return null;
  return {
    name: 'collector',
    kind: 'controller',
    code: state.statusError.code || 'CONTROLLER_UNAVAILABLE',
    reason: state.statusError.message || 'Collector service status is unavailable.',
  };
}

function reply(jobs, daemonState) {
  const errors = [];
  jobs.forEach((job) => {
    if (job.error) errors.push({ name: job.name, kind: 'config', ...job.error });
    if (job.controllerError) errors.push({ name: job.name, kind: 'controller', ...job.controllerError });
  });
  const daemonFailure = controllerError(daemonState);
  if (daemonFailure) errors.push(daemonFailure);
  if (daemonState && daemonState.controllerState === 'FAILED') {
    errors.push({ name: 'collector', kind: 'controller', code: 'COLLECTOR_FAILED', reason: daemonState.controllerDetail || 'Collector service failed.' });
  }
  const jobsRunning = jobs.filter((job) => job.controllerState === 'RUNNING').length;
  const serviceRunning = daemonState
    ? ['RUNNING', 'STARTING'].includes(daemonState.controllerState)
    : jobsRunning > 0;
  const status = errors.length > 0 ? 'degraded' : serviceRunning ? 'running' : 'stopped';
  api.http.reply(200, {
    ok: true,
    data: {
      healthy: status === 'running',
      status,
      service_summary: {
        scope: 'neo-pkg-dbus',
        total: jobs.length,
        running: jobsRunning,
        ...(daemonState ? { collectorState: daemonState.controllerState } : {}),
        errors,
      },
    },
  });
}

if (!factory.ok) api.http.fail(factory.error);
else factory.value.health((healthError, value) => {
  if (healthError) { api.http.fail(healthError); return; }
  reply(value.jobs, value.daemonState);
});
