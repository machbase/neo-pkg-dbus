function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export const productTarget = 'generic';
export const tagCsvImporter = null;

export function resolveJobFormMode({ settings, settingsLoading = false, settingsError = null } = {}) {
  if (settingsLoading || settingsError || !settings || !Object.hasOwn(settings, 'provider')) return 'blocked';
  return 'generic';
}

export function showsInterfaceManagement() {
  return true;
}

export function createInitialMethodCalls() {
  return [];
}

export function appendProductMethodCall(calls = []) {
  return [...calls];
}

export function inputLabel(value) {
  return value;
}

export function inputPrefix() {
  return '';
}

export function deviceStringBuilder() {
  return null;
}

export function displayInputValue(_name, storedValue) {
  return storedValue;
}

export function storeInputValue(_name, displayValue) {
  return displayValue;
}

export function reconcileProductTags(_inputs, existingTags = []) {
  return clone(existingTags || []);
}
