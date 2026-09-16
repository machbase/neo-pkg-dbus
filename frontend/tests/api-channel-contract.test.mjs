import assert from "node:assert/strict";
import { api, apiBase } from "../src/api.js";
import { createPackageChannel, isPackageMessage } from "../src/package-channel.js";

async function importedApiBase(pathname, key) {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { pathname } });
    return (await import(`../src/api.js?api-base=${key}`)).apiBase;
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else delete globalThis.location;
  }
}

assert.equal(apiBase, "/public/neo-pkg-dbus/cgi-bin/api");
assert.equal(await importedApiBase("/public/ls-neo-pkg-dbus/index.html", "legacy-ls-name"), "/public/neo-pkg-dbus/cgi-bin/api");
assert.equal(await importedApiBase("/public/neo-pkg-dbus/main.html", "generic-main"), "/public/neo-pkg-dbus/cgi-bin/api");
assert.equal(await importedApiBase("/src/main.jsx", "development"), "/public/neo-pkg-dbus/cgi-bin/api");
assert.equal(await importedApiBase("/public/../index.html", "unsafe"), "/public/neo-pkg-dbus/cgi-bin/api");
assert.equal(await importedApiBase("/public/evil/main.html", "unknown-package"), "/public/neo-pkg-dbus/cgi-bin/api");

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
};

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
try {
  for (const [pathname, expected] of [
    ["/public/ls-neo-pkg-dbus/index.html", "/public/neo-pkg-dbus/cgi-bin/api/settings"],
    ["/public/neo-pkg-dbus/main.html", "/public/neo-pkg-dbus/cgi-bin/api/settings"],
    ["/public/evil/index.html", "/public/neo-pkg-dbus/cgi-bin/api/settings"],
  ]) {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { pathname } });
    await api.settings.get();
    assert.equal(calls.at(-1).url, expected);
  }
} finally {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else delete globalThis.location;
}
calls.length = 0;

await api.settings.get();
await api.settings.update({ limits: { maxGeneratedTagsPerCall: 100 }, defaults: { database: { server: "local" } }, provider: { id: "ls" } });
await api.interfaces.list();
await api.interfaces.get("plc");
await api.interfaces.discover({ busType: "system", destination: "com.example.Plc", objectPath: "/plc" });
assert.equal(api.interfaces.saveAll, undefined);
assert.equal(api.jobs.install, undefined);
await api.methods.create("plc", { id: "read" });
await api.jobs.status("line-a");
await api.dbus.call({ interfaceId: "plc", methodId: "read", inputs: { count: 1 } });
await api.db.preview.tables({ host: "127.0.0.1", port: 5656, user: "sys", password: "manager" });
await api.db.preview.columns({ host: "127.0.0.1", port: 5656, user: "sys", password: "manager", table: "TAG" });
await api.db.tables.tags({ job: "line-a", server: "local", table: "TAG" });
await api.db.tables.stat({ job: "line-a", server: "local", table: "TAG", names: ["A", "B"] });
await api.db.tables.data({ job: "line-a", server: "local", table: "TAG", names: ["A", "B"], cursor: "opaque" });
const urls = calls.map((call) => call.url);
assert.ok(urls.some((url) => url.endsWith("/settings")));
assert.deepEqual(JSON.parse(calls.find((call) => call.url.endsWith("/settings") && call.options.method === "PUT").options.body), {
  limits: { maxGeneratedTagsPerCall: 100 },
  defaults: { database: { server: "local" } },
});
assert.ok(urls.some((url) => url.endsWith("/dbus-interface/list")));
assert.ok(urls.some((url) => url.includes("/job/status?name=line-a")));
assert.ok(urls.some((url) => url.includes("/dbus-interface?id=plc")));
assert.deepEqual(JSON.parse(calls.find((call) => call.url.endsWith("/dbus-interface/discover")).options.body), { busType: "system", destination: "com.example.Plc", objectPath: "/plc" });
assert.deepEqual(JSON.parse(calls.find((call) => call.url.endsWith("/dbus/call")).options.body), { interfaceId: "plc", methodId: "read", inputs: { count: 1 } });
assert.deepEqual(JSON.parse(calls.find((call) => call.url.endsWith("/db/preview/tables")).options.body), { host: "127.0.0.1", port: 5656, user: "sys", password: "manager" });
assert.deepEqual(JSON.parse(calls.find((call) => call.url.endsWith("/db/preview/columns")).options.body), { host: "127.0.0.1", port: 5656, user: "sys", password: "manager", table: "TAG" });
const tags = new URL(calls.find((call) => call.url.includes("/db/table/tags")).url, "http://localhost");
assert.equal(tags.searchParams.get("job"), "line-a");
const stat = new URL(calls.find((call) => call.url.includes("/db/table/stat")).url, "http://localhost");
assert.deepEqual(stat.searchParams.getAll("names"), ["A", "B"]);
const data = new URL(calls.at(-1).url, "http://localhost");
assert.equal(data.searchParams.get("job"), "line-a");
assert.equal(data.searchParams.get("server"), "local");
assert.equal(data.searchParams.get("table"), "TAG");
assert.deepEqual(data.searchParams.getAll("names"), ["A", "B"]);

assert.equal(isPackageMessage({ type: "open-create-modal", target: "dbus-interface" }), true);
assert.equal(isPackageMessage({ type: "open-create-modal", target: "db-server:localhost" }), true);
assert.equal(isPackageMessage({ type: "open-create-modal", target: "db-server:../bad" }), false);
assert.equal(isPackageMessage({ type: "ready" }), true);
assert.equal(isPackageMessage({ type: "job-save-state", active: true, token: "save-1", startedAt: 1, expiresAt: 2 }), true);
assert.equal(isPackageMessage({ type: "job-save-state", active: false, token: "save-1" }), true);
assert.equal(isPackageMessage({ type: "job-save-state", active: true, token: "", startedAt: 1, expiresAt: 2 }), false);
assert.equal(isPackageMessage({ type: "job-save-state", active: true, token: "save-1" }), false);
assert.equal(isPackageMessage({ type: "open-create-modal", target: "profile" }), false);
const sent = [];
globalThis.BroadcastChannel = class { postMessage(value) { sent.push(value); } close() {} };
const channel = createPackageChannel({ enabled: true, name: "test", onMessage() {} });
channel.ready();
channel.openCreateModal("dbus-interface");
assert.deepEqual(sent, [{ type: "ready" }, { type: "open-create-modal", target: "dbus-interface" }]);
sent.length = 0;
channel.ready("side");
assert.deepEqual(sent, [{ type: "ready", surface: "side" }]);
sent.length = 0;
channel.jobSaveState({ active: true, token: "save-1", startedAt: 1, expiresAt: 2 });
channel.jobSaveState({ active: false, token: "save-1" });
assert.deepEqual(sent, [
  { type: "job-save-state", active: true, token: "save-1", startedAt: 1, expiresAt: 2 },
  { type: "job-save-state", active: false, token: "save-1" },
]);
console.log("api and channel contract tests passed");
