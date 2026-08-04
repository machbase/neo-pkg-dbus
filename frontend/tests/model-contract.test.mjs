import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  MAX_TAG_NAME_LENGTH,
  bulkEditTags,
  buildJobTree,
  chartEvidenceKey,
  createDefaultJobConfig,
  createMethodCall,
  createProfileDraft,
  displayGridRow,
  hydrateJobConfig,
  hasCompleteNumericEvidence,
  numericTagsFromRows,
  referencesBlockChanges,
  generateTrailingTags,
  jobActions,
  mergeGeneratedTags,
  parseSuccessValue,
  serializeMethodDraft,
  serializeJobConfig,
  validateTags,
  validateJobTags,
  validateJobPreview,
  successValueType,
} from "../src/model.js";

const require = createRequire(import.meta.url);
const { validateJobConfig } = require("../../cgi-bin/src/jobs/validator.js");
const { validateMethod, validateProfile } = require("../../cgi-bin/src/profiles/validator.js");
const builtInProfile = require("../../cgi-bin/profiles.d/ls-electric-plc.json");

const base = { statusKnown: true, valid: true };
assert.deepEqual(jobActions({ ...base, configState: "config-only", executionState: "stopped", controllerState: "NOT_INSTALLED" }), {
  install: true, start: false, stop: false, edit: true, remove: true, switchVisible: false, switchDisabled: true,
});
assert.deepEqual(jobActions({ ...base, configState: "installed", executionState: "stopped", controllerState: "STOPPED" }), {
  install: false, start: true, stop: false, edit: true, remove: true, switchVisible: true, switchDisabled: false,
});
assert.equal(jobActions({ ...base, configState: "installed", executionState: "running", controllerState: "RUNNING" }).stop, true);
for (const controllerState of ["STARTING", "STOPPING", "UNKNOWN"]) {
  const actions = jobActions({ ...base, configState: "installed", executionState: null, controllerState, statusKnown: controllerState !== "UNKNOWN" });
  assert.equal(actions.edit, false);
  assert.equal(actions.remove, false);
  assert.equal(actions.switchDisabled, true);
}
assert.equal(jobActions({ ...base, valid: false, controllerState: "STOPPED" }).remove, false);
for (const controllerState of ["RUNNING", "STARTING", "STOPPING", "UNKNOWN"]) {
  assert.equal(referencesBlockChanges([{ name: "line-a", controllerState }]), true);
}
assert.equal(referencesBlockChanges([{ name: "line-a", controllerState: "STOPPED" }]), false);
assert.equal(successValueType(1), "number");
assert.equal(successValueType(true), "boolean");
assert.equal(successValueType("1"), "string");
assert.equal(successValueType(null), "null");
assert.equal(parseSuccessValue("number", "1"), 1);
assert.equal(parseSuccessValue("boolean", "false"), false);
assert.equal(parseSuccessValue("string", "1"), "1");
assert.equal(parseSuccessValue("null", "ignored"), null);
assert.throws(() => parseSuccessValue("number", "not-a-number"), /finite number/i);

assert.deepEqual(generateTrailingTags("%MB3", 3).map((tag) => tag.name), ["%MB3", "%MB4", "%MB5"]);
assert.deepEqual(generateTrailingTags("%MB003", 3).map((tag) => tag.name), ["%MB003", "%MB004", "%MB005"]);
const protectedTags = [
  { ...generateTrailingTags("%MB3", 1)[0], name: "custom", nameEdited: true, bias: 8, multiplier: 2, calcOrder: "mb", transformEdited: true },
];
const merged = mergeGeneratedTags(protectedTags, generateTrailingTags("%MB3", 2), "missing");
assert.equal(merged[0].name, "custom");
assert.equal(merged[0].bias, 8);
assert.equal(merged[1].name, "%MB4");
assert.equal(mergeGeneratedTags(protectedTags, generateTrailingTags("%MB3", 2), "all")[0].name, "%MB3");

const bulk = bulkEditTags(generateTrailingTags("%MB3", 2), [0, 1], { prefix: "PLC_", suffix: "_V", bias: "1.5", multiplier: "2", calcOrder: "mb" });
assert.equal(bulk.changeCount, 2);
assert.deepEqual(bulk.preview.map((tag) => tag.name), ["PLC_%MB3_V", "PLC_%MB4_V"]);
assert.deepEqual(validateTags([{ name: "", bias: 0, multiplier: 1 }, { name: "A", bias: 0, multiplier: Infinity }, { name: "A", bias: 0, multiplier: 1 }]), [
  "Tag name is required.", "Tag transform must be finite.", "Tag names must be unique.",
]);

const config = {
  database: { valueColumn: "VALUE", stringValueColumn: "STR_VALUE" },
  methodCalls: [
    { id: "c1", name: "Call 1", tags: [{ name: "N", valueColumn: "VALUE" }, { name: "S", valueColumn: "STR_VALUE" }] },
  ],
};
assert.deepEqual(buildJobTree("job-a", config), [{ name: "job-a", calls: [{ id: "c1", name: "Call 1", tags: config.methodCalls[0].tags }] }]);
assert.deepEqual(numericTagsFromRows([{ name: "N", value: 1.5, stringValue: null }, { name: "S", value: null, stringValue: "text" }, { name: "X", value: Infinity, stringValue: null }]), ["N"]);
assert.deepEqual(numericTagsFromRows([{ name: "MIXED", value: 1.5, stringValue: null }, { name: "MIXED", value: null, stringValue: "text" }]), []);
assert.deepEqual(displayGridRow({ time: "raw-time", name: "A", value: 1, grid: { time: "Asia/Seoul time", value: "1.00" } }), { time: "Asia/Seoul time", name: "A", value: "1.00" });
assert.deepEqual(displayGridRow({ TIME: "fallback-time", NAME: "B", STR_VALUE: "text" }), { time: "fallback-time", name: "B", value: "text" });
const evidenceKey = chartEvidenceKey("A", "2026-08-01", "2026-08-03");
assert.equal(evidenceKey, JSON.stringify(["A", "2026-08-01", "2026-08-03"]));
assert.equal(hasCompleteNumericEvidence({ rows: [{ name: "A", value: 1.5, stringValue: null }], nextCursor: "next" }, { name: "A", cursor: "" }), false);
assert.equal(hasCompleteNumericEvidence({ rows: [{ name: "A", value: 1.5, stringValue: null }, { name: "A", value: null, stringValue: "text" }], nextCursor: null }, { name: "A", cursor: "" }), false);
assert.equal(hasCompleteNumericEvidence({ rows: [{ name: "A", value: 1.5, stringValue: null }], nextCursor: null }, { name: "A", cursor: "next" }), false);
assert.equal(hasCompleteNumericEvidence({ rows: [{ name: "A", value: 1.5, stringValue: null }, { name: "A", value: 2, stringValue: null }], nextCursor: null }, { name: "A", cursor: "" }), true);

const uiConfig = {
  ...createDefaultJobConfig(builtInProfile, "local-db"),
  methodCalls: [{
    ...createDefaultJobConfig(builtInProfile, "local-db").methodCalls[0],
    tags: [{ outputIndex: 0, sourceAddress: "%MB3", name: "custom", bias: 2, multiplier: 3, calcOrder: "mb", nameEdited: true, transformEdited: true, temporary: "drop" }],
  }],
};
const serialized = serializeJobConfig(uiConfig);
assert.deepEqual(Object.keys(serialized.methodCalls[0].tags[0]), ["outputIndex", "sourceAddress", "name", "bias", "multiplier", "calcOrder"]);
assert.equal(serialized.methodCalls[0].tags[0].nameEdited, undefined);
assert.equal(hydrateJobConfig(serialized).methodCalls[0].tags[0].nameEdited, true);
assert.equal(hydrateJobConfig(serialized).methodCalls[0].tags[0].transformEdited, true);

const validDefault = createDefaultJobConfig(builtInProfile, "local-db");
assert.doesNotThrow(() => validateJobConfig(serializeJobConfig(validDefault), {
  profileStore: { find: (id) => id === builtInProfile.id ? builtInProfile : null, isCompatible: () => true },
  limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 },
}));

assert.deepEqual(createProfileDraft(), {
  schemaVersion: 1, id: "", profileVersion: 1, displayName: "", vendor: "", builtIn: false,
  compatibility: { minNeoVersion: "8.5.6" }, defaults: { busType: "system", destination: "" }, methods: [],
});
const methodDraft = {
  id: "read-data", displayName: "Read Data", objectPath: "/plc", interface: "com.example.PLC", methodName: "GetData",
  inputs: [
    { id: "count", type: "uint16", required: true, validation: { minimum: 1, maximum: 4, pattern: "" }, uiOnly: true },
    { id: "address", type: "string", required: true, validation: { pattern: "^%", minimum: "", maximum: "" } },
  ],
  output: { decoder: "raw", shape: "array", path: "values", returnedCountPath: "count", success: { path: "result", operator: "equals", value: 1 }, expectedCount: { source: "input", inputId: "count" }, empty: "" },
  tagGeneration: { capability: "ls-get-device-data", countInputId: "count", addressInputId: "address" },
  uiOnly: "drop",
};
const serializedMethod = serializeMethodDraft(methodDraft);
assert.equal(serializedMethod.uiOnly, undefined);
assert.equal(serializedMethod.inputs[0].uiOnly, undefined);
assert.deepEqual(serializedMethod.inputs[0].validation, { minimum: 1, maximum: 4 });
assert.doesNotThrow(() => validateMethod(serializedMethod));
assert.deepEqual(createMethodCall(serializedMethod).inputs, { count: 1, address: "%MB3" });
assert.equal(createMethodCall(serializedMethod).methodId, "read-data");
assert.doesNotThrow(() => validateProfile({
  ...createProfileDraft(), id: "custom-plc", displayName: "Custom PLC", vendor: "Example", defaults: { busType: "system", destination: "com.example.PLC" }, methods: [serializedMethod],
}));
assert.deepEqual(validateJobTags([
  { inputs: { count: 2 }, method: { output: { expectedCount: { source: "input", inputId: "count" } } }, tags: [{ outputIndex: 0, name: "A", bias: 0, multiplier: 1 }, { outputIndex: 2, name: "B", bias: 0, multiplier: 1 }] },
  { inputs: {}, method: { output: {} }, tags: [{ outputIndex: 0, name: "A", bias: 0, multiplier: 1 }] },
], { maxNameLength: 1, maxGeneratedTagsPerCall: 10 }), ["Tag outputIndex must be continuous from 0.", "Tag names must be unique in the Job."]);
const tag100 = "T".repeat(100);
const tag101 = "T".repeat(101);
assert.deepEqual(validateJobTags([{ inputs: {}, method: { output: {} }, tags: [{ outputIndex: 0, name: tag100, bias: 0, multiplier: 1 }] }]), []);
assert.deepEqual(validateJobTags([{ inputs: {}, method: { output: {} }, tags: [{ outputIndex: 0, name: tag101, bias: 0, multiplier: 1 }] }]), ["Tag name exceeds 100 characters."]);
assert.equal(MAX_TAG_NAME_LENGTH, 100);
assert.deepEqual(bulkEditTags([{ outputIndex: 0, sourceAddress: "A", name: "A", bias: 0, multiplier: 1, calcOrder: "bm" }], [0], { prefix: tag100 }).errors, ["Tag name exceeds 100 characters."]);
const previewCalls = [
  { id: "c1", inputs: {}, methodId: "m", tags: [{ outputIndex: 0, name: "A", bias: 0, multiplier: 1 }] },
  { id: "c2", inputs: {}, methodId: "m", tags: [{ outputIndex: 0, name: "B", bias: 0, multiplier: 1 }] },
];
assert.deepEqual(validateJobPreview(previewCalls, 0, [{ outputIndex: 0, name: "B", bias: 0, multiplier: 1 }], [{ id: "m", output: {} }]), ["Tag names must be unique in the Job."]);

console.log("model contract tests passed");
