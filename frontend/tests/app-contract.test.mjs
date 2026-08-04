import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const server = await createServer({ configFile: false, root, logLevel: "silent", server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const React = (await import("react")).default;
  const { create, act } = await import("react-test-renderer");
  const { AppProvider, ConnectedSide, JobSide, MainRoutes, MemoryRouter } = await server.ssrLoadModule("/src/App.jsx");
  const textOf = (node) => typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : node ? textOf(node.children || []) : "";
  const response = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
  const failureResponse = (code, reason, details = {}) => ({
    ok: false, status: 409, json: async () => ({ ok: false, code, reason, details }),
  });
  const jobs = [
    { name: "config", profileId: "ls", configState: "config-only", executionState: "stopped", controllerState: "NOT_INSTALLED", statusKnown: true },
    { name: "running", profileId: "ls", configState: "installed", executionState: "running", controllerState: "RUNNING", statusKnown: true },
    { name: "unknown", profileId: "ls", configState: null, executionState: null, controllerState: "UNKNOWN", statusKnown: false },
  ];
  let side;
  await act(async () => { side = create(React.createElement(JobSide, { jobs, selected: "running", onSelect() {}, onNew() {}, onRefresh() {}, onToggle() {} })); });
  assert.equal(side.root.findByType("aside").props["aria-label"], "DBus Collector jobs");
  assert.equal(side.root.findAllByProps({ "aria-label": "config Install required" }).length, 1);
  assert.equal(side.root.findByProps({ "aria-label": "running Stop" }).props.disabled, false);
  assert.equal(side.root.findByProps({ "aria-label": "unknown Start" }).props.disabled, true);
  assert.equal(side.root.findByProps({ "aria-label": "New Job" }).props.title, "New Job");

  let main;
  await act(async () => { main = create(React.createElement(MemoryRouter, { initialEntries: ["/profiles"] }, React.createElement(MainRoutes, { embedded: true }))); });
  assert.equal(main.root.findByType("main").props["aria-label"], "DBus Collector main");
  assert.match(JSON.stringify(main.toJSON()), /Profiles/);
  await act(async () => { main.unmount(); });

  const requests = [];
  const jobConfig = {
    schemaVersion: 1, profileId: "ls-electric-plc", dbus: { busType: "system", destination: "ls.plc" },
    schedule: { intervalMs: 1000 }, retry: { initialDelayMs: 5000, maximumDelayMs: 30000, multiplier: 2 },
    execution: { savePolicy: "perMethod", onMethodError: "stop" },
    methodCalls: [{ id: "call-a", name: "Call A", methodId: "get-device-data", inputs: { dataCount: 2, memoryAddress: "%MB3" }, tags: [{ outputIndex: 0, sourceAddress: "%MB3", name: "A", bias: 0, multiplier: 1, calcOrder: "bm" }, { outputIndex: 1, sourceAddress: "%MB4", name: "B", bias: 0, multiplier: 1, calcOrder: "bm" }] }],
    database: { server: "local-db", table: "TAG", valueColumn: "VALUE", stringValueColumn: "STR_VALUE" }, log: { level: "info", maxFiles: 10 },
  };
  let dataScenario = "paged";
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const value = String(url);
    if (value.includes("/job/last-run")) return response({ lastRun: { status: "success", startedAt: "2026-08-03T00:00:00.000Z", completedAt: "2026-08-03T00:00:01.000Z", methodCalls: [{ id: "call-a", name: "One Cycle Call", status: "success", storedCount: 1, error: null }], methods: [{ id: "legacy", name: "Legacy Wrong Field", status: "failed", storedCount: 0 }] } });
    if (value.includes("/job?")) return response({ name: "line-a", config: jobConfig });
    if (value.includes("/db/table/tags")) return response({ server: "local-db", table: "TAG", tags: [{ name: "A" }, { name: "OTHER-JOB-TAG" }] });
    if (value.includes("/db/table/data") && dataScenario === "paged") return response({ rows: [{ name: "A", time: "2026-08-03T00:00:00.000Z", value: 1.5, stringValue: null }], nextCursor: "next-token", previousCursor: null });
    if (value.includes("/db/table/data") && dataScenario === "mixed") return response({ rows: [{ name: "A", value: 1.5, stringValue: null }, { name: "A", value: null, stringValue: "text" }], nextCursor: null, previousCursor: null });
    if (value.includes("/db/table/data") && dataScenario === "complete") return response({ rows: [{ name: "A", value: 1.5, stringValue: null }, { name: "A", value: 2, stringValue: null }], nextCursor: null, previousCursor: null });
    if (value.includes("/db/table/chart")) return response({ series: [{ name: "A", data: [["2026-08-03", 1.5]] }] });
    throw new Error(`unexpected ${value}`);
  };
  const dataFetch = globalThis.fetch;
  let detail;
  await act(async () => { detail = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/line-a"] }, React.createElement(MainRoutes))); });
  assert.match(textOf(detail.toJSON()), /One Cycle Call/);
  assert.doesNotMatch(textOf(detail.toJSON()), /Legacy Wrong Field/);
  await act(async () => { detail.unmount(); });

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/job/last-run")) return failureResponse(
      "JOB_INVALID_CONFIG", "Last run is unavailable because its service state is unknown.",
      { controllerState: "UNKNOWN" },
    );
    if (value.includes("/job?")) return response({ name: "line-a", config: jobConfig, statusKnown: true, configState: "installed", executionState: "stopped", controllerState: "STOPPED" });
    throw new Error(`unexpected ${value}`);
  };
  let detailWithoutLastRun;
  await act(async () => { detailWithoutLastRun = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/line-a"] }, React.createElement(MainRoutes))); });
  assert.match(textOf(detailWithoutLastRun.toJSON()), /local-db\s*\/\s*TAG/);
  assert.match(textOf(detailWithoutLastRun.toJSON()), /Last run is unavailable/i);
  await act(async () => { detailWithoutLastRun.unmount(); });
  globalThis.fetch = dataFetch;

  const editProfile = {
    id: "ls-electric-plc", displayName: "LS Electric PLC", defaults: { busType: "system", destination: "ls.plc" },
    methods: [{
      id: "get-device-data", displayName: "Get Device Data",
      inputs: [{ id: "dataCount", type: "uint16", required: true }, { id: "memoryAddress", type: "string", required: true }],
      output: { decoder: "json", shape: "array", expectedCount: { source: "input", inputId: "dataCount" } },
    }],
  };
  for (const state of [
    { statusKnown: true, configState: "installed", executionState: "running", controllerState: "RUNNING", message: /Stop this Job/i },
    { statusKnown: false, configState: null, executionState: null, controllerState: "UNKNOWN", message: /status is unknown/i },
  ]) {
    const editRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url); editRequests.push({ value, options });
      if (value.endsWith("/settings")) return response({ schemaVersion: 1, defaultProfileId: "ls-electric-plc", limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } });
      if (value.endsWith("/profile/list")) return response([{ id: "ls-electric-plc", displayName: "LS Electric PLC" }]);
      if (value.endsWith("/db/server/list")) return response([{ name: "local-db" }]);
      if (value.includes("/job?")) return response({ name: "line-a", config: jobConfig, ...state });
      if (value.includes("/profile?id=ls-electric-plc")) return response({ profile: editProfile, compatible: true, references: [] });
      if (value.includes("/db/connect")) return response({ reason: "connected" });
      if (value.includes("/db/table/list")) return response([]);
      if (value.includes("/db/table/columns")) return response([]);
      throw new Error(`unexpected ${value}`);
    };
    let blockedEdit;
    await act(async () => { blockedEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/line-a/edit"] }, React.createElement(MainRoutes))); });
    assert.equal(blockedEdit.root.findAllByType("button").find((button) => textOf(button) === "Save").props.disabled, true);
    assert.equal(blockedEdit.root.findByProps({ "aria-label": "Job editing controls" }).props.disabled, true);
    assert.match(textOf(blockedEdit.toJSON()), state.message);
    await act(async () => { blockedEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
    assert.equal(editRequests.some((entry) => entry.value.includes("/job?") && entry.options.method === "PUT"), false);
    await act(async () => { blockedEdit.unmount(); });
  }

  const latestJob = {
    name: "line-a", revision: 2,
    config: { ...jobConfig, schedule: { ...jobConfig.schedule, intervalMs: 3000 } },
    statusKnown: true, configState: "installed", executionState: "stopped", controllerState: "STOPPED",
  };
  const conflictFixture = (job, options = {}) => async (url, requestOptions = {}) => {
    const value = String(url); options.onRequest?.({ value, options: requestOptions });
    if (value.endsWith("/settings")) return response({ schemaVersion: 1, defaultProfileId: "ls-electric-plc", limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } });
    if (value.endsWith("/profile/list")) return response([{ id: "ls-electric-plc", displayName: "LS Electric PLC" }]);
    if (value.endsWith("/db/server/list")) return response([{ name: "local-db" }]);
    if (value.includes("/profile?id=ls-electric-plc")) return response({ profile: editProfile, compatible: true, references: [] });
    if (value.includes("/db/connect")) return response({ reason: "connected" });
    if (value.includes("/db/table/list")) return response([]);
    if (value.includes("/db/table/columns")) return response([]);
    if (value.includes("/job/validate")) return options.validate
      ? options.validate(requestOptions)
      : response({ valid: true, warnings: [] });
    if (value.includes("/job/last-run")) return response({ lastRun: null });
    if (value.includes("/job?") && requestOptions.method === "PUT") return options.put
      ? options.put(requestOptions)
      : failureResponse("JOB_CONFLICT", "revision changed", { name: job.name, expectedRevision: 1, currentRevision: 2 });
    if (value.includes("/job?")) return options.detail ? options.detail(requestOptions, value) : response(job);
    throw new Error(`unexpected ${value}`);
  };

  const conflictRequests = [];
  let detailLoads = 0;
  let putCalls = 0;
  let resolveLatest;
  const initialConflictJob = { ...latestJob, revision: 1, config: jobConfig };
  globalThis.fetch = conflictFixture(initialConflictJob, {
    onRequest(entry) { conflictRequests.push(entry); },
    put() {
      putCalls += 1;
      return putCalls === 1
        ? failureResponse("JOB_CONFLICT", "revision changed", { name: "line-a", expectedRevision: 1, currentRevision: 2 })
        : response({ ...latestJob, revision: 3 });
    },
    detail() {
      detailLoads += 1;
      if (detailLoads === 1) return response(initialConflictJob);
      return new Promise((resolve) => { resolveLatest = () => resolve(response(latestJob)); });
    },
  });
  let conflictEdit;
  await act(async () => { conflictEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/line-a/edit"] }, React.createElement(MainRoutes))); });
  const runIntervalInput = () => conflictEdit.root.findAllByType("input").find((input) => String(input.props.min) === "1000");
  assert.equal(runIntervalInput().props.value, 1000);
  let firstSave;
  await act(() => { firstSave = conflictEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(typeof resolveLatest, "function");
  assert.doesNotMatch(textOf(conflictEdit.toJSON()), /latest setting was reloaded/i, "the screen must not say reloaded before the latest GET finishes");
  assert.equal(JSON.parse(conflictRequests.find((entry) => entry.value.includes("/job?") && entry.options.method === "PUT").options.body).revision, 1);
  resolveLatest();
  await act(async () => { await firstSave; });
  assert.match(textOf(conflictEdit.toJSON()), /latest setting was reloaded/i);
  assert.equal(runIntervalInput().props.value, 3000);
  await act(async () => { await conflictEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  const lastPut = conflictRequests.filter((entry) => entry.value.includes("/job?") && entry.options.method === "PUT").at(-1);
  assert.equal(JSON.parse(lastPut.options.body).revision, 2);
  await act(async () => { conflictEdit.unmount(); });

  let overlappingReload;
  let overlapDetailLoads = 0;
  globalThis.fetch = conflictFixture(initialConflictJob, {
    put() { return failureResponse("JOB_CONFLICT", "revision changed", { name: "line-a", expectedRevision: 1, currentRevision: 2 }); },
    detail(requestOptions) {
      overlapDetailLoads += 1;
      if (overlapDetailLoads === 1) return response(initialConflictJob);
      return new Promise((resolve) => { overlappingReload = { signal: requestOptions.signal, resolve }; });
    },
  });
  let overlappingConflictEdit;
  await act(async () => { overlappingConflictEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/line-a/edit"] }, React.createElement(MainRoutes))); });
  const overlappingInterval = () => overlappingConflictEdit.root.findAllByType("input").find((input) => String(input.props.min) === "1000");
  await act(async () => { overlappingInterval().props.onChange({ target: { value: "1500" } }); });
  let overlappingFirstSave;
  await act(() => { overlappingFirstSave = overlappingConflictEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { overlappingInterval().props.onChange({ target: { value: "2000" } }); });
  let overlappingSecondSave;
  await act(() => { overlappingSecondSave = overlappingConflictEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(overlappingReload.signal.aborted, true, "a newer Save aborts the older conflict reload");
  overlappingReload.resolve(response(latestJob));
  await act(async () => { await overlappingFirstSave; });
  assert.equal(overlappingInterval().props.value, 2000, "the old conflict reload cannot replace the newer draft");
  assert.doesNotMatch(textOf(overlappingConflictEdit.toJSON()), /latest setting was reloaded/i);
  await act(async () => { await overlappingSecondSave; });
  assert.equal(overlappingConflictEdit.root.findAllByType("button").find((button) => textOf(button) === "Save").props.disabled, false, "cancelled conflict reload releases the form loading lock");
  await act(async () => { overlappingConflictEdit.unmount(); });

  const initialA = { ...latestJob, name: "a", revision: 1, config: { ...jobConfig, schedule: { ...jobConfig.schedule, intervalMs: 1000 } } };
  const latestA = { ...initialA, revision: 2, config: { ...initialA.config, schedule: { ...initialA.config.schedule, intervalMs: 3000 } } };
  let unmountedReload;
  let aReads = 0;
  globalThis.fetch = conflictFixture(initialA, {
    detail(requestOptions) {
      aReads += 1;
      if (aReads === 1) return response(initialA);
      return new Promise((resolve) => { unmountedReload = { signal: requestOptions.signal, resolve }; });
    },
  });
  let unmountedEdit;
  await act(async () => { unmountedEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/a/edit"] }, React.createElement(MainRoutes))); });
  let unmountedSave;
  await act(() => { unmountedSave = unmountedEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(unmountedReload.signal.aborted, false);
  await act(async () => { unmountedEdit.unmount(); });
  assert.equal(unmountedReload.signal.aborted, true, "unmount aborts the active conflict reload");
  unmountedReload.resolve(response(latestA));
  await unmountedSave;

  const initialB = { ...initialA, name: "b", config: { ...initialA.config, schedule: { ...initialA.config.schedule, intervalMs: 4000 } } };
  let pendingA;
  let aRouteReads = 0;
  globalThis.fetch = conflictFixture(initialA, {
    detail(requestOptions, value) {
      const name = new URL(value, "http://localhost").searchParams.get("name");
      if (name === "b") return response(initialB);
      aRouteReads += 1;
      if (aRouteReads === 1) return response(initialA);
      return new Promise((resolve) => { pendingA = { signal: requestOptions.signal, resolve }; });
    },
  });
  let routeEdit;
  await act(async () => { routeEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b/edit", "/jobs/a/edit"], initialIndex: 1 }, React.createElement(MainRoutes))); });
  let routeSave;
  await act(() => { routeSave = routeEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { routeEdit.root.findAllByType("button").find((button) => textOf(button) === "Cancel").props.onClick(); });
  assert.equal(pendingA.signal.aborted, true, "route change aborts Job A's active conflict reload");
  pendingA.resolve(response(latestA));
  await routeSave;
  const routeIntervalInput = () => routeEdit.root.findAllByType("input").find((input) => String(input.props.min) === "1000");
  assert.match(textOf(routeEdit.toJSON()), /Edit b/);
  assert.equal(routeIntervalInput().props.value, 4000, "late Job A data cannot overwrite Job B's form");
  await act(async () => { routeEdit.unmount(); });

  let deferredPut;
  let pendingBLoad;
  let routeAReads = 0;
  let aConflictReloads = 0;
  const routePutBodies = [];
  globalThis.fetch = conflictFixture(initialA, {
    put(requestOptions) {
      routePutBodies.push(JSON.parse(requestOptions.body));
      if (routePutBodies.length === 1) return new Promise((resolve) => { deferredPut = resolve; });
      return response({ ...initialB, revision: 2 });
    },
    detail(requestOptions, value) {
      const name = new URL(value, "http://localhost").searchParams.get("name");
      if (name === "b") return new Promise((resolve) => { pendingBLoad = { signal: requestOptions.signal, resolve }; });
      routeAReads += 1;
      if (routeAReads === 1) return response(initialA);
      aConflictReloads += 1;
      return response(latestA);
    },
  });
  let lateConflictRoute;
  await act(async () => { lateConflictRoute = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b/edit", "/jobs/a/edit"], initialIndex: 1 }, React.createElement(MainRoutes))); });
  let lateConflictSave;
  await act(() => { lateConflictSave = lateConflictRoute.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { lateConflictRoute.root.findAllByType("button").find((button) => textOf(button) === "Cancel").props.onClick(); });
  assert.equal(pendingBLoad.signal.aborted, false);
  deferredPut(failureResponse("JOB_CONFLICT", "revision changed", { name: "a", expectedRevision: 1, currentRevision: 2 }));
  await act(async () => { await lateConflictSave; });
  assert.equal(pendingBLoad.signal.aborted, false, "late Job A conflict cannot abort Job B's initial load");
  assert.equal(aConflictReloads, 0, "late Job A conflict cannot start a stale reload");
  pendingBLoad.resolve(response(initialB));
  await act(async () => { await Promise.resolve(); });
  const lateConflictInterval = () => lateConflictRoute.root.findAllByType("input").find((input) => String(input.props.min) === "1000");
  assert.equal(lateConflictInterval().props.value, 4000);
  await act(async () => { await lateConflictRoute.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  assert.equal(routePutBodies.at(-1).revision, 1, "Job B's loaded revision is preserved for its save");
  await act(async () => { lateConflictRoute.unmount(); });

  // Without route ownership checks, an old mutation can refresh, navigate, or
  // write an error into the Job currently displayed by the reused route tree.
  const runLifecycleRouteRace = async (settle, verify) => {
    let pendingStartA;
    const bDetailSignals = [];
    let staleADetailReloads = 0;
    globalThis.fetch = async (url, options = {}) => {
      const value = String(url);
      if (value.endsWith("/job/list")) return response([initialB, initialA]);
      if (value.includes("/job/start")) return new Promise((resolve) => { pendingStartA = { signal: options.signal, resolve }; });
      if (value.includes("/job/last-run")) return response({ lastRun: null });
      if (value.includes("/job?")) {
        const requestedName = new URL(value, "http://localhost").searchParams.get("name");
        if (requestedName === "b") { bDetailSignals.push(options.signal); return response(initialB); }
        staleADetailReloads += 1;
        return response(initialA);
      }
      throw new Error(`unexpected ${value}`);
    };
    let view;
    await act(async () => { view = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b", "/jobs/a"], initialIndex: 1 }, React.createElement(AppProvider, { surface: "main" }, React.createElement(ConnectedSide), React.createElement(MainRoutes)))); });
    let operation;
    await act(() => { operation = view.root.findByProps({ "aria-label": "a Start" }).props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    assert.ok(pendingStartA.signal, "lifecycle mutation receives an AbortSignal");
    await act(async () => { view.root.findAllByType("button").find((button) => button.props.title === "b · STOPPED").props.onClick(); });
    assert.equal(bDetailSignals.every((signal) => signal?.aborted === false), true, "Job B GET remains active after navigating away from Job A");
    pendingStartA.resolve(settle);
    await act(async () => { await operation; });
    verify(view, staleADetailReloads);
    await act(async () => { view.unmount(); });
  };
  await runLifecycleRouteRace(response({ name: "a" }), (view, staleADetailReloads) => {
    assert.match(textOf(view.toJSON()), /b/);
    assert.equal(view.root.findByProps({ "aria-label": "b Start" }).props.disabled, false, "Job B controls remain available");
    assert.equal(staleADetailReloads, 1, "late Job A success cannot reload Job A after the route changed");
  });
  await runLifecycleRouteRace(failureResponse("JOB_START_FAILED", "Job A start failed."), (view) => {
    assert.match(textOf(view.toJSON()), /b/);
    assert.doesNotMatch(textOf(view.toJSON()), /Job A start failed/);
  });

  const installableA = { ...initialA, configState: "config-only", executionState: "stopped", controllerState: "NOT_INSTALLED" };
  const sentRefreshes = [];
  globalThis.BroadcastChannel = class {
    postMessage(message) { sentRefreshes.push(message); }
    close() {}
  };
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/job/list")) return response([installableA]);
    if (value.includes("/job/install")) return response({ name: "a" });
    if (value.includes("/job/last-run")) return response({ lastRun: null });
    if (value.includes("/job?")) return response(installableA);
    throw new Error(`unexpected ${value}`);
  };
  let detailBroadcast;
  await act(async () => { detailBroadcast = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/a"] }, React.createElement(AppProvider, { surface: "main" }, React.createElement(MainRoutes)))); });
  await act(async () => { await detailBroadcast.root.findAllByType("button").find((button) => textOf(button) === "Install").props.onClick(); });
  assert.deepEqual(sentRefreshes, [{ type: "refresh" }], "JobDetail lifecycle success keeps the Side/Main refresh broadcast");
  await act(async () => { detailBroadcast.unmount(); });

  globalThis.BroadcastChannel = undefined;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/job/list")) return response([installableA, initialB]);
    if (value.includes("/job/install")) return failureResponse("JOB_INSTALL_FAILED", "Job A install failed.");
    if (value.includes("/job/last-run")) return response({ lastRun: null });
    if (value.includes("/job?")) {
      const requestedName = new URL(value, "http://localhost").searchParams.get("name");
      return response(requestedName === "b" ? initialB : installableA);
    }
    throw new Error(`unexpected ${value}`);
  };
  let detailErrorRoute;
  await act(async () => { detailErrorRoute = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b", "/jobs/a"], initialIndex: 1 }, React.createElement(AppProvider, { surface: "main" }, React.createElement(ConnectedSide), React.createElement(MainRoutes)))); });
  await act(async () => { await detailErrorRoute.root.findAllByType("button").find((button) => textOf(button) === "Install").props.onClick(); });
  assert.match(textOf(detailErrorRoute.toJSON()), /Job A install failed/);
  await act(async () => { detailErrorRoute.root.findAllByType("button").find((button) => button.props.title === "b · STOPPED").props.onClick(); });
  assert.doesNotMatch(textOf(detailErrorRoute.toJSON()), /Job A install failed/, "Job A detail error is cleared when Job B becomes current");
  await act(async () => { detailErrorRoute.unmount(); });

  let listReads = 0;
  let pendingRefresh;
  globalThis.BroadcastChannel = undefined;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/job/list")) {
      listReads += 1;
      if (listReads === 1) return response([initialA, initialB]);
      return new Promise((resolve) => { pendingRefresh = { signal: options.signal, resolve }; });
    }
    if (value.includes("/job/start")) return response({ name: "a" });
    if (value.includes("/job/last-run")) return response({ lastRun: null });
    if (value.includes("/job?")) {
      const requestedName = new URL(value, "http://localhost").searchParams.get("name");
      return response(requestedName === "b" ? initialB : initialA);
    }
    throw new Error(`unexpected ${value}`);
  };
  let refreshAbortRoute;
  await act(async () => { refreshAbortRoute = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b", "/jobs/a"], initialIndex: 1 }, React.createElement(AppProvider, { surface: "main" }, React.createElement(ConnectedSide), React.createElement(MainRoutes)))); });
  let startWithRefresh;
  await act(() => { startWithRefresh = refreshAbortRoute.root.findByProps({ "aria-label": "a Start" }).props.onClick(); });
  await act(async () => { await Promise.resolve(); });
  assert.ok(pendingRefresh.signal, "mutation refresh uses the same AbortSignal");
  await act(async () => { refreshAbortRoute.root.findAllByType("button").find((button) => button.props.title === "b · STOPPED").props.onClick(); });
  assert.equal(pendingRefresh.signal.aborted, true, "route change aborts the old refresh");
  pendingRefresh.resolve(response([initialA, initialB]));
  await act(async () => { await startWithRefresh; });
  assert.doesNotMatch(textOf(refreshAbortRoute.toJSON()), /Loading jobs…/, "an aborted old refresh releases its own loading state");
  assert.equal(refreshAbortRoute.root.findByProps({ "aria-label": "b Start" }).props.disabled, false);
  await act(async () => { refreshAbortRoute.unmount(); });

  const formRouteFixture = (handlers = {}) => async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/settings")) return response({ schemaVersion: 1, defaultProfileId: "ls-electric-plc", limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } });
    if (value.endsWith("/profile/list")) return response([{ id: "ls-electric-plc", displayName: "LS Electric PLC" }]);
    if (value.endsWith("/db/server/list")) return response([{ name: "local-db" }]);
    if (value.includes("/profile?id=ls-electric-plc")) return response({ profile: editProfile, compatible: true, references: [] });
    if (value.includes("/db/connect")) return response({ reason: "connected" });
    if (value.includes("/db/table/list")) return response([]);
    if (value.includes("/db/table/columns")) return response([]);
    if (value.includes("/dbus/call")) return handlers.testCall(options);
    if (value.includes("/job/validate")) return handlers.validate ? handlers.validate(options) : response({ valid: true, warnings: [] });
    if (value.includes("/job?") && options.method === "PUT") return handlers.put(options);
    if (value.includes("/job?")) {
      const requestedName = new URL(value, "http://localhost").searchParams.get("name");
      return handlers.detail ? handlers.detail(options, requestedName) : response(requestedName === "b" ? initialB : initialA);
    }
    throw new Error(`unexpected ${value}`);
  };

  let pendingPutA;
  globalThis.fetch = formRouteFixture({
    put(options) { return new Promise((resolve) => { pendingPutA = { signal: options.signal, resolve }; }); },
  });
  let formSuccessRoute;
  await act(async () => { formSuccessRoute = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b/edit", "/jobs/a/edit"], initialIndex: 1 }, React.createElement(MainRoutes))); });
  let saveAOperation;
  await act(() => { saveAOperation = formSuccessRoute.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  assert.ok(pendingPutA.signal, "Job save receives an AbortSignal");
  await act(async () => { formSuccessRoute.root.findAllByType("button").find((button) => textOf(button) === "Cancel").props.onClick(); });
  const formRouteInterval = () => formSuccessRoute.root.findAllByType("input").find((input) => String(input.props.min) === "1000");
  await act(async () => { formRouteInterval().props.onChange({ target: { value: "4500" } }); });
  pendingPutA.resolve(response({ ...initialA, revision: 2 }));
  await act(async () => { await saveAOperation; });
  assert.match(textOf(formSuccessRoute.toJSON()), /Edit b/);
  assert.equal(formRouteInterval().props.value, 4500, "late Job A save cannot navigate away from Job B or replace its draft");
  await act(async () => { formSuccessRoute.unmount(); });

  let pendingValidationA;
  globalThis.fetch = formRouteFixture({
    validate(options) { return new Promise((resolve) => { pendingValidationA = { signal: options.signal, resolve }; }); },
    put() { throw new Error("Job A validation failure must not submit a PUT"); },
  });
  let formFailureRoute;
  await act(async () => { formFailureRoute = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b/edit", "/jobs/a/edit"], initialIndex: 1 }, React.createElement(MainRoutes))); });
  let failedValidationOperation;
  await act(() => { failedValidationOperation = formFailureRoute.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  assert.ok(pendingValidationA.signal, "Job validation receives an AbortSignal");
  await act(async () => { formFailureRoute.root.findAllByType("button").find((button) => textOf(button) === "Cancel").props.onClick(); });
  pendingValidationA.resolve(failureResponse("JOB_VALIDATE_FAILED", "Job A validation failed."));
  await act(async () => { await failedValidationOperation; });
  assert.match(textOf(formFailureRoute.toJSON()), /Edit b/);
  assert.doesNotMatch(textOf(formFailureRoute.toJSON()), /Job A validation failed/);
  await act(async () => { formFailureRoute.unmount(); });

  let invalidatedPut;
  globalThis.fetch = formRouteFixture({
    put(options) { return new Promise((resolve) => { invalidatedPut = { signal: options.signal, resolve }; }); },
  });
  let invalidSecondSave;
  await act(async () => { invalidSecondSave = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/a/edit"] }, React.createElement(MainRoutes))); });
  let pendingValidSave;
  await act(() => { pendingValidSave = invalidSecondSave.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  await act(async () => { await Promise.resolve(); });
  const firstTagName = invalidSecondSave.root.findAllByType("input").find((input) => input.props.value === "A");
  await act(async () => { firstTagName.props.onChange({ target: { value: "" } }); });
  await act(async () => { await invalidSecondSave.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  assert.equal(invalidatedPut.signal.aborted, true, "an invalid newer Save still cancels the older pending PUT");
  assert.match(textOf(invalidSecondSave.toJSON()), /Tag name is required/i);
  invalidatedPut.resolve(response({ ...initialA, revision: 2 }));
  await act(async () => { await pendingValidSave; });
  assert.match(textOf(invalidSecondSave.toJSON()), /Edit a/);
  await act(async () => { invalidSecondSave.unmount(); });

  let pendingSlowB;
  const slowBPutBodies = [];
  globalThis.fetch = formRouteFixture({
    detail(options, requestedName) {
      if (requestedName === "a") return response(initialA);
      return new Promise((resolve) => { pendingSlowB = { signal: options.signal, resolve }; });
    },
    put(options) { slowBPutBodies.push(JSON.parse(options.body)); return response({ ...initialB, revision: 2 }); },
  });
  let slowBEdit;
  await act(async () => { slowBEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b/edit", "/jobs/a/edit"], initialIndex: 1 }, React.createElement(MainRoutes))); });
  const staleTagName = slowBEdit.root.findAllByType("input").find((input) => input.props.value === "A");
  await act(async () => { staleTagName.props.onChange({ target: { value: "" } }); });
  await act(async () => { await slowBEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  assert.match(textOf(slowBEdit.toJSON()), /Tag name is required/i);
  await act(async () => { slowBEdit.root.findAllByType("button").find((button) => textOf(button) === "Cancel").props.onClick(); });
  const routedJobName = () => slowBEdit.root.findAllByType("input").find((input) => input.props.readOnly && input.props.disabled);
  assert.equal(routedJobName().props.value, "", "Job A name is cleared while Job B is loading");
  assert.doesNotMatch(textOf(slowBEdit.toJSON()), /Tag name is required/i, "Job A errors are cleared on the Job B route");
  assert.equal(slowBEdit.root.findAllByType("button").find((button) => textOf(button) === "Save").props.disabled, true);
  assert.equal(slowBEdit.root.findByProps({ "aria-label": "Job editing controls" }).props.disabled, true);
  await act(async () => { await slowBEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  assert.equal(slowBPutBodies.length, 0, "Job B cannot save with Job A's revision while its GET is pending");
  pendingSlowB.resolve(response(initialB));
  await act(async () => { await Promise.resolve(); });
  assert.equal(routedJobName().props.value, "b");
  assert.equal(slowBEdit.root.findAllByType("input").find((input) => String(input.props.min) === "1000").props.value, 4000);
  assert.doesNotMatch(textOf(slowBEdit.toJSON()), /Job status must be checked/i, "the temporary loading guard clears after Job B is loaded");
  assert.equal(slowBEdit.root.findAllByType("button").find((button) => textOf(button) === "Save").props.disabled, false);
  await act(async () => { await slowBEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  assert.equal(slowBPutBodies.at(-1).revision, 1, "Job B saves with Job B's loaded revision");
  await act(async () => { slowBEdit.unmount(); });

  const runTestCallRouteRace = async (lateResponse, marker) => {
    let pendingCall;
    globalThis.fetch = formRouteFixture({
      testCall(options) { return new Promise((resolve) => { pendingCall = { signal: options.signal, resolve }; }); },
    });
    let view;
    await act(async () => { view = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/b/edit", "/jobs/a/edit"], initialIndex: 1 }, React.createElement(MainRoutes))); });
    let operation;
    await act(() => { operation = view.root.findAllByType("button").find((button) => textOf(button) === "Test Call").props.onClick(); });
    await act(async () => { await Promise.resolve(); });
    assert.ok(pendingCall.signal, "Test Call receives an AbortSignal");
    await act(async () => { view.root.findAllByType("button").find((button) => textOf(button) === "Cancel").props.onClick(); });
    assert.equal(pendingCall.signal.aborted, true, "route change aborts Job A's Test Call");
    pendingCall.resolve(lateResponse);
    await act(async () => { await operation; });
    assert.match(textOf(view.toJSON()), /Edit b/);
    assert.equal(view.root.findAllByType("h2").some((heading) => textOf(heading) === "TEST CALL"), false, "late Job A diagnostics are not rendered on Job B");
    assert.doesNotMatch(textOf(view.toJSON()), new RegExp(marker));
    await act(async () => { view.unmount(); });
  };
  await runTestCallRouteRace(response({ success: true, durationMs: 12, valueCount: 1, body: "A_LATE_SUCCESS" }), "A_LATE_SUCCESS");
  await runTestCallRouteRace(failureResponse("DBUS_CALL_FAILED", "A_LATE_ERROR"), "A_LATE_ERROR");

  let unmountedTestCall;
  globalThis.fetch = formRouteFixture({
    testCall(options) { return new Promise((resolve) => { unmountedTestCall = { signal: options.signal, resolve }; }); },
  });
  let unmountedTestView;
  await act(async () => { unmountedTestView = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/a/edit"] }, React.createElement(MainRoutes))); });
  let unmountedTestOperation;
  await act(() => { unmountedTestOperation = unmountedTestView.root.findAllByType("button").find((button) => textOf(button) === "Test Call").props.onClick(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { unmountedTestView.unmount(); });
  assert.equal(unmountedTestCall.signal.aborted, true, "unmount aborts the active Test Call");
  unmountedTestCall.resolve(response({ success: true, body: "UNMOUNTED_RESULT" }));
  await unmountedTestOperation;

  const sameRouteCalls = [];
  globalThis.fetch = formRouteFixture({
    testCall(options) { return new Promise((resolve) => { sameRouteCalls.push({ signal: options.signal, resolve }); }); },
  });
  let repeatedTestView;
  await act(async () => { repeatedTestView = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/a/edit"] }, React.createElement(MainRoutes))); });
  const testCallButton = () => repeatedTestView.root.findAllByType("button").find((button) => textOf(button) === "Test Call");
  let olderCall;
  await act(() => { olderCall = testCallButton().props.onClick(); });
  await act(async () => { await Promise.resolve(); });
  let newerCall;
  await act(() => { newerCall = testCallButton().props.onClick(); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(sameRouteCalls[0].signal.aborted, true, "a newer Test Call aborts the older one");
  sameRouteCalls[1].resolve(response({ success: true, body: "NEWEST_RESULT" }));
  await act(async () => { await newerCall; });
  sameRouteCalls[0].resolve(response({ success: true, body: "OLDER_RESULT" }));
  await act(async () => { await olderCall; });
  assert.match(textOf(repeatedTestView.toJSON()), /NEWEST_RESULT/);
  assert.doesNotMatch(textOf(repeatedTestView.toJSON()), /OLDER_RESULT/);
  await act(async () => { repeatedTestView.unmount(); });

  let failedReads = 0;
  globalThis.fetch = conflictFixture(initialA, {
    detail() {
      failedReads += 1;
      if (failedReads === 1) return response(initialA);
      throw new Error("latest setting unavailable");
    },
  });
  let failedReloadEdit;
  await act(async () => { failedReloadEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/a/edit"] }, React.createElement(MainRoutes))); });
  await act(async () => { await failedReloadEdit.root.findByProps({ id: "job-form" }).props.onSubmit({ preventDefault() {} }); });
  assert.match(textOf(failedReloadEdit.toJSON()), /could not be reloaded/i);
  assert.doesNotMatch(textOf(failedReloadEdit.toJSON()), /latest setting was reloaded/i);
  await act(async () => { failedReloadEdit.unmount(); });

  const warningRequests = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url); warningRequests.push({ value, options });
    if (value.endsWith("/settings")) return response({ schemaVersion: 1, defaultProfileId: "ls-electric-plc", limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } });
    if (value.endsWith("/profile/list")) return response([{ id: "ls-electric-plc", displayName: "LS Electric PLC" }]);
    if (value.endsWith("/db/server/list")) return response([{ name: "local-db" }]);
    if (value.includes("/job/validate")) return response({ valid: true, warnings: [{ code: "TAG_NAME_USED_BY_ANOTHER_JOB", details: { jobs: ["other-job"], tags: ["A"] } }], config: jobConfig });
    if (value.includes("/job?") && options.method === "PUT") return response({ name: "line-a", config: jobConfig });
    if (value.includes("/job?")) return response({ name: "line-a", config: jobConfig, statusKnown: true, configState: "installed", executionState: "stopped", controllerState: "STOPPED" });
    if (value.includes("/profile?id=ls-electric-plc")) return response({ profile: editProfile, compatible: true, references: [] });
    if (value.includes("/db/connect")) return response({ reason: "connected" });
    if (value.includes("/db/table/list")) return response([]);
    if (value.includes("/db/table/columns")) return response([]);
    throw new Error(`unexpected ${value}`);
  };
  let warningEdit;
  await act(async () => { warningEdit = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/line-a/edit"] }, React.createElement(MainRoutes))); });
  const warningForm = warningEdit.root.findByProps({ id: "job-form" });
  await act(async () => { warningForm.props.onSubmit({ preventDefault() {} }); });
  assert.match(textOf(warningEdit.toJSON()), /TAG_NAME_USED_BY_ANOTHER_JOB/);
  assert.match(textOf(warningEdit.toJSON()), /other-job/);
  assert.equal(warningRequests.some((entry) => entry.value.includes("/job?") && entry.options.method === "PUT"), false);
  await act(async () => { warningForm.props.onSubmit({ preventDefault() {} }); });
  assert.equal(warningRequests.some((entry) => entry.value.includes("/job?") && entry.options.method === "PUT"), true);
  await act(async () => { warningEdit.unmount(); });
  globalThis.fetch = dataFetch;
  const delayedDataReads = [];
  globalThis.fetch = (url, options = {}) => {
    const value = String(url);
    if (value.includes("/job?")) return Promise.resolve(response({ name: "line-a", config: jobConfig }));
    if (value.includes("/db/table/tags")) return Promise.resolve(response({ tags: [{ name: "A" }, { name: "B" }] }));
    if (value.includes("/db/table/data")) return new Promise((resolve, reject) => {
      delayedDataReads.push({ name: new URL(value, "http://localhost").searchParams.get("names"), signal: options.signal, resolve, reject });
    });
    throw new Error(`unexpected ${value}`);
  };
  let delayedDataView;
  await act(async () => { delayedDataView = create(React.createElement(MemoryRouter, { initialEntries: ["/data/line-a"] }, React.createElement(MainRoutes))); });
  const delayedTag = (tag) => delayedDataView.root.findAllByType("button").find((button) => textOf(button) === tag);
  const delayedLoad = () => delayedDataView.root.findAllByType("button").find((button) => textOf(button) === "Load");
  await act(async () => { delayedTag("A").props.onClick(); delayedLoad().props.onClick(); await Promise.resolve(); });
  await act(async () => { delayedTag("B").props.onClick(); await Promise.resolve(); });
  assert.equal(delayedDataReads[0].signal.aborted, true, "Tag만 바꿔도 이전 Data Viewer 요청을 취소한다");
  delayedDataReads[0].resolve(response({ rows: [{ name: "A", value: 11 }] }));
  await act(async () => { await Promise.resolve(); });
  assert.doesNotMatch(textOf(delayedDataView.toJSON()), /11/, "취소된 A 성공은 새 Tag 선택을 덮지 않는다");
  await act(async () => { delayedTag("B").props.onClick(); delayedLoad().props.onClick(); await Promise.resolve(); });
  assert.equal(delayedDataReads.length, 2);
  delayedDataReads[1].resolve(response({ rows: [{ name: "B", value: 22 }], nextCursor: "b-next", previousCursor: null }));
  await act(async () => { await Promise.resolve(); });
  assert.equal(delayedDataView.root.findByProps({ "aria-label": "Next page" }).props.disabled, false, "늦은 A 성공은 B 커서를 덮어쓰지 않는다");
  assert.doesNotMatch(textOf(delayedDataView.toJSON()), /11/, "늦은 A 성공은 B 행을 덮어쓰지 않는다");
  await act(async () => { delayedTag("A").props.onClick(); delayedLoad().props.onClick(); await Promise.resolve(); delayedTag("B").props.onClick(); delayedLoad().props.onClick(); await Promise.resolve(); });
  delayedDataReads[3].resolve(response({ rows: [{ name: "B", value: 33 }], nextCursor: "b-next-2", previousCursor: null }));
  await act(async () => { await Promise.resolve(); });
  delayedDataReads[2].reject(new Error("A_LATE_ERROR"));
  await act(async () => { await Promise.resolve(); });
  assert.doesNotMatch(textOf(delayedDataView.toJSON()), /A_LATE_ERROR/, "늦은 A 실패는 B 오류를 덮어쓰지 않는다");
  await act(async () => { delayedDataView.unmount(); });
  globalThis.fetch = dataFetch;
  let dataView;
  await act(async () => { dataView = create(React.createElement(MemoryRouter, { initialEntries: ["/data/line-a"] }, React.createElement(MainRoutes))); });
  const tagButton = dataView.root.findAllByType("button").find((button) => textOf(button) === "A");
  const unavailableTagButton = dataView.root.findAllByType("button").find((button) => textOf(button) === "B");
  assert.equal(tagButton.props["data-available"], true);
  assert.equal(unavailableTagButton.props["data-available"], false);
  assert.equal(dataView.root.findAllByType("button").some((button) => textOf(button) === "OTHER-JOB-TAG"), false);
  const tagsUrl = new URL(requests.find((url) => url.includes("/db/table/tags")), "http://localhost");
  assert.deepEqual(Object.fromEntries(tagsUrl.searchParams), { server: "local-db", table: "TAG" });
  await act(async () => { tagButton.props.onClick(); });
  await act(async () => { dataView.root.find((node) => node.type === "input" && node.props["aria-label"] === "Start time").props.onChange({ target: { value: "2026-08-01T00:00:00Z" } }); });
  await act(async () => { dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.onClick(); });
  const gridUrl = new URL(requests.find((url) => url.includes("/db/table/data")), "http://localhost");
  assert.deepEqual(Object.fromEntries(gridUrl.searchParams), { job: "line-a", names: "A", from: "2026-08-01T00:00:00Z", direction: "latest", rowsPerTag: "100" });
  assert.equal(dataView.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Timezone").length, 0);
  assert.equal(dataView.root.find((node) => node.type === "input" && node.props["aria-label"] === "Start time").props.placeholder, "2026-08-01T00:00:00Z");
  assert.equal(dataView.root.findByProps({ "aria-label": "Next page" }).props.disabled, false);
  await act(async () => { dataView.root.findByProps({ "aria-label": "Next page" }).props.onClick(); });
  const nextGridUrl = new URL(requests.filter((url) => url.includes("/db/table/data")).at(-1), "http://localhost");
  assert.equal(nextGridUrl.searchParams.get("cursor"), "next-token");
  await act(async () => { dataView.root.findByProps({ "aria-label": "Direction" }).props.onChange({ target: { value: "oldest" } }); });
  assert.equal(dataView.root.findByProps({ "aria-label": "Next page" }).props.disabled, true);
  assert.equal(dataView.root.findByProps({ "aria-label": "Previous page" }).props.disabled, true);
  await act(async () => { dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.onClick(); });
  const resetGridUrl = new URL(requests.filter((url) => url.includes("/db/table/data")).at(-1), "http://localhost");
  assert.equal(resetGridUrl.searchParams.has("cursor"), false, "ordinary Load starts from the first page");
  assert.equal(resetGridUrl.searchParams.get("direction"), "oldest");
  await act(async () => { dataView.root.findByProps({ "aria-label": "Viewer mode" }).props.onChange({ target: { value: "chart" } }); });
  assert.equal(dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.disabled, true, "a partial numeric page cannot enable Chart");
  assert.match(textOf(dataView.toJSON()), /narrow the range/i);
  await act(async () => { dataView.root.findByProps({ "aria-label": "Viewer mode" }).props.onChange({ target: { value: "grid" } }); });
  dataScenario = "mixed";
  await act(async () => { dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.onClick(); });
  await act(async () => { dataView.root.findByProps({ "aria-label": "Viewer mode" }).props.onChange({ target: { value: "chart" } }); });
  assert.equal(dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.disabled, true, "mixed rows cannot enable Chart");
  await act(async () => { dataView.root.findByProps({ "aria-label": "Viewer mode" }).props.onChange({ target: { value: "grid" } }); });
  dataScenario = "complete";
  await act(async () => { dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.onClick(); });
  await act(async () => { dataView.root.findByProps({ "aria-label": "Viewer mode" }).props.onChange({ target: { value: "chart" } }); });
  assert.equal(dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.disabled, false, "one complete all-numeric page enables Chart");
  await act(async () => { dataView.root.find((node) => node.type === "input" && node.props["aria-label"] === "End time").props.onChange({ target: { value: "2026-08-02" } }); });
  assert.equal(dataView.root.findAllByType("button").find((button) => textOf(button) === "Load").props.disabled, true, "changing the exact range invalidates Chart evidence");
  await act(async () => { dataView.unmount(); });

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/job?")) return response({ name: "line-a", config: jobConfig });
    if (value.includes("/db/table/tags")) throw new Error("metadata unavailable");
    throw new Error(`unexpected ${value}`);
  };
  let dataViewWithoutAvailability;
  await act(async () => { dataViewWithoutAvailability = create(React.createElement(MemoryRouter, { initialEntries: ["/data/line-a"] }, React.createElement(MainRoutes))); });
  await act(async () => { dataViewWithoutAvailability.root.findAllByType("button").find((button) => textOf(button) === "A").props.onClick(); });
  assert.match(textOf(dataViewWithoutAvailability.toJSON()), /availability could not be checked/i);
  assert.notEqual(dataViewWithoutAvailability.root.findAllByType("button").find((button) => textOf(button) === "Load").props.disabled, true);
  await act(async () => { dataViewWithoutAvailability.unmount(); });

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/log/list")) return response({ name: "line-a", files: [{ name: "line-a.log", active: true }] });
    if (value.includes("/log/content/all")) return response({ content: "all\ncontent" });
    if (value.includes("/log/content")) return response({ lines: ["page one", "page two"] });
    if (value.includes("/log/tail")) return response({ lines: ["tail one", "tail two"] });
    throw new Error(`unexpected ${value}`);
  };
  let logs;
  await act(async () => { logs = create(React.createElement(MemoryRouter, { initialEntries: ["/logs/line-a"] }, React.createElement(MainRoutes))); });
  await act(async () => { logs.root.findByProps({ "aria-label": "Log file" }).props.onChange({ target: { value: "line-a.log" } }); });
  await act(async () => { logs.root.findAllByType("button").find((button) => textOf(button) === "Content").props.onClick(); });
  assert.match(textOf(logs.toJSON()), /page one\npage two/);
  await act(async () => { logs.root.findAllByType("button").find((button) => textOf(button) === "All").props.onClick(); });
  assert.match(textOf(logs.toJSON()), /all\ncontent/);
  await act(async () => { logs.root.findAllByType("button").find((button) => textOf(button) === "Tail").props.onClick(); });
  assert.match(textOf(logs.toJSON()), /tail one\ntail two/);
  await act(async () => { logs.unmount(); });

  const jobCustomProfile = {
    schemaVersion: 1, id: "custom-plc", profileVersion: 1, displayName: "Custom PLC", vendor: "Factory", builtIn: false,
    compatibility: { minNeoVersion: "8.5.6" }, defaults: { busType: "system", destination: "factory.plc" },
    methods: [{ id: "read-value", displayName: "Read Value", objectPath: "/factory/plc", interface: "factory.plc", methodName: "ReadValue", inputs: [{ id: "address", type: "string", required: true }], output: { decoder: "json", shape: "scalar", path: "value", success: { path: "result.code", operator: "equals", value: 1 } } }],
  };
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/settings")) return response({ schemaVersion: 1, defaultProfileId: "custom-plc", limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } });
    if (value.endsWith("/profile/list")) return response([{ id: "custom-plc", displayName: "Custom PLC", defaults: jobCustomProfile.defaults }]);
    if (value.includes("/profile?id=custom-plc")) return response({ profile: jobCustomProfile, compatible: true, references: [] });
    if (value.endsWith("/db/server/list")) return response([{ name: "local-db" }]);
    if (value.includes("/db/connect")) return response({ reason: "connected" });
    if (value.includes("/db/table/list")) return response([]);
    if (value.includes("/db/table/columns")) return response([]);
    throw new Error(`unexpected ${value}`);
  };
  let newJob;
  await act(async () => { newJob = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/new"] }, React.createElement(MainRoutes))); });
  const methodSelect = () => newJob.root.findAllByType("select").find((select) => String(select.props["aria-label"] || "").endsWith(" Method"));
  assert.equal(methodSelect().props.value, "read-value", "default custom Profile uses its real Method");
  await act(async () => { newJob.root.findAllByType("button").find((button) => textOf(button) === "Add Call").props.onClick(); });
  assert.deepEqual(newJob.root.findAllByType("select").filter((select) => String(select.props["aria-label"] || "").endsWith(" Method")).map((select) => select.props.value), ["read-value", "read-value"]);
  await act(async () => { newJob.root.findAllByType("button").find((button) => textOf(button) === "Preview").props.onClick(); });
  assert.equal(newJob.root.findAllByType("button").find((button) => textOf(button) === "Apply").props.disabled, true, "Bulk preview validates duplicate Tag names across the whole Job");
  await act(async () => { newJob.unmount(); });

  const customProfile = {
    schemaVersion: 1, id: "custom-plc", profileVersion: 2, displayName: "Custom PLC", vendor: "Factory", builtIn: false,
    compatibility: { minNeoVersion: "8.5.6" }, defaults: { busType: "system", destination: "factory.plc" },
    methods: [{ id: "read-value", displayName: "Read Value", objectPath: "/factory/plc", interface: "factory.plc", methodName: "ReadValue", inputs: [{ id: "address", type: "string", required: true }], output: { decoder: "json", shape: "scalar", path: "value", success: { path: "result.code", operator: "equals", value: 1 } } }],
  };
  const profileRequests = [];
  let profileReferenceState = "STOPPED";
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url); profileRequests.push({ value, options });
    if (value.endsWith("/profile/list")) return response([{ id: "custom-plc", displayName: "Custom PLC", vendor: "Factory", builtIn: false, profileVersion: 2, methodCount: 1, compatible: true, default: true }]);
    if (value.endsWith("/settings") && options.method === "PUT") return response(JSON.parse(options.body));
    if (value.endsWith("/settings")) return response({ schemaVersion: 1, defaultProfileId: "custom-plc", limits: { maxGeneratedTagsPerCall: 1000, maxBufferedRowsPerCycle: 10000 } });
    if (value.endsWith("/method") && options.method === "PUT") { profileReferenceState = "RUNNING"; return response({ profileId: "custom-plc", method: customProfile.methods[0] }); }
    if (value.includes("/profile?id=custom-plc")) return response({ profile: customProfile, compatible: true, references: [{ name: "line-a", controllerState: profileReferenceState }] });
    if (value.includes("/method?profileId=custom-plc")) return response({ method: customProfile.methods[0], references: [{ name: "line-a", controllerState: profileReferenceState }] });
    throw new Error(`unexpected ${value}`);
  };
  let profiles;
  await act(async () => { profiles = create(React.createElement(MemoryRouter, { initialEntries: ["/profiles"] }, React.createElement(MainRoutes))); });
  assert.equal(profiles.root.findByProps({ "aria-label": "Default Profile" }).props.value, "custom-plc");
  assert.equal(profiles.root.findByProps({ "aria-label": "Max Generated Tags" }).props.value, 1000);
  await act(async () => { profiles.root.find((node) => node.type === "input" && node.props["aria-label"] === "Max Generated Tags").props.onChange({ target: { value: "750" } }); });
  await act(async () => { profiles.root.findAllByType("button").find((button) => textOf(button) === "Save Settings").props.onClick(); });
  assert.deepEqual(JSON.parse(profileRequests.find((entry) => entry.value.endsWith("/settings") && entry.options.method === "PUT").options.body), { schemaVersion: 1, defaultProfileId: "custom-plc", limits: { maxGeneratedTagsPerCall: 750, maxBufferedRowsPerCycle: 10000 } });
  await act(async () => { profiles.root.findAllByType("button").find((button) => textOf(button) === "Custom PLC").props.onClick(); });
  assert.equal(profiles.root.findAllByType("button").find((button) => textOf(button) === "Edit Profile").props.disabled, false);
  assert.equal(profiles.root.findAllByType("button").find((button) => textOf(button) === "Delete Profile").props.disabled, true);
  await act(async () => { profiles.root.findAllByType("button").find((button) => textOf(button) === "Edit Profile").props.onClick(); });
  assert.notEqual(profiles.root.findAllByType("button").find((button) => textOf(button) === "Save Profile").props.disabled, true);
  assert.equal(profiles.root.findByProps({ "aria-label": "Method input type" }).props.value, "string");
  assert.equal(profiles.root.findByProps({ "aria-label": "Success value type" }).props.value, "number");
  await act(async () => { profiles.root.find((node) => node.type === "input" && node.props["aria-label"] === "Success Value").props.onChange({ target: { value: "2" } }); });
  await act(async () => { profiles.root.findAllByType("button").find((button) => textOf(button) === "Save Method").props.onClick(); });
  await act(async () => { await Promise.resolve(); });
  const methodUpdate = JSON.parse(profileRequests.find((entry) => entry.value.endsWith("/method") && entry.options.method === "PUT").options.body);
  assert.equal(methodUpdate.method.output.success.value, 2);
  assert.equal(typeof methodUpdate.method.output.success.value, "number");
  assert.match(textOf(profiles.toJSON()), /RUNNING/);
  assert.equal(profiles.root.findAllByType("button").find((button) => textOf(button) === "Edit Profile").props.disabled, true);
  const saveProfile = profiles.root.findAllByType("button").find((button) => textOf(button) === "Save Profile");
  assert.equal(Boolean(saveProfile) && saveProfile.props.disabled !== true, false, "new blocking state cancels or disables Profile edit");
  assert.equal(profiles.root.findAllByType("button").find((button) => textOf(button) === "Add Method").props.disabled, true);
  assert.equal(profiles.root.findAllByType("button").find((button) => textOf(button) === "New Method").props.disabled, true);
  assert.equal(profiles.root.findAllByType("button").find((button) => textOf(button) === "Edit Method").props.disabled, true);
  assert.equal(profiles.root.findAllByType("button").find((button) => textOf(button) === "Delete Method").props.disabled, true);
  await act(async () => { profiles.unmount(); });

  const dbRequests = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url); dbRequests.push({ value, options });
    if (value.endsWith("/db/server/list")) return response([{ name: "local-db", host: "127.0.0.1", port: 5656 }]);
    if (value.includes("/db/table/create")) return response({ server: "local-db", table: "NEW_TAG", created: true });
    if (value.includes("/db/table/list")) return response([{ name: "NEW_TAG" }]);
    throw new Error(`unexpected ${value}`);
  };
  let dbPage;
  await act(async () => { dbPage = create(React.createElement(MemoryRouter, { initialEntries: ["/db-servers"] }, React.createElement(MainRoutes))); });
  await act(async () => { dbPage.root.findByProps({ "aria-label": "Table server" }).props.onChange({ target: { value: "local-db" } }); });
  await act(async () => { dbPage.root.find((node) => node.type === "input" && node.props["aria-label"] === "Table name").props.onChange({ target: { value: "NEW_TAG" } }); });
  await act(async () => { dbPage.root.findAllByType("button").find((button) => textOf(button) === "Create TAG Table").props.onClick(); });
  assert.deepEqual(JSON.parse(dbRequests.find((entry) => entry.value.includes("/db/table/create")).options.body), { server: "local-db", table: "NEW_TAG" });
  await act(async () => { dbPage.unmount(); });

  const css = fs.readFileSync(path.join(root, "src/styles.css"), "utf8");
  assert.match(css, /--neo-side-width:\s*256px/);
  assert.match(css, /--neo-radius:\s*4px/);
  assert.match(css, /grid-template-columns:\s*var\(--neo-side-width\)\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /outline:\s*2px\s+solid\s+var\(--neo-interactive-hover\)/);
  assert.doesNotMatch(css, /border-radius:\s*8px|box-shadow:\s*0\s+[2-9]\d/);
  assert.doesNotMatch(css, /height:\s*480px|minmax\(120px|100px/);
} finally {
  await server.close();
}
console.log("app contract tests passed");
