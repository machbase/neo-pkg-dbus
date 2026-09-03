'use strict';

// GetDeviceData receives DataCount as DBus uint16. LS intentionally does not
// inherit the generic JSH collector's 1,000/10,000-row limits: its Go data
// plane owns a bounded queue and one native writer instead. A Job still has a
// uint16-sized reader batch, and its JSON may grow beyond generic's 512 KiB
// when it contains a Tag per PLC address.
const MAX_DATA_COUNT = 65535;
const MAX_LS_JOB_JSON_BYTES = 16 * 1024 * 1024;
const MAX_LS_JOB_REQUEST_BYTES = 17 * 1024 * 1024;

function invalid(reason, details) {
  const failure = new Error(reason);
  failure.code = 'JOB_INVALID';
  failure.details = details || {};
  throw failure;
}

function validateProductConfig(config) {
  const calls = config && config.methodCalls;
  if (!Array.isArray(calls) || calls.length < 1) invalid('LS jobs require at least one Method Call.');
  calls.forEach((call, callIndex) => {
    if (call.interfaceId !== 'ls-plc-device' || call.methodId !== 'get-device-data') {
      invalid('LS jobs require the fixed GetDeviceData Method.', { callIndex, interfaceId: call.interfaceId, methodId: call.methodId });
    }
    const selections = call.outputSelections;
    const selection = Array.isArray(selections) && selections.length === 1 ? selections[0] : null;
    if (!selection || selection.sourceIndex !== 0 || selection.interpretation !== 'json'
      || selection.selector !== '/data' || selection.valueType !== 'array' || selection.elementType !== 'numeric') {
      invalid('LS jobs require the fixed output mapping.', { callIndex });
    }
    if (!Array.isArray(selection.tags) || selection.tags.length !== call.inputs.DataCount) {
      invalid('LS job Tag count must match DataCount.', { callIndex, dataCount: call.inputs.DataCount });
    }
  });
  return config;
}

module.exports = {
  target: 'ls',
  minimumIntervalMs: 1,
  validationLimits: {
    maxGeneratedTagsPerCall: MAX_DATA_COUNT,
    maxBufferedRowsPerCycle: MAX_DATA_COUNT,
  },
  maxJobJsonBytes: MAX_LS_JOB_JSON_BYTES,
  maxRequestJsonBytes: MAX_LS_JOB_REQUEST_BYTES,
  validateProductConfig,
};
