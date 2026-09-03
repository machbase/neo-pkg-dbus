import assert from "node:assert/strict";
import { buildJobTree, createDefaultJobConfig, createMethodCall, hasCompleteNumericEvidence, hydrateJobConfig, jobNeedsStringValueColumn, nextDefaultJobName, serializeJobConfig, validateTags } from "../src/model.js";

const dbusInterface = { id: "plc", busType: "system", destination: "com.example.Plc", methods: [{ id: "read", member: "Read", inputs: [{ name: "count", type: "uint16", required: true }], outputs: [] }] };
const config = createDefaultJobConfig(dbusInterface, "local-db");
assert.equal(config.profileId, undefined);
assert.equal(config.dbus, undefined);
assert.deepEqual(config.methodCalls, []);
assert.deepEqual(config.database, { server: "local-db", table: "", valueColumn: "", stringValueColumn: "" });
assert.deepEqual(serializeJobConfig(config).methodCalls, []);
assert.deepEqual(buildJobTree("line-a", config)[0].calls, []);
assert.equal(createMethodCall(dbusInterface.methods[0], "call-a", "plc").interfaceId, "plc");
const typedMethod = {
  id: "read-typed",
  member: "ReadTyped",
  inputs: [],
  outputs: [
    { name: "status", type: "string" },
    { name: "values", type: { type: "array", element: "uint16" } },
  ],
};
const typedCall = createMethodCall(typedMethod, "call-typed", "plc");
assert.equal(typedCall.tags, undefined);
assert.deepEqual(typedCall.outputSelections, []);
assert.deepEqual(serializeJobConfig({ ...config, methodCalls: [typedCall] }).methodCalls[0].outputSelections, []);
const serializedTag = serializeJobConfig({ ...config, methodCalls: [{ ...typedCall, outputSelections: [{
  id: "output-native", sourceIndex: 0, interpretation: "native", tags: [{
    name: "read-typed-1", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"],
  }],
}] }] }).methodCalls[0].outputSelections[0].tags[0];
assert.deepEqual(serializedTag, { name: "read-typed-1", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"], signed: false });
assert.doesNotMatch(JSON.stringify(serializedTag), /sourceAddress|calcOrder|outputIndex/);
assert.deepEqual(validateTags([{ ...serializedTag, transformOrder: ["bias", "bias"] }]), ["Tag transform order is invalid."]);
const hydratedNativeScalar = hydrateJobConfig({
  ...config,
  methodCalls: [{ ...typedCall, outputSelections: [{
    id: "output-native", sourceIndex: 0, interpretation: "native", tags: [{ name: "STATUS", bias: 0, multiplier: 1 }],
  }] }],
}).methodCalls[0].outputSelections[0];
assert.equal(Object.hasOwn(hydratedNativeScalar, "selector"), false);
assert.equal(Object.hasOwn(hydratedNativeScalar, "valueType"), false);
assert.equal(Object.hasOwn(hydratedNativeScalar, "elementType"), false);
assert.equal(hasCompleteNumericEvidence({ rows: [{ name: "A", value: 1 }], cursor: { next: null, previous: null } }, { names: ["A"] }), true);
const interfaceDetails = {
  plc: { interface: { id: "plc", methods: [typedMethod] } },
};
assert.equal(jobNeedsStringValueColumn([{
  ...typedCall,
  outputSelections: [{ sourceIndex: 0, interpretation: "json", valueType: "array", elementType: "numeric", tags: [] }],
}], interfaceDetails), false);
assert.equal(jobNeedsStringValueColumn([{
  ...typedCall,
  outputSelections: [{ sourceIndex: 0, interpretation: "native", tags: [] }],
}], interfaceDetails), true);
assert.equal(jobNeedsStringValueColumn([{
  ...typedCall,
  outputSelections: [{ sourceIndex: 0, interpretation: "json", valueType: "array", elementType: "json", tags: [] }],
}], interfaceDetails), true);
assert.equal(nextDefaultJobName([]), "job-1");
assert.equal(nextDefaultJobName([{ name: "job-1" }, { name: "job-2" }]), "job-3");
assert.equal(nextDefaultJobName([{ name: "job-1" }, { name: "job-3" }]), "job-4");
assert.equal(nextDefaultJobName([{ name: "job-1000000000000000" }]), "job-1000000000000001");
assert.equal(nextDefaultJobName([{ name: "job-9007199254740992" }]), "job-9007199254740993");
assert.equal(nextDefaultJobName([{ name: "job-99999999999999999999999999999999999999" }]), "job-100000000000000000000000000000000000000");
assert.equal(nextDefaultJobName([
  { name: "collector-a" }, { name: "job-a" }, { name: "job-0" }, { name: "job-01" },
]), "job-1");
console.log("model contract tests passed");
