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

function tagMayProduceFractionalValue(tag) {
  const source = tag || {};
  const bias = source.bias === undefined ? 0 : Number(source.bias);
  const multiplier = source.multiplier === undefined ? 1 : Number(source.multiplier);
  if (!Number.isFinite(bias) || !Number.isFinite(multiplier)) return true;

  // PLC numeric values are integers. The result is guaranteed to remain an integer only when
  // the input coefficient and the constant term of the configured affine transform are integers.
  if (!Number.isInteger(multiplier)) return true;
  const order = Array.isArray(source.transformOrder) ? source.transformOrder : ['bias', 'multiplier'];
  const constant = order[0] === 'multiplier' ? bias : bias * multiplier;
  return !Number.isInteger(constant);
}

function jobMayProduceFractionalValue(config) {
  return (config && Array.isArray(config.methodCalls) ? config.methodCalls : []).some((call) => {
    const selections = Array.isArray(call && call.outputSelections)
      ? call.outputSelections : [{ tags: Array.isArray(call && call.tags) ? call.tags : [] }];
    return selections.some((selection) => (Array.isArray(selection && selection.tags) ? selection.tags : [])
      .some(tagMayProduceFractionalValue));
  });
}

module.exports = {
  jobMayProduceFractionalValue,
  jobNeedsStringValueColumn,
  selectionStorageType,
  tagMayProduceFractionalValue,
};
