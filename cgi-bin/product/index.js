'use strict';

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

module.exports = { target: 'ls', validateProductConfig };
