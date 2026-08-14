'use strict';

const NUMERIC_DBUS_TYPES = new Set([
  'byte', 'uint16', 'uint32', 'uint64', 'int16', 'int32', 'int64', 'double',
]);

function selectionStorageType(selection, outputType) {
  const configuredType = selection && selection.valueType === 'array'
    ? selection.elementType
    : selection && selection.valueType;
  if (configuredType) return configuredType === 'numeric' ? 'numeric' : 'string';
  return NUMERIC_DBUS_TYPES.has(outputType) ? 'numeric' : 'string';
}

function jobNeedsStringValueColumn(config, interfaceStore) {
  return config.methodCalls.some((call) => {
    const dbusInterface = interfaceStore.find(call.interfaceId);
    const method = dbusInterface.methods.find((candidate) => candidate.id === call.methodId);
    const selections = Array.isArray(call.outputSelections)
      ? call.outputSelections
      : [{ sourceIndex: 0 }];
    return selections.some((selection) => selectionStorageType(
      selection,
      method.outputs[selection.sourceIndex] && method.outputs[selection.sourceIndex].type,
    ) === 'string');
  });
}

module.exports = { jobNeedsStringValueColumn, selectionStorageType };
