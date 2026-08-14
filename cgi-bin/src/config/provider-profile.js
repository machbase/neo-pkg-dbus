'use strict';

const fs = require('fs');
const path = require('path');
const { error } = require('./errors.js');

const TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'id',
  'jobMode',
  'interfaceId',
  'methodId',
  'outputSelections',
  'tagGenerator',
];
const OUTPUT_SELECTION_FIELDS = [
  'id',
  'sourceIndex',
  'interpretation',
  'selector',
  'valueType',
  'elementType',
  'tags',
];
const VALUE_TYPES = ['numeric', 'string', 'json', 'array'];
const ELEMENT_TYPES = ['numeric', 'string', 'json'];
const TAG_GENERATOR_KINDS = ['ls-memory-address-v1'];

function invalid(reason, details) {
  throw error('PROVIDER_PROFILE_INVALID', reason, details);
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedFields(value, fields, label) {
  if (!objectValue(value)) invalid(`${label}은 JSON 객체여야 합니다.`);
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length) invalid(`${label}에 알 수 없는 필드가 있습니다.`, { fields: unknown });
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateOutputSelection(selection, index) {
  assertAllowedFields(selection, OUTPUT_SELECTION_FIELDS, 'Provider output selection');
  if (!nonEmptyString(selection.id)
    || !Number.isInteger(selection.sourceIndex) || selection.sourceIndex < 0
    || !['native', 'json'].includes(selection.interpretation)
    || !Array.isArray(selection.tags) || selection.tags.length !== 0) {
    invalid('Provider output selection 형식이 잘못되었습니다.', { index });
  }

  if (selection.selector !== undefined && typeof selection.selector !== 'string') {
    invalid('Provider output selector는 문자열이어야 합니다.', { index });
  }
  if (selection.valueType !== undefined && !VALUE_TYPES.includes(selection.valueType)) {
    invalid('Provider output valueType을 지원하지 않습니다.', { index });
  }
  if ((selection.selector !== undefined || selection.valueType !== undefined)
    && (typeof selection.selector !== 'string' || !VALUE_TYPES.includes(selection.valueType))) {
    invalid('Provider output selector와 valueType은 함께 있어야 합니다.', { index });
  }
  if (selection.interpretation === 'json'
    && (typeof selection.selector !== 'string' || !VALUE_TYPES.includes(selection.valueType))) {
    invalid('JSON Provider output에는 selector와 valueType이 필요합니다.', { index });
  }
  if (selection.valueType === 'array') {
    if (!ELEMENT_TYPES.includes(selection.elementType)) {
      invalid('array Provider output에는 elementType이 필요합니다.', { index });
    }
  } else if (selection.elementType !== undefined) {
    invalid('array가 아닌 Provider output에는 elementType을 쓸 수 없습니다.', { index });
  }

  return {
    id: selection.id,
    sourceIndex: selection.sourceIndex,
    interpretation: selection.interpretation,
    ...(selection.selector !== undefined ? { selector: selection.selector } : {}),
    ...(selection.valueType !== undefined ? { valueType: selection.valueType } : {}),
    ...(selection.elementType !== undefined ? { elementType: selection.elementType } : {}),
    tags: [],
  };
}

function validateProviderProfile(value) {
  assertAllowedFields(value, TOP_LEVEL_FIELDS, 'Provider Profile');
  if (value.schemaVersion !== 1
    || !nonEmptyString(value.id)
    || value.jobMode !== 'fixed'
    || !nonEmptyString(value.interfaceId)
    || !nonEmptyString(value.methodId)
    || !Array.isArray(value.outputSelections) || value.outputSelections.length === 0) {
    invalid('Provider Profile 형식이 잘못되었습니다.');
  }

  assertAllowedFields(value.tagGenerator, ['kind'], 'Provider tagGenerator');
  if (!TAG_GENERATOR_KINDS.includes(value.tagGenerator.kind)) {
    invalid('지원하지 않는 Provider tagGenerator입니다.', { kind: value.tagGenerator.kind });
  }

  const outputSelections = value.outputSelections.map(validateOutputSelection);
  const ids = outputSelections.map((selection) => selection.id);
  if (new Set(ids).size !== ids.length) invalid('Provider output selection ID는 고유해야 합니다.');

  return {
    schemaVersion: 1,
    id: value.id,
    jobMode: 'fixed',
    interfaceId: value.interfaceId,
    methodId: value.methodId,
    outputSelections,
    tagGenerator: { kind: value.tagGenerator.kind },
  };
}

function loadProviderProfile(cgiRoot) {
  const file = path.join(cgiRoot, 'provider.json');
  if (!fs.existsSync(file)) return null;
  try {
    return validateProviderProfile(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (failure) {
    if (failure && failure.code === 'PROVIDER_PROFILE_INVALID') throw failure;
    invalid('Provider Profile 파일을 읽을 수 없습니다.', {
      message: failure && failure.message ? failure.message : String(failure),
    });
  }
}

module.exports = { loadProviderProfile, validateProviderProfile };
