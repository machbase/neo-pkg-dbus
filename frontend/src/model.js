const TRANSITION_STATES = new Set(["STARTING", "STOPPING"]);
const BLOCKING_REFERENCE_STATES = new Set(["RUNNING", "STARTING", "STOPPING", "UNKNOWN"]);
export const MAX_TAG_NAME_LENGTH = 100;

export function nextDefaultJobName(jobs = []) {
  const maximum = jobs.reduce((current, job) => {
    const match = /^job-([1-9][0-9]*)$/.exec(String(job?.name || ""));
    if (!match) return current;
    const value = BigInt(match[1]);
    return value > current ? value : current;
  }, 0n);
  return `job-${maximum + 1n}`;
}

function validTransformOrder(order) {
  return order === undefined || (Array.isArray(order) && order.length === 2
    && new Set(order).size === 2 && order.includes("bias") && order.includes("multiplier"));
}

export function referencesBlockChanges(references = []) {
  return references.some((reference) => BLOCKING_REFERENCE_STATES.has(reference?.controllerState));
}

export function successValueType(value) {
  if (value === null) return "null";
  if (["number", "boolean", "string"].includes(typeof value)) return typeof value;
  return "string";
}

export function parseSuccessValue(type, rawValue) {
  if (type === "null") return null;
  if (type === "string") return String(rawValue ?? "");
  if (type === "boolean") {
    if (rawValue === true || rawValue === "true") return true;
    if (rawValue === false || rawValue === "false") return false;
    throw new Error("Success Value must be a boolean.");
  }
  if (type === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error("Success Value must be a finite number.");
    return value;
  }
  throw new Error("Success Value type is not supported.");
}

export function jobActions(job = {}) {
  const known = job.statusKnown === true;
  const valid = job.valid !== false && job.errorCode !== "JOB_INVALID_CONFIG";
  const transition = TRANSITION_STATES.has(job.controllerState);
  const configOnly = known && job.configState === "config-only";
  const installed = known && job.configState === "installed";
  const running = installed && job.executionState === "running";
  const stopped = installed && job.executionState === "stopped";
  const safe = known && valid && !transition;
  return {
    start: safe && (configOnly || stopped),
    stop: safe && running,
    edit: safe && (configOnly || stopped),
    remove: safe && (configOnly || stopped),
    switchVisible: known,
    switchDisabled: !(safe && (configOnly || running || stopped)),
  };
}

export function validateTags(tags) {
  const errors = [];
  if ((tags || []).some((tag) => !String(tag.name || "").trim())) errors.push("Tag name is required.");
  if ((tags || []).some((tag) => String(tag.name || "").trim().length > MAX_TAG_NAME_LENGTH)) errors.push("Tag name exceeds 100 characters.");
  if ((tags || []).some((tag) => !Number.isFinite(Number(tag.bias)) || !Number.isFinite(Number(tag.multiplier)))) errors.push("Tag transform must be finite.");
  if ((tags || []).some((tag) => !validTransformOrder(tag.transformOrder))) errors.push("Tag transform order is invalid.");
  const names = (tags || []).map((tag) => String(tag.name || "").trim()).filter(Boolean);
  if (new Set(names).size !== names.length) errors.push("Tag names must be unique.");
  return errors;
}

function inputDefault(input) {
  if (input.type === "boolean") return false;
  if (["uint64", "int64"].includes(input.type)) return String(input.validation?.minimum ?? "0");
  if (["byte", "uint16", "uint32", "int16", "int32", "double"].includes(input.type)) {
    return Number(input.validation?.minimum ?? 1);
  }
  return "";
}

export function createMethodCall(method, id = `call-${method.id}`, interfaceId = "") {
  const inputs = Object.fromEntries((method.inputs || []).map((input) => [input.id || input.name, inputDefault({ ...input, id: input.id || input.name })]));
  return { id, name: method.displayName || method.member || method.id, interfaceId, methodId: method.id, inputs, outputSelections: [] };
}

function cloned(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function databaseDefaults(server) {
  if (typeof server === "string") return { server, table: "", valueColumn: "", stringValueColumn: "" };
  return {
    server: server?.name || "",
    table: server?.defaultTable || "",
    valueColumn: server?.defaultValueColumn ?? server?.valueColumn ?? "",
    stringValueColumn: server?.defaultStringValueColumn ?? server?.stringValueColumn ?? "",
  };
}

const NUMERIC_DBUS_OUTPUT_TYPES = new Set([
  "byte", "uint16", "uint32", "uint64", "int16", "int32", "int64", "double",
]);

function outputSelectionUsesStringColumn(selection, outputType) {
  const configuredType = selection?.valueType === "array" ? selection.elementType : selection?.valueType;
  if (configuredType) return configuredType !== "numeric";
  return !NUMERIC_DBUS_OUTPUT_TYPES.has(outputType);
}

export function jobNeedsStringValueColumn(methodCalls, interfaceDetails) {
  return (methodCalls || []).some((call) => {
    const method = (interfaceDetails?.[call.interfaceId]?.interface?.methods || [])
      .find((candidate) => candidate.id === call.methodId);
    const selections = Array.isArray(call.outputSelections)
      ? call.outputSelections
      : [{ sourceIndex: 0 }];
    return selections.some((selection) => outputSelectionUsesStringColumn(
      selection,
      method?.outputs?.[selection.sourceIndex]?.type,
    ));
  });
}

export function createDefaultJobConfig(provider, server = "local-db", initialMethodCalls = null) {
  const fixedCall = Array.isArray(initialMethodCalls) ? cloned(initialMethodCalls) : provider?.jobMode === "fixed" ? [{
    id: `${provider.methodId}-1`,
    name: provider.methodId,
    interfaceId: provider.interfaceId,
    methodId: provider.methodId,
    inputs: {},
    outputSelections: cloned(provider.outputSelections || []),
  }] : [];
  return {
    schemaVersion: 1,
    schedule: { intervalMs: 1000 },
    retry: { initialDelayMs: 5000, maximumDelayMs: 30000, multiplier: 2 },
    execution: { savePolicy: "perMethod", onMethodError: "stop" },
    methodCalls: fixedCall,
    database: databaseDefaults(server),
    log: { level: "info", maxFiles: 10 },
  };
}

const TAG_FIELDS = ["name", "bias", "multiplier", "transformOrder"];

export function serializeJobConfig(config) {
  const cloned = typeof structuredClone === "function" ? structuredClone(config) : JSON.parse(JSON.stringify(config));
  delete cloned.name;
  cloned.methodCalls = (cloned.methodCalls || []).map((call) => ({
    id: call.id,
    name: call.name,
    interfaceId: call.interfaceId,
    methodId: call.methodId,
    inputs: { ...(call.inputs || {}) },
    ...(Array.isArray(call.outputSelections)
      ? { outputSelections: call.outputSelections.map((selection) => ({ id: selection.id, sourceIndex: selection.sourceIndex, interpretation: selection.interpretation || "native", ...(selection.selector !== undefined ? { selector: selection.selector } : {}), ...(selection.valueType !== undefined ? { valueType: selection.valueType } : {}), ...(selection.elementType ? { elementType: selection.elementType } : {}), tags: (selection.tags || []).map((tag) => Object.fromEntries(TAG_FIELDS.map((field) => [field, tag[field]]))) })) }
      : { tags: (call.tags || []).map((tag) => Object.fromEntries(TAG_FIELDS.map((field) => [field, tag[field]]))) }),
  }));
  return cloned;
}

export function hydrateJobConfig(config) {
  const cloned = typeof structuredClone === "function" ? structuredClone(config) : JSON.parse(JSON.stringify(config));
  cloned.methodCalls = (cloned.methodCalls || []).map((call) => ({
    ...call,
    outputSelections: call.outputSelections && call.outputSelections.map((selection) => {
      const legacySelection = Object.hasOwn(selection, "path") || Object.hasOwn(selection, "mode");
      return {
        ...selection,
        ...(legacySelection ? {
          selector: selection.selector ?? selection.path ?? "",
          valueType: selection.valueType ?? (selection.mode === "each" ? "array" : "json"),
          ...(selection.elementType || selection.mode === "each" ? { elementType: selection.elementType || "json" } : {}),
        } : {}),
        tags: (selection.tags || []).map((tag) => ({ ...tag, nameEdited: tag.name !== tag.sourceAddress, transformEdited: tag.bias !== 0 || tag.multiplier !== 1 || tag.calcOrder !== "bm" })),
      };
    }),
    tags: (call.tags || []).map((tag) => ({
      ...tag,
      nameEdited: tag.name !== tag.sourceAddress,
      transformEdited: tag.bias !== 0 || tag.multiplier !== 1 || tag.calcOrder !== "bm",
    })),
  }));
  return cloned;
}

export function createProfileDraft() {
  return {
    schemaVersion: 1,
    id: "",
    profileVersion: 1,
    displayName: "",
    vendor: "",
    builtIn: false,
    compatibility: { minNeoVersion: "8.5.6" },
    defaults: { busType: "system", destination: "" },
    methods: [],
  };
}

export function serializeMethodDraft(draft) {
  const output = {
    decoder: draft.output.decoder,
    shape: draft.output.shape,
  };
  for (const key of ["path", "returnedCountPath"]) {
    if (draft.output[key]) output[key] = draft.output[key];
  }
  if (draft.output.success?.path) {
    output.success = {
      path: draft.output.success.path,
      operator: draft.output.success.operator || "equals",
      value: draft.output.success.value,
    };
  }
  if (draft.output.expectedCount?.inputId) {
    output.expectedCount = { source: "input", inputId: draft.output.expectedCount.inputId };
  }
  const method = {
    id: draft.id,
    displayName: draft.displayName,
    objectPath: draft.objectPath,
    interface: draft.interface,
    methodName: draft.methodName,
    inputs: (draft.inputs || []).map((input) => {
      const validation = Object.fromEntries(Object.entries(input.validation || {}).filter(([, value]) => value !== "" && value !== undefined));
      return {
        id: input.id,
        type: input.type,
        required: Boolean(input.required),
        ...(Object.keys(validation).length ? { validation } : {}),
      };
    }),
    output,
  };
  if (draft.tagGeneration?.capability) {
    method.tagGeneration = {
      capability: draft.tagGeneration.capability,
      countInputId: draft.tagGeneration.countInputId,
      addressInputId: draft.tagGeneration.addressInputId,
    };
  }
  return method;
}

export function validateJobTags(calls, options = {}) {
  const errors = [];
  const names = [];
  for (const call of calls || []) {
    const tags = Array.isArray(call.outputSelections)
      ? call.outputSelections.flatMap((selection) => selection.tags || [])
      : call.tags || [];
    const max = Number(options.maxGeneratedTagsPerCall);
    if (Number.isInteger(max) && tags.length > max && !errors.includes("Tag count exceeds the configured limit.")) errors.push("Tag count exceeds the configured limit.");
    for (const tag of tags) {
      const name = String(tag.name || "").trim();
      names.push(name);
      if (name.length > MAX_TAG_NAME_LENGTH && !errors.includes("Tag name exceeds 100 characters.")) errors.push("Tag name exceeds 100 characters.");
      if (!name && !errors.includes("Tag name is required.")) errors.push("Tag name is required.");
      if ((!Number.isFinite(Number(tag.bias)) || !Number.isFinite(Number(tag.multiplier))) && !errors.includes("Tag transform must be finite.")) errors.push("Tag transform must be finite.");
      if (!validTransformOrder(tag.transformOrder) && !errors.includes("Tag transform order is invalid.")) errors.push("Tag transform order is invalid.");
    }
  }
  const present = names.filter(Boolean);
  if (new Set(present).size !== present.length) errors.push("Tag names must be unique in the Job.");
  return errors;
}

export function validateJobPreview(calls, callIndex, previewTags, methods = [], options = {}) {
  const candidate = (calls || []).map((call, index) => ({
    ...call,
    tags: index === callIndex ? previewTags : call.tags,
    method: call.method || methods.find((method) => method.id === call.methodId),
  }));
  return validateJobTags(candidate, options);
}

export function numericTagsFromRows(rows) {
  const result = new Map();
  for (const row of rows || []) {
    if (typeof row?.name !== "string") continue;
    const numeric = Number.isFinite(row.value) && (row.stringValue === null || row.stringValue === undefined);
    result.set(row.name, (result.get(row.name) ?? true) && numeric);
  }
  return [...result].filter(([, numeric]) => numeric).map(([name]) => name);
}

export function displayGridRow(row = {}) {
  return {
    time: row.grid?.time ?? row.time ?? row.TIME ?? "—",
    name: row.name ?? row.NAME ?? "—",
    value: row.grid?.value ?? row.value ?? row.VALUE ?? row.stringValue ?? row.STR_VALUE ?? "—",
  };
}

export function chartEvidenceKey(name, from, to) {
  return JSON.stringify([name || "", from || "", to || ""]);
}

export function hasCompleteNumericEvidence(data = {}, request = {}) {
  const rows = data.rows || [];
  return !request.cursor && data.cursor?.next === null && rows.length > 0 && rows.every((row) => (
    (request.names || [request.name]).includes(row?.name) && Number.isFinite(row.value) && row.stringValue == null
  ));
}

export function bulkEditTags(tags, selectedIndexes, edit = {}) {
  const selected = new Set(selectedIndexes || []);
  const pasted = typeof edit.lines === "string" ? edit.lines.split(/\r?\n/) : null;
  let line = 0;
  const preview = (tags || []).map((tag, index) => {
    if (!selected.has(index)) return { ...tag };
    let name = tag.name;
    if (edit.reset) return { ...tag, name: tag.sourceAddress, bias: 0, multiplier: 1, calcOrder: "bm", nameEdited: false, transformEdited: false };
    if (pasted) name = pasted[line++] ?? name;
    if (edit.find !== undefined && String(edit.find)) name = name.split(String(edit.find)).join(String(edit.replace || ""));
    name = `${edit.prefix || ""}${name}${edit.suffix || ""}`;
    const hasTransform = edit.bias !== undefined || edit.multiplier !== undefined || edit.calcOrder !== undefined;
    return {
      ...tag,
      name,
      bias: edit.bias === undefined ? tag.bias : Number(edit.bias),
      multiplier: edit.multiplier === undefined ? tag.multiplier : Number(edit.multiplier),
      calcOrder: edit.calcOrder === undefined ? tag.calcOrder : edit.calcOrder,
      nameEdited: name !== tag.sourceAddress,
      transformEdited: hasTransform ? true : tag.transformEdited,
    };
  });
  const changeCount = preview.reduce((count, tag, index) => count + (JSON.stringify(tag) === JSON.stringify(tags[index]) ? 0 : 1), 0);
  return { preview, changeCount, errors: validateTags(preview) };
}

export function buildJobTree(jobName, config = {}) {
  return [{
    name: jobName,
    calls: (config.methodCalls || []).map((call) => ({
      id: call.id,
      name: call.name,
      interfaceId: call.interfaceId,
      methodId: call.methodId,
      tags: Array.isArray(call.outputSelections) ? call.outputSelections.flatMap((selection) => selection.tags || []) : call.tags || [],
    })),
  }];
}

export function chartEligibleTags(config = {}) {
  return [];
}

export function reorder(items, from, to) {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
