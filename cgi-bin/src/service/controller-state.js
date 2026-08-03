'use strict';

const KNOWN_STATES = new Set([
  'RUNNING',
  'STARTING',
  'STOPPING',
  'STOPPED',
  'FAILED',
]);

function controllerDetail(info) {
  if (!info || typeof info !== 'object') return '';
  const value = info.error || (info.config && info.config.start_error) || '';
  return String(value);
}

function reportedState(info) {
  if (!info || typeof info !== 'object') return '';
  return String(info.status || info.state || '').toUpperCase();
}

function classifyControllerState(info, options) {
  const settings = options || {};
  const reported = reportedState(info);
  let state;
  if (settings.notInstalled) state = 'NOT_INSTALLED';
  else if (KNOWN_STATES.has(reported)) state = reported;
  else if (!reported && info && info.running === true) state = 'RUNNING';
  else state = 'UNKNOWN';

  return {
    state,
    known: state !== 'UNKNOWN',
    running: state === 'RUNNING' || state === 'STARTING',
    startComplete: state === 'RUNNING',
    activeForStop: state === 'RUNNING' || state === 'STARTING' || state === 'STOPPING',
    knownInactive: state === 'STOPPED' || state === 'FAILED' || state === 'NOT_INSTALLED',
    detail: controllerDetail(info),
  };
}

module.exports = {
  classifyControllerState,
};
