import assert from "node:assert/strict";

import { api, ApiError, apiBase } from "../src/api.js";
import { createPackageChannel, isPackageMessage } from "../src/package-channel.js";

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  return { ok: true, status: 200, json: async () => ({ ok: true, data: { accepted: true } }) };
};
const signal = new AbortController().signal;
await api.settings.get({ signal });
await api.settings.update({ defaultProfileId: "ls-electric-plc" }, { signal });
await api.jobs.list({ signal });
await api.jobs.get("job-a", { signal });
await api.jobs.create("job-a", { schemaVersion: 1 }, { signal });
await api.jobs.update("job-a", { revision: 7, schedule: { intervalMs: 2000 } }, { signal });
await api.jobs.remove("job-a", { signal });
await api.jobs.validate({ name: "job-a", config: {} }, { signal });
await api.jobs.install("job-a", { signal });
await api.jobs.start("job-a", { signal });
await api.jobs.stop("job-a", { signal });
await api.jobs.lastRun("job-a", { signal });
await api.profiles.list({ signal });
await api.profiles.get("p", { signal });
await api.profiles.create({ id: "p" }, { signal });
await api.profiles.update({ id: "p" }, { signal });
await api.profiles.remove("p", { signal });
await api.methods.list("p", { signal });
await api.methods.get("p", "m", { signal });
await api.methods.create("p", { id: "m" }, { signal });
await api.methods.update("p", { id: "m" }, { signal });
await api.methods.remove("p", "m", { signal });
await api.dbus.call({ profile: { id: "p" }, method: { id: "m" }, dbus: { busType: "system", destination: "x.y" }, inputs: { n: 1 }, tags: [{ name: "must-not-send" }] }, { signal });
await api.db.servers.list({ signal });
await api.db.servers.get("local", { signal });
await api.db.servers.create({ name: "local" }, { signal });
await api.db.servers.update("local", { host: "127.0.0.1" }, { signal });
await api.db.servers.remove("local", { signal });
await api.db.connect("local", { signal });
await api.db.tables.create({ server: "local", table: "TAG" }, { signal });
await api.db.tables.list({ server: "local" }, { signal });
await api.db.tables.columns({ server: "local", table: "TAG" }, { signal });
await api.db.tables.tags({ server: "local", table: "TAG" }, { signal });
await api.db.tables.data({ server: "local", table: "TAG", names: ["A", "B"] }, { signal });
await api.db.tables.chart({ server: "local", table: "TAG", names: ["A"] }, { signal });
await api.logs.all({ signal });
await api.logs.list("job-a", { signal });
await api.logs.content("job-a", "collector.log", { signal });
await api.logs.contentAll("job-a", "collector.log", { signal });
await api.logs.tail("job-a", "collector.log", { signal });

assert.equal(apiBase, "/public/neo-pkg-dbus/cgi-bin/api");
assert.equal(calls.every((call) => call.options.signal === signal), true, "caller signal must be forwarded unchanged");
assert.equal(calls.some((call) => call.url.includes("/jobs/")), false);
assert.deepEqual(JSON.parse(calls.find((call) => call.options.method === "POST" && call.url.endsWith("/job")).options.body), { name: "job-a", config: { schemaVersion: 1 } });
assert.deepEqual(JSON.parse(calls.find((call) => call.options.method === "PUT" && call.url.includes("/job?name=job-a")).options.body), { revision: 7, schedule: { intervalMs: 2000 } });
const testCall = calls.find((call) => call.url.endsWith("/dbus/call"));
assert.deepEqual(JSON.parse(testCall.options.body), { profile: { id: "p" }, method: { id: "m" }, dbus: { busType: "system", destination: "x.y" }, inputs: { n: 1 } });

await api.db.tables.data({ job: "job-a", names: ["A"], from: "2026-08-01T00:00:00Z", to: "2026-08-03T00:00:00Z", cursor: "next-token", direction: "oldest", rowsPerTag: 28 }, { signal });
const dataCall = calls.at(-1);
const dataUrl = new URL(dataCall.url, "http://localhost");
assert.equal(dataUrl.pathname.endsWith("/db/table/data"), true);
assert.deepEqual(Object.fromEntries(dataUrl.searchParams), { job: "job-a", names: "A", from: "2026-08-01T00:00:00Z", to: "2026-08-03T00:00:00Z", cursor: "next-token", direction: "oldest", rowsPerTag: "28" });
assert.equal(dataUrl.searchParams.has("start"), false);
assert.equal(dataUrl.searchParams.has("server"), false);

globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: "JOB_RUNNING", reason: "running job", details: { name: "job-a" } }) });
await assert.rejects(api.jobs.remove("job-a"), (error) => error instanceof ApiError && error.code === "JOB_RUNNING" && error.reason === "running job" && error.details.name === "job-a");

globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: "JOB_CONFLICT", reason: "revision changed", details: { name: "job-a", expectedRevision: 1, currentRevision: 2 } }) });
await assert.rejects(api.jobs.update("job-a", { revision: 1, schedule: { intervalMs: 2000 } }), (error) => error instanceof ApiError
  && error.status === 409
  && error.code === "JOB_CONFLICT"
  && error.details.currentRevision === 2);

assert.equal(isPackageMessage({ type: "select-job", name: "a" }), true);
assert.equal(isPackageMessage({ type: "new-job" }), true);
assert.equal(isPackageMessage({ type: "open-create-modal", target: "profile" }), true);
assert.equal(isPackageMessage({ type: "open-create-modal", target: "db-server" }), true);
assert.equal(isPackageMessage({ type: "open-create-modal", target: "job" }), false);
assert.equal(isPackageMessage({ type: "navigate", path: "/profiles" }), true);
assert.equal(isPackageMessage({ type: "refresh" }), true);
assert.equal(isPackageMessage({ type: "navigate", path: "" }), false);

const sent = [];
let closed = false;
globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; }
  postMessage(message) { sent.push(message); }
  close() { closed = true; }
};
const channel = createPackageChannel({ enabled: true, name: "app:neo-pkg-dbus", onMessage() {} });
channel.selectJob("a"); channel.newJob(); channel.openCreateModal("profile"); channel.navigate("/profiles"); channel.refresh(); channel.close();
assert.deepEqual(sent, [{ type: "select-job", name: "a" }, { type: "new-job" }, { type: "open-create-modal", target: "profile" }, { type: "navigate", path: "/profiles" }, { type: "refresh" }]);
assert.equal(closed, true);

console.log("api and channel contract tests passed");
