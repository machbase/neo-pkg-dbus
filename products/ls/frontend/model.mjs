import { applyLsTagCsv } from './tagCsv.mjs';

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function validTransformOrder(value) {
  return Array.isArray(value) && value.length === 2 && new Set(value).size === 2
    && value.includes('bias') && value.includes('multiplier');
}

function normalizedInputKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function generatedInput(inputs, names) {
  const accepted = new Set(names);
  const entry = Object.entries(inputs || {}).find(([key]) => accepted.has(normalizedInputKey(key)));
  return entry?.[1];
}

export const productTarget = 'ls';
export const minimumIntervalMs = 1;
export const retryConfigurable = false;
export const tagCsvImporter = Object.freeze({ apply: applyLsTagCsv });

function nextCallIdentity(calls, methodId) {
  const usedIds = new Set((calls || []).map((call) => call.id));
  const usedNames = new Set((calls || []).map((call) => call.name));
  let sequence = 1;
  while (usedIds.has(`${methodId}-${sequence}`) || usedNames.has(`${methodId}-${sequence}`)) sequence += 1;
  return `${methodId}-${sequence}`;
}

export function resolveJobFormMode({ settings, settingsLoading = false, settingsError = null, editing = false } = {}) {
  if (settingsLoading || settingsError || !settings || !Object.hasOwn(settings, 'provider')) return 'blocked';
  if (settings.provider?.jobMode === 'fixed') return 'fixed';
  return 'generic';
}

export function showsInterfaceManagement() {
  return false;
}

export function appendProductMethodCall(calls = [], provider) {
  if (provider?.jobMode !== 'fixed') return [...calls];
  const identity = nextCallIdentity(calls, provider.methodId);
  const inputs = { DeviceString: '%MB0', DataCount: 1 };
  const outputSelections = clone(provider.outputSelections || []).map((selection) => ({
    ...selection,
    tags: reconcileProductTags(inputs, selection.tags || [], provider),
  }));
  return [...calls, {
    id: identity,
    name: identity,
    interfaceId: provider.interfaceId,
    methodId: provider.methodId,
    inputs,
    outputSelections,
  }];
}

export function createInitialMethodCalls(provider) {
  return provider?.jobMode === 'fixed' ? appendProductMethodCall([], provider) : [];
}

export function inputLabel(value) {
  const key = normalizedInputKey(value);
  if (key === 'datacount') return 'DataCount';
  if (key === 'devicestring' || key === 'memoryaddress') return 'DeviceString';
  return value;
}

function isDeviceStringInput(value) {
  const key = normalizedInputKey(value);
  return key === 'devicestring' || key === 'memoryaddress';
}

export function inputPrefix(value) {
  return isDeviceStringInput(value) ? '%' : '';
}

const DEVICE_STRING_BUILDER = Object.freeze({
  memoryAreas: Object.freeze(['A', 'F', 'I', 'Q', 'M', 'K', 'R', 'W']),
  dataTypes: Object.freeze(['X', 'B', 'W', 'D', 'L']),
});

export function deviceStringBuilder(value) {
  if (!isDeviceStringInput(value)) return null;
  return DEVICE_STRING_BUILDER;
}

export function displayInputValue(name, storedValue) {
  if (!isDeviceStringInput(name) || typeof storedValue !== 'string') return storedValue;
  return storedValue.startsWith('%') ? storedValue.slice(1) : storedValue;
}

export function storeInputValue(name, displayValue) {
  if (!isDeviceStringInput(name)) return displayValue;
  return `%${String(displayValue ?? '')}`;
}

export function reconcileProductTags(inputs, existingTags = [], provider = null) {
  if (provider?.tagGenerator?.kind !== 'ls-memory-address-v1') return clone(existingTags || []);
  const count = Number(generatedInput(inputs, ['datacount', 'count']));
  const rawAddress = String(generatedInput(inputs, ['devicestring', 'memoryaddress', 'address']) ?? '').trim();
  const address = /^%(.+?)(\d+)$/.exec(rawAddress);
  if (!Number.isInteger(count) || count < 1 || !address) return clone(existingTags || []);
  const prefix = address[1].toUpperCase();
  const start = Number(address[2]);
  const width = address[2].length;
  if (!Number.isSafeInteger(start) || start + count - 1 > Number.MAX_SAFE_INTEGER) return clone(existingTags || []);
  return Array.from({ length: count }, (_, index) => {
    const existing = existingTags[index] || {};
    const manual = existing.nameMode === 'manual';
    return {
      ...existing,
      name: manual ? existing.name : `${prefix}${String(start + index).padStart(width, '0')}`,
      bias: Number.isFinite(Number(existing.bias)) ? Number(existing.bias) : 0,
      multiplier: Number.isFinite(Number(existing.multiplier)) ? Number(existing.multiplier) : 1,
      signed: existing.signed === true,
      transformOrder: validTransformOrder(existing.transformOrder)
        ? [...existing.transformOrder] : ['bias', 'multiplier'],
      nameMode: manual ? 'manual' : 'auto',
    };
  });
}
