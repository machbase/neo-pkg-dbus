import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const vite = await createServer({
  configFile: false,
  root: new URL("..", import.meta.url).pathname,
  resolve: { alias: { "@product": new URL("../../products/generic/frontend/index.jsx", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false },
  ssr: { external: ["react", "react-router"] },
  appType: "custom",
  logLevel: "error",
});
const { AppProvider, ConnectedSide, DbusInterfaceFormModal, DbusInterfacesModal, JobSide, MainRoutes, MemoryRouter } = await vite.ssrLoadModule("/src/App.jsx");
const { default: DataViewerPage } = await vite.ssrLoadModule("/src/data-viewer/DataViewerPage.jsx");
const { api } = await vite.ssrLoadModule("/src/api.js");

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const button = (root, label) => root.findAll((node) => node.type === "button" && node.props["aria-label"] === label)[0];
const buttonText = (root, text) => root.findAll((node) => node.type === "button" && (text === "Save Interface" ? ["Save Interface", "Create Interface", "Update Interface"].some((label) => node.children.join("").includes(label)) : node.children.join("").includes(text)))[0];
const interfaceValue = (id, overrides = {}) => ({
  id,
  name: `Interface ${id}`,
  interface: `com.example.${id}`,
  busType: "system",
  destination: `com.example.${id}`,
  objectPath: `/${id}`,
  builtIn: false,
  origin: "manual",
  methodCount: 0,
  methods: [],
  ...overrides,
});

function renderModal() {
  return create(React.createElement(DbusInterfacesModal));
}

test("Settings API 실패는 Side에 남기지 않고 DBus Interface 진입점을 숨긴다", async () => {
  let renderer;
  await act(async () => { renderer = create(React.createElement(JobSide, {
    jobs: [], selected: "", loading: false,
    settingsError: { code: "PROVIDER_PROFILE_INVALID", reason: "Provider Profile is invalid." },
    onSelect() {}, onNew() {}, onRefresh() {}, onToggle() {},
  })); });
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /PROVIDER_PROFILE_INVALID/);
  assert.equal(button(renderer.root, "New DBus Interface"), undefined);
  await act(async () => { renderer.unmount(); });
});

test("Settings 실패와 fixed 기존 Job은 안전한 Job form mode를 선택한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const formMode = jobFormMode\(/);
  assert.match(source, /const formBlocked = formMode === "blocked"/);
  assert.match(source, /const fixedNewJob = formMode === "fixed"/);
  assert.match(source, /disabled=\{formBlocked\}/);
  assert.match(source, /\{formMode === "blocked" \? <Notice status>/);
});

test("Database 영역은 읽기 전용 요약과 편집 모달을 제공한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /const \[databaseModalOpen, setDatabaseModalOpen\] = useState\(false\);/);
  assert.match(source, /<JobSectionSummary className="neo-database-summary" label="DATABASE"/);
  assert.match(source, /<Modal title="Edit Database"[^>]*variant="job-section-editor"/);
  assert.match(source, /className="neo-database-summary" label="DATABASE"/);
  assert.match(source, /config\.database\.server \|\| "—"/);
  assert.match(source, /config\.database\.table \|\| "—"/);
  assert.match(styles, /\.neo-job-section-summary/);
});

test("Job Configuration은 읽기 전용 요약과 편집 모달을 제공한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /const \[jobConfigurationModalOpen, setJobConfigurationModalOpen\] = useState\(false\);/);
  assert.match(source, /<JobSectionSummary className="neo-job-configuration-summary" label="JOB CONFIGURATION"/);
  assert.match(source, /<Modal title="Edit Job Configuration"[^>]*variant="job-section-editor"/);
  assert.match(source, /className="neo-job-configuration-summary"/);
  assert.match(source, /\{ label: "JOB NAME", value: name \|\| "—" \}/);
  assert.match(source, /\{ label: "RUN INTERVAL", value: `\$\{config\.schedule\.intervalMs\} ms` \}/);
  assert.match(source, /\{ label: "SAVE POLICY", value: config\.execution\.savePolicy \}/);
  assert.match(styles, /\.neo-job-section-summary/);
});

test("기존 Job 목록을 새로 읽는 동안에는 Loading jobs 문구를 보이지 않는다", async () => {
  let renderer;
  await act(async () => { renderer = create(React.createElement(JobSide, {
    jobs: [{ name: "line-a", statusKnown: true, configState: "installed", executionState: "stopped", controllerState: "STOPPED" }],
    selected: "", loading: true, onSelect() {}, onNew() {}, onRefresh() {}, onToggle() {},
  })); });
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Loading jobs/);
  await act(async () => { renderer.unmount(); });
});

test("Job 상태 갱신은 기존 상세를 유지한 채 한 번만 다시 읽는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\}, \[name, app\.jobRevision\]\);/);
  assert.match(source, /if \(lastJobRevision\.current === app\.jobRevision\) return;[\s\S]*void loaded\.reload\(\);/);
  assert.match(source, /loaded\.loading && !job \? <p className="neo-message"/);
});

test("Job 상세는 의미별 세 카드와 최신 실행 시각을 표시한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /className="neo-job-overview"/);
  assert.match(source, /label="JOB"/);
  assert.match(source, /label="METHOD CALLS"/);
  assert.match(source, /label="DATABASE"/);
  assert.doesNotMatch(source, /<Metric label="CONFIG"/);
  assert.match(source, /label="LATEST STATUS" value=\{lastRun\.status\}/);
  assert.match(source, /label="LAST SUCCESSFUL" value=\{lastRun\.lastSuccessfulRunAt/);
  assert.match(source, /label="LAST STORED" value=\{lastRun\.lastStoredAt/);
  assert.doesNotMatch(source, /label="SKIPPED CYCLES"/);
  assert.doesNotMatch(source, /label="LAST SKIPPED"/);
  assert.match(source, /const hasSkippedCycles = Number\(lastRun\?\.overrunCount \|\| 0\) > 0/);
  assert.match(source, /\{hasSkippedCycles \? <div className="neo-overview-card__overrun">/);
  assert.match(styles, /\.neo-overview-card__overrun/);
  assert.match(source, /<th>Rows saved<\/th>/);
  assert.match(source, /setInterval\(\(\) => \{ void loaded\.reload\(\); \}, 5000\)/);
  assert.match(source, /const \[monitorRefreshEpoch, setMonitorRefreshEpoch\] = useState\(0\)/);
  assert.match(source, /\[job\?\.running, loaded\.reload, monitorRefreshEpoch\]/);
  assert.match(source, /label="Refresh monitoring"[^>]*onClick=\{refreshMonitoring\}/);
  assert.match(styles, /\.neo-job-overview\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
});

test("Job 상세는 Live Logs, LOGS 패널의 Log Level 제어와 저장 로그 화면을 연결한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /function isTransientRequestError\(error\)/);
  assert.match(source, /import LiveLogs from "\.\/live-logs\/LiveLogs"/);
  assert.match(source, /const \[liveLogsOpen, setLiveLogsOpen\] = useState\(false\)/);
  assert.match(source, /terminal[^]*Live Logs[^]*query_stats[^]*Data Viewer[^]*edit[^]*Edit[^]*delete[^]*Delete/);
  assert.doesNotMatch(source, />Logs<\/Link>/);
  assert.match(source, /<h2>LOGS<\/h2>/);
  assert.match(source, /neo-logging-controls__item--level[^]*aria-label="Log level"/);
  assert.match(source, /updateLogLevel\(name, \{ revision: job\.revision, level: logLevel \}/);
  assert.match(source, /aria-label="Log level"/);
  assert.match(source, /ROTATION[^]*logSizeLabel\(loggingPolicy\.maxFileBytes\)[^]*loggingPolicy\.maxFiles/);
  assert.doesNotMatch(source, /Records \$\{recordedLevels/);
  assert.match(source, /to=\{`\/logs\/\$\{encodeURIComponent\(name\)\}`\}[^]*View Logs/);
  assert.match(source, /<LiveLogs jobName=\{name\} open=\{liveLogsOpen\}/);
  assert.match(styles, /\.neo-logging-controls/);
  assert.match(styles, /\.neo-button--primary-outline/);
});

test("초기 Job 선택, skip 초기화와 로그 파일 기본 읽기 UX를 제공한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /locationPathRef\.current === "\/" && initialName\) navigateRef\.current\(`\/jobs\/\$\{encodeURIComponent\(initialName\)\}`/);
  assert.match(source, /api\.jobs\.clearOverrun\(name/);
  // app.run() increments jobRevision, which already reloads the detail. A
  // second explicit reload would abort the first Job/last-run request and
  // make the side panel show a spurious request-failed toast.
  const clearOverrunSource = source.slice(source.indexOf("const clearOverrun = async"), source.indexOf("return <main", source.indexOf("const clearOverrun = async")));
  assert.doesNotMatch(clearOverrunSource, /loaded\.reload\(\)/);
  assert.match(source, /SKIPPED \{lastRun\.overrunCount\}/);
  assert.match(source, /label="Clear skipped cycle monitoring"/);
  assert.match(source, /icon="delete_sweep"/);
  assert.match(source, /const initialFile = files\[0\]\.name/);
  assert.match(source, /void read\("content", initialFile\)/);
  assert.match(source, /title="Read the current log file"/);
  assert.match(source, /title="Read this log and its rotated files"/);
  assert.match(source, /title="Read the most recent log lines"/);
  assert.match(source, /onBack=\{\(\) => navigate\(name \? `\/jobs\/\$\{encodeURIComponent\(name\)\}` : "\/"\)\}/);
  assert.match(styles, /\.neo-side \{[^}]*width: 100%;[^}]*min-width: 0;/);
  assert.match(styles, /\.neo-side__section \{[^}]*padding: 0 12px;/);
  assert.match(styles, /\.neo-job-row \{[^}]*padding-right: 12px;/);
  assert.match(styles, /\.neo-job-row \{ display: grid; width: 100%;[^}]*grid-template-columns: minmax\(0, 1fr\) 28px;/);
  assert.match(styles, /\.neo-job-row__select \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
  assert.match(styles, /\.neo-button\.is-active,[\s\S]*background: var\(--neo-primary\);[\s\S]*font-weight: 600;/);
  assert.match(styles, /\.neo-overview-card__overrun/);
  assert.match(styles, /border: 1px solid #ff9800/);
  assert.match(styles, /\.neo-overview-card__overrun \.neo-icon-button \{[^}]*color: #ff6b6b;[^}]*background: rgba\(255, 71, 71, \.16\);/);
  assert.match(styles, /\.neo-overview-card__overrun \.neo-icon-button:hover \{[^}]*background: #d84343;/);
});

test("Edit 경로 전환은 side Job 재선택 메시지로 되돌아가지 않는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const locationPathRef = useRef\(location\.pathname\);/);
  assert.match(source, /const navigateRef = useRef\(navigate\);/);
  assert.match(source, /locationPathRef\.current = location\.pathname;/);
  assert.match(source, /navigateRef\.current = navigate;/);
  assert.match(source, /function routeJobName\(pathname\)/);
  assert.match(source, /message\.surface === "side"/);
  assert.match(source, /channel\.ready\(surface\)/);
  assert.match(source, /locationPathRef\.current === "\/" && initialName/);
  assert.match(source, /\}, \[notify, surface\]\);/);
  assert.match(source, /\}, \[clearJobSave, deferJobSelection, refresh, surface\]\);/);
  assert.doesNotMatch(source, /\}, \[navigate, refresh, surface\]\);/);
  assert.doesNotMatch(source, /\}, \[location\.pathname, navigate, notify, surface\]\);/);
});

test("모든 API 실패는 패널 오류 대신 자동으로 사라지는 알림으로 표시한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /setError\(null\);\s*notify\(failure\);/);
  assert.match(source, /function ToastLayer\(\)[\s\S]*window\.setTimeout\(\(\) => dismissToast\(toast\.id\), 5000\)/);
  assert.match(source, /function Notice\(\{ error, status, children \}\)[\s\S]*if \(error\) notify\(error\);[\s\S]*if \(error \|\| !children\) return null/);
  assert.match(source, /app\.notify\(failure\);/);
  assert.match(source, /<ToastLayer \/>/);
  assert.match(styles, /\.neo-toast-stack/);
});

test("LS Job Configuration은 retry 입력을 숨기고 정해진 주기마다 연결을 다시 시도한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const lsProduct = fs.readFileSync(new URL("../../products/ls/frontend/model.mjs", import.meta.url), "utf8");
  const collector = fs.readFileSync(new URL("../../collector-go/cmd/neo-dbus-collector/main.go", import.meta.url), "utf8");
  assert.match(source, /retryConfigurable as productRetryConfigurable/);
  assert.match(source, /\{productRetryConfigurable \? <>\s*<Field label="Retry Initial/);
  assert.match(lsProduct, /export const retryConfigurable = false;/);
  assert.match(collector, /if connection == nil \{[\s\S]*connection, connectError = d\.connectDBus\(name\)/);
  assert.doesNotMatch(collector, /func \(d \*daemon\) connectDBus\(ctx context\.Context, config jobConfig/);
});

test("Job 저장은 중복 제출과 경로 전환 취소를 막고 최신 revision을 계속 사용한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /if \(savingRef\.current\) return;/);
  assert.match(source, /disabled=\{saving \|\| app\.jobSaving\}/);
  assert.doesNotMatch(source, /disabled=\{formBlocked \|\| saving\}/);
  assert.match(source, /useRouteMutation\(editing \? params\.name : "new", \{ abortOnRouteChange: false \}\)/);
  assert.match(source, /const saveLease = app\.beginJobSave\(\);/);
  assert.match(source, /const completion = app\.finishJobSave\(saveLease\.token\);/);
  assert.match(source, /completion\.current && !completion\.pendingSelection/);
  assert.match(source, /revision: editRevision/);
  assert.match(source, /setEditRevision\(updated\.revision\)/);
  assert.match(source, /setEditRevision\(latestJob\.revision\)/);
  assert.match(source, /await app\.refresh\(\{ signal: submission\.signal, broadcast: true \}\);/);
  assert.match(source, /completion\.current && !completion\.pendingSelection[\s\S]*app\.selectJob\(targetName\);/);
});

test("Job 저장 중 선택한 다른 Job은 저장 완료 뒤 열리고 PUT 요청은 abort되지 않는다", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  const original = {
    settingsGet: api.settings.get,
    interfacesList: api.interfaces.list,
    interfacesGet: api.interfaces.get,
    jobsList: api.jobs.list,
    jobsGet: api.jobs.get,
    jobsStatus: api.jobs.status,
    jobsValidate: api.jobs.validate,
    jobsUpdate: api.jobs.update,
    serversList: api.db.servers.list,
    tablesList: api.db.tables.list,
    tablesColumns: api.db.tables.columns,
  };
  const method = { id: "read", member: "Read", inputs: [], outputs: [{ name: "value", type: "double" }] };
  const dbusInterface = {
    id: "device", name: "Device", interface: "com.example.Device", busType: "system",
    destination: "com.example.Device", objectPath: "/device", methods: [method],
  };
  const config = {
    schemaVersion: 1,
    schedule: { intervalMs: 1000 },
    retry: { initialDelayMs: 1000, maximumDelayMs: 10000, multiplier: 2 },
    execution: { savePolicy: "perMethod", onMethodError: "stop" },
    methodCalls: [{
      id: "read-a", name: "Read A", interfaceId: "device", methodId: "read", inputs: {},
      outputSelections: [{
        id: "value", sourceIndex: 0, interpretation: "native",
        tags: [{ name: "TAG_A", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"], signed: false }],
      }],
    }],
    database: { server: "local", table: "TAG", valueColumn: "VALUE", stringValueColumn: "" },
    log: { level: "info", maxFiles: 3 },
  };
  const jobs = ["job-a", "job-b"].map((name) => ({
    name, statusKnown: true, configState: "installed", executionState: "stopped",
    controllerState: "STOPPED", installed: true, running: false,
  }));
  const update = deferred();
  let updateSignal = null;
  let mainRenderer;
  let sideRenderer;
  try {
    class TestBroadcastChannel {
      static instances = new Set();
      constructor(name) { this.name = name; this.onmessage = null; TestBroadcastChannel.instances.add(this); }
      postMessage(data) {
        for (const peer of TestBroadcastChannel.instances) {
          if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data }));
        }
      }
      close() { TestBroadcastChannel.instances.delete(this); }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: TestBroadcastChannel });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      innerWidth: 1280, innerHeight: 720,
      setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener() {}, removeEventListener() {}, confirm() { return true; },
      localStorage: { setItem() {}, removeItem() {} },
    } });
    Object.assign(api.settings, { get: async () => ({ provider: null, defaults: { database: { server: "local" } }, limits: { maxGeneratedTagsPerCall: 100, maxBufferedRowsPerCycle: 100 }, intervalPolicy: { cycleMs: 1 } }) });
    Object.assign(api.interfaces, {
      list: async () => [{ ...dbusInterface, methodCount: 1 }],
      get: async () => ({ interface: dbusInterface, references: [] }),
    });
    Object.assign(api.jobs, {
      list: async () => jobs,
      get: async (name) => ({ ...jobs.find((job) => job.name === name), config, revision: 1 }),
      status: async (name) => ({ job: { ...jobs.find((job) => job.name === name), config, revision: name === "job-a" ? 2 : 1 }, lastRun: null }),
      validate: async () => ({ valid: true, warnings: [] }),
      update: async (_name, _payload, options = {}) => {
        updateSignal = options.signal;
        return update.promise;
      },
    });
    Object.assign(api.db.servers, { list: async () => [{ name: "local", defaultTable: "TAG", valueColumn: "VALUE", stringValueColumn: "" }] });
    Object.assign(api.db.tables, {
      list: async () => [{ name: "TAG" }],
      columns: async () => ({ columns: [{ name: "VALUE", numeric: true, kind: "value" }] }),
    });

    await act(async () => {
      sideRenderer = create(React.createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        React.createElement(AppProvider, { surface: "side" }, React.createElement(ConnectedSide)),
      ));
      mainRenderer = create(React.createElement(
        MemoryRouter,
        { initialEntries: ["/jobs/job-a/edit"] },
        React.createElement(AppProvider, { surface: "index" }, React.createElement(MainRoutes)),
      ));
    });
    await flush();
    await flush();
    const form = mainRenderer.root.findAll((node) => node.type === "form" && node.props.id === "job-form")[0];
    let savePromise;
    await act(async () => { savePromise = form.props.onSubmit({ preventDefault() {} }); await Promise.resolve(); });
    await flush();
    assert.ok(updateSignal, "PUT Job 요청이 시작되어야 합니다.");

    const jobB = sideRenderer.root.findAll((node) => node.props.className === "neo-job-row__select"
      && node.findAll((child) => child.type === "span" && child.children.join("") === "job-b").length)[0];
    await act(async () => { jobB.props.onClick(); });
    await flush();
    assert.equal(updateSignal.aborted, false, "Job 선택이 이미 시작한 PUT 요청을 abort하면 안 됩니다.");
    assert.match(sideRenderer.root.findAll((node) => node.props.className === "neo-side__saving")[0].children.join(""), /NEXT job-b/);
    assert.ok(mainRenderer.root.findAll((node) => node.type === "h1" && node.children.join("") === "Edit job-a").length,
      "저장 중에는 기존 편집 경로를 유지해야 합니다.");

    update.resolve({ name: "job-a", revision: 2 });
    await act(async () => { await savePromise; });
    await flush();
    await flush();
    assert.equal(updateSignal.aborted, false);
    assert.ok(mainRenderer.root.findAll((node) => node.type === "h1" && node.children.join("") === "job-b").length,
      "저장 완료 뒤 보류한 Job으로 이동해야 합니다.");
  } finally {
    if (sideRenderer) await act(async () => { sideRenderer.unmount(); });
    if (mainRenderer) await act(async () => { mainRenderer.unmount(); });
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
    if (originalBroadcastChannel) Object.defineProperty(globalThis, "BroadcastChannel", originalBroadcastChannel);
    else delete globalThis.BroadcastChannel;
    Object.assign(api.settings, { get: original.settingsGet });
    Object.assign(api.interfaces, { list: original.interfacesList, get: original.interfacesGet });
    Object.assign(api.jobs, {
      list: original.jobsList, get: original.jobsGet, status: original.jobsStatus,
      validate: original.jobsValidate, update: original.jobsUpdate,
    });
    Object.assign(api.db.servers, { list: original.serversList });
    Object.assign(api.db.tables, { list: original.tablesList, columns: original.tablesColumns });
  }
});

test("LS Tag 표는 Signed 변환을 계산 Transform보다 먼저 표시한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /neo-fixed-tag-list__name" \/><col className="neo-fixed-tag-list__signed" \/><col className="neo-fixed-tag-list__transform"/);
  assert.match(source, /<th>TAG NAME<\/th><th>SIGNED<\/th><th>TRANSFORM<\/th>/);
});

test("Start와 Stop은 현재 Side 목록을 다시 읽지 않고 응답 Job 상태를 반영한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /jobName/);
  assert.match(source, /setJobs\(\(current\) => removeJob[\s\S]*current\.map/);
  assert.match(source, /\} else await refresh\(\{ signal \}\);/);
});

test("Start와 Stop 요청 중에는 모든 Job switch를 잠그고 중복 요청을 무시한다", async () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /if \(togglePendingRef\.current\) return;/);
  assert.match(source, /disabled=\{actions\.switchDisabled \|\| togglePending\}/);

  let renderer;
  await act(async () => { renderer = create(React.createElement(JobSide, {
    jobs: [
      { name: "line-a", statusKnown: true, configState: "installed", executionState: "stopped", controllerState: "STOPPED" },
      { name: "line-b", statusKnown: true, configState: "installed", executionState: "running", controllerState: "RUNNING" },
    ],
    selected: "line-a", togglePending: true,
    onSelect() {}, onNew() {}, onRefresh() {}, onToggle() {},
  })); });
  assert.equal(button(renderer.root, "line-a Start").props.disabled, true);
  assert.equal(button(renderer.root, "line-b Stop").props.disabled, true);
  await act(async () => { renderer.unmount(); });
});

test("새 Job의 Database Mapping은 빈 직접 입력 콤보박스로 시작한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const DEFAULT_CONFIG = createDefaultJobConfig\(null, ""\);/);
  assert.match(source, /className="neo-combobox"/);
  assert.match(source, /const columnSelectionDisabled = !activeDatabase\.server \|\| !activeDatabase\.table \|\| tableWillBeCreated;/);
  assert.match(source, /disabled=\{!databaseDraft\.server\}/);
  assert.match(source, /disabled=\{columnSelectionDisabled\}/);
  assert.doesNotMatch(source, /job-value-column-options|job-string-value-column-options/);
  assert.match(source, /function ColumnSelect\(/);
  assert.match(source, /<optgroup label=\{group\.label\}/);
  assert.match(source, /label: "Numeric", columns: numericColumns/);
  assert.match(source, /const dataColumns = columns\.filter\(\(column\) => !column\.primaryKey && !column\.basetime && !column\.metadata\);/);
  assert.match(source, /label: "String", columns: stringColumns/);
  assert.doesNotMatch(source, /label: "JSON", columns: jsonColumns/);
  assert.doesNotMatch(source, /function ColumnPicker\(/);
  assert.match(source, /label="Manage Database Servers"/);
  assert.match(source, /Toggle table list/);
  assert.match(source, /Table not found\. It will be created automatically when the job is saved\./);
  assert.match(source, /if \(!configForSave\.database\.server\) validation\.push\("Select a Database Server\."\);/);
  assert.match(source, /if \(!configForSave\.database\.table\) validation\.push\("Select or enter a Table\."\);/);
  assert.match(source, /if \(!configForSave\.database\.valueColumn\) validation\.push\("Select a Value Column\."\);/);
  assert.match(source, /const needsStringValueColumn = jobNeedsStringValueColumn\(config\.methodCalls, interfaceDetails\);/);
  assert.match(source, /const configForSave = tableWillBeCreated[\s\S]*valueColumn: "VALUE", stringValueColumn: needsStringValueColumn \? "STR_VALUE" : ""/);
  assert.match(source, /const payload = serializeJobConfig\(configForSave\);/);
  assert.match(source, /table: table\.toUpperCase\(\), valueColumn: "", stringValueColumn: ""/);
});

test("새 Job은 Interface 목록이 비어도 Database 기본값을 복사한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const server = \(servers \|\| \[\]\)\.find/);
  assert.match(source, /setConfig\(createDefaultJobConfig\(provider, server \|\| \{ name: databaseServer \}, createInitialMethodCalls\(provider\), intervalDefaultMs\)\)/);
  assert.match(source, /createDefaultJobConfig\(provider, server/);
});

test("Provider fixed Job 화면만 generic Method와 Interface 편집 control을 숨긴다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /const fixedNewJob = formMode === "fixed";/);
  assert.match(source, /function FixedProviderCallsEditor/);
  assert.match(source, /appendProductMethodCall/);
  assert.match(source, /fixedNewJob \? <FixedProviderCallsEditor/);
  assert.match(source, /: <MethodCallsEditor/);
  assert.match(source, /provider\?\.jobMode !== "fixed" \? <IconButton icon="account_tree" label="New DBus Interface"/);
  assert.match(source, /inputLabel as productInputLabel/);
  assert.match(source, /displayInputValue as productDisplayInputValue/);
  assert.match(source, /inputPrefix as productInputPrefix/);
  assert.match(source, /storeInputValue as productStoreInputValue/);
  assert.match(source, /className="neo-input-prefix"/);
  assert.match(source, /productStoreInputValue\(key, value\)/);
  assert.match(styles, /\.neo-fixed-calls__inputs[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.neo-device-string__popover \{[^}]*position: absolute;[^}]*width: 100%;/);
  assert.match(styles, /\.neo-device-string__picker-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(styles, /\.neo-device-string__choice-control \{[^}]*border: 1px solid var\(--neo-border\);/);
  assert.match(styles, /\.neo-device-string__choice-control:focus-within \{ outline: 2px solid var\(--neo-interactive-hover\); outline-offset: 0; \}/);
  assert.match(styles, /\.neo-device-string__choice-control > input:focus-visible \{ outline: 0; \}/);
  assert.match(styles, /\.neo-device-string__preview \{[^}]*width: 100%;/);
  assert.match(styles, /\.neo-fixed-tags \{[^}]*width: 100%;[^}]*margin: 24px 0 0;/);
  assert.doesNotMatch(styles, /\.neo-fixed-tags \{[^}]*margin-left:\s*-/);
  assert.match(styles, /\.neo-input-prefix:focus-within \{ outline: 2px solid var\(--neo-interactive-hover\); outline-offset: 0; \}/);
  assert.match(styles, /\.neo-input-prefix > input:focus-visible \{ outline: 0; \}/);
  const lsProduct = fs.readFileSync(new URL("../../products/ls/frontend/model.mjs", import.meta.url), "utf8");
  assert.match(lsProduct, /if \(key === 'datacount'\) return 'DataCount';/);
  assert.match(lsProduct, /key === 'devicestring' \|\| key === 'memoryaddress'/);
});

test("LS fixed 기존 Job 편집은 모든 Call의 기본 입력을 보정하고 전체 배열을 바꾼다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /methodCalls: current\.methodCalls\.map\(\(call\) => \{/);
  assert.match(source, /inputs: \{ \.\.\.defaults, \.\.\.\(call\.inputs \|\| \{\}\) \}/);
  assert.match(source, /methodCalls: typeof update === "function" \? update\(current\.methodCalls\) : update/);
});

test("Database Server 기본 Table은 목록 선택과 직접 입력을 함께 제공한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /neo-default-table-combobox/);
  assert.match(source, /placeholder="Select or enter a default table\.\.\."/);
  assert.match(source, /api\.db\.preview\.tables\(draft\)/);
  assert.match(source, /api\.db\.preview\.columns\(\{ \.\.\.draft, table \}\)/);
});

test("DB Server Column 선택은 연결 뒤에만 열리고 현재 Default Table의 Column을 읽는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const defaultColumnSelectionDisabled = !defaultTablesReady \|\| !defaultTableKnown;/);
  assert.match(source, /disabled=\{defaultColumnSelectionDisabled\}/);
  assert.match(source, /const selectedTable = String\(draft\.defaultTable \|\| ""\)\.toUpperCase\(\);/);
  assert.match(source, /if \(selectedTable && tables\.some\([\s\S]*await loadDefaultColumns\(selectedTable\);/);
});

test("새 Table 자동 생성 안내는 아이콘과 여백만 사용하고 배경을 만들지 않는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /className="neo-table-create-info" role="status"><Icon name="info" \/>Table not found/);
  assert.match(css, /\.neo-table-create-info \{ display: flex; margin: 8px 0 0; padding: 0;[^}]*background: transparent;/);
});

test("입력과 선택 컨트롤은 전용 표면색과 흐린 placeholder를 사용한다", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /--neo-input-surface: #353535;/);
  assert.match(css, /input:not\(\[type="checkbox"\]\), select, textarea \{[^}]*background: var\(--neo-input-surface\);/);
  assert.match(css, /input::placeholder, textarea::placeholder \{ color: var\(--neo-text-muted\); opacity: 1; \}/);
});

test("비활성 입력과 선택 컨트롤은 배경과 글자색으로 구분된다", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /input:disabled, select:disabled, textarea:disabled \{ color: var\(--neo-text-muted\); background: var\(--neo-surface\); cursor: not-allowed; \}/);
});

test("선택된 Job 행은 주요 버튼보다 어두운 전용 선택 색을 사용한다", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /--neo-selected-surface: #0053a0;/);
  assert.match(css, /\.neo-job-row\.is-selected \{ background: var\(--neo-selected-surface\); \}/);
});

test("폼 레이블의 빈 영역은 input 또는 select를 활성화하지 않는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /function Field\([^)]*\) \{ return <div className=\{`neo-field/);
  assert.doesNotMatch(source, /function Field\([^)]*\) \{ return <label className=\{`neo-field/);
});

test("Job 폼은 데이터베이스 연결 상태 문구를 노출하지 않고 오류를 영어로 표시한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /api\.db\.connect\(config\.database\.server/);
  assert.doesNotMatch(source, /Connection available\./);
  assert.match(source, /DB_SERVER_NOT_FOUND: "Database server was not found\."/);
  assert.match(source, /Request failed \(\$\{code\}\)\./);
});

test("Data Viewer는 OPC UA 원본의 전체 탐색·Raw·Chart 화면을 공통 구현으로 사용한다", () => {
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const viewer = fs.readFileSync(new URL("../src/data-viewer/DataViewerPage.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/data-viewer/opcua-data-viewer.css", import.meta.url), "utf8");
  assert.match(app, /import DataViewerPage from "\.\/data-viewer\/DataViewerPage"/);
  assert.match(app, /return <DataViewerPage job=\{name\} detail=\{loaded\.data\} \/>;/);
  assert.match(viewer, /data-viewer-tag-tabs/);
  assert.match(viewer, /ResultPagination/);
  assert.match(viewer, /TimeRangeModal/);
  assert.match(viewer, /TagEChart/);
  assert.match(viewer, /buildNeoWebTagAnalyzerMessage/);
  assert.match(styles, /\.data-viewer-layout/);
  assert.match(styles, /\.data-viewer-chart-stack/);
});

test("Data Viewer 제목은 DBus 전역 h2 여백의 영향을 받지 않는다", () => {
  const viewer = fs.readFileSync(new URL("../src/data-viewer/DataViewerPage.jsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../src/data-viewer/opcua-data-viewer.css", import.meta.url), "utf8");
  assert.match(viewer, /"page data-viewer-page"/);
  assert.match(styles, /\.data-viewer-page \.page-title \{\s*margin: 0;/);
});

test("Data Viewer는 DBus Grid 안에서 화면 높이를 넘지 않고 내부 영역만 스크롤한다", () => {
  const styles = fs.readFileSync(new URL("../src/data-viewer/opcua-data-viewer.css", import.meta.url), "utf8");
  assert.match(styles, /\.data-viewer-page \{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.data-viewer-tag-list \{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.data-viewer-raw-card \.table-card-body \{[^}]*overflow:\s*auto;/s);
});

test("Data Viewer Raw 열은 내부 Grid 객체와 설정되지 않은 String Value를 숨긴다", () => {
  const page = fs.readFileSync(new URL("../src/data-viewer/DataViewerPage.jsx", import.meta.url), "utf8");
  assert.match(page, /\.\.\.\(!stringValueColumn\s*\?\s*\[["']stringValue["']\]\s*:\s*\[\]\)/);
});

test("Data Viewer 페이지네이션 입력은 DBus 전역 input 너비에 덮이지 않는다", () => {
  const styles = fs.readFileSync(new URL("../src/data-viewer/opcua-data-viewer.css", import.meta.url), "utf8");
  assert.match(styles, /\.data-viewer-page \.pagination-input \{[^}]*width:\s*48px;/s);
  assert.match(styles, /\.data-viewer-page \.pagination-page-size-input \{[^}]*width:\s*64px;/s);
});

test("Data Viewer의 좁은 결과 패널은 Time Range 도구를 두 줄에 겹치지 않게 배치한다", () => {
  const styles = fs.readFileSync(new URL("../src/data-viewer/opcua-data-viewer.css", import.meta.url), "utf8");
  assert.match(styles, /\.data-viewer-results \{[^}]*container-type:\s*inline-size;/s);
  assert.match(styles, /@container\s*\(max-width:\s*560px\)\s*\{[\s\S]*?\.data-viewer-pinned-range \{[^}]*position:\s*static;/s);
  assert.match(styles, /@container\s*\(max-width:\s*560px\)\s*\{[\s\S]*?\.data-viewer-title-actions \{[^}]*width:\s*100%;[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(styles, /@container\s*\(max-width:\s*560px\)\s*\{[\s\S]*?\.data-viewer-segmented-item \{[^}]*min-width:\s*56px;/s);
});

test("Data Viewer는 배포 빌드에서도 React 전역 변수 없이 첫 화면을 그린다", async () => {
  const tables = api.db.tables;
  const original = { columns: tables.columns, tags: tables.tags, data: tables.data, stat: tables.stat, chart: tables.chart };
  Object.assign(tables, {
    columns: async () => ({ columns: [] }),
    tags: async () => ({ tags: [] }),
    data: async () => ({ rows: [], total: 0 }),
    stat: async () => ({ minTime: null, maxTime: null }),
    chart: async () => ({ query: "" }),
  });
  let renderer;
  const notify = () => {};
  try {
    await act(async () => {
      renderer = create(React.createElement(MemoryRouter, { initialEntries: ["/data/line-a"] }, React.createElement(DataViewerPage, {
        job: "line-a",
        detail: { config: { database: { server: "localhost", table: "TAG", valueColumn: "VALUE", stringValueColumn: "STR_VALUE" } } },
        notify,
      })));
    });
    assert.ok(renderer.toJSON());
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(tables, original);
  }
});

test("Data Viewer는 기본 notify에서도 Tag를 한 번만 불러온다", async () => {
  const tables = api.db.tables;
  const original = { columns: tables.columns, tags: tables.tags, data: tables.data, stat: tables.stat, chart: tables.chart };
  let tagCalls = 0;
  Object.assign(tables, {
    columns: async () => ({ columns: [] }),
    tags: async () => {
      tagCalls += 1;
      return { tags: [{ id: "1", name: "TAG1" }] };
    },
    data: async () => ({ rows: [], total: 0 }),
    stat: async () => ({ minTime: null, maxTime: null }),
    chart: async () => ({ query: "" }),
  });
  let renderer;
  try {
    await act(async () => {
      renderer = create(React.createElement(MemoryRouter, { initialEntries: ["/data/line-a"] }, React.createElement(DataViewerPage, {
        job: "line-a",
        detail: { config: { database: { server: "localhost", table: "TAG", valueColumn: "VALUE", stringValueColumn: "STR_VALUE" } } },
      })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    assert.match(JSON.stringify(renderer.toJSON()), /TAG1/);
    assert.match(JSON.stringify(renderer.toJSON()), /No data\. Check the time range\./);
    assert.equal(tagCalls, 1);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(tables, original);
  }
});

test("Data Viewer 요청은 Job Database mapping을 보존하면서 같은 Table의 Tag를 조회한다", () => {
  const adapter = fs.readFileSync(new URL("../src/data-viewer/dataViewerApi.js", import.meta.url), "utf8");
  assert.match(adapter, /api\.db\.tables\.tags\(\{ job, server, table \}\)/);
  assert.match(adapter, /api\.db\.tables\.stat/);
  assert.match(adapter, /api\.db\.tables\.chart/);
  assert.match(adapter, /\/web\/api\/query\?q=/);
  assert.match(adapter, /includeTotal: true/);
  assert.match(adapter, /cursorSide, cursorTime, cursorName, cursorOffset/);
});

test("네이티브 기본 출력에는 selector와 Value type 선택기를 표시하지 않는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const nativeScalar = draft\.interpretation !== "json"/);
  assert.match(source, /\{!nativeScalar \? <Field label="Selector \(JSON Pointer\)">/);
  assert.match(source, /\{!nativeScalar \? <Field label="Value type">/);
});

test("단일 Tag 규칙은 중복 안내 없이 삭제 비활성화로만 보인다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Selected value needs exactly one Tag\./);
  assert.match(source, /disabled=\{!isArray && tags\.length === 1\}/);
  assert.match(source, /<th>Name<\/th>\{numeric \? <th>Transform<\/th> : null\}<th \/>/);
  assert.match(source, /className=\{`neo-tag-list\$\{numeric \? " neo-tag-list--numeric" : ""\}`\}/);
});

test("문자열 출력을 JSON으로 해석하면 숫자 저장을 기본으로 제안한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /interpretation: "json", selector: "", valueType: "numeric"/);
  assert.match(source, /nextType === "array" \? \{ elementType: draft\.elementType \|\| "numeric" \}/);
  assert.match(source, /Array element type`} value=\{draft\.elementType \|\| "numeric"\}/);
});

test("Method Call은 drag handle에서만 끌 수 있고 Transform은 조합식으로 표시한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /<article className="neo-call" key=\{call\.id\} draggable onDragStart=/);
  assert.match(source, /if \(callDrag\.current !== index\) \{ event\.preventDefault\(\); return; \}/);
  assert.match(source, /onPointerDown=\{\(\) => \{ callDrag\.current = index; \}\}/);
  assert.match(source, /event\.dataTransfer\.types\.includes\("text\/plain"\)/);
  assert.match(source, /className="neo-tag-transform"/);
  assert.match(source, /transformOrder: reorder\(transformOrder, draggedTransform, transformIndex\)/);
  assert.match(source, /transformIndex === 0 \? <span>\)<\/span> : null/);
});

test("Test Call은 중복 Raw body 없이 호출 결과만 표시한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /<h3>Call result<\/h3>/);
  assert.doesNotMatch(source, /Raw body \(diagnostic only\)/);
  assert.doesNotMatch(source, /Tag preview/);
  assert.doesNotMatch(source, /suggestedTags/);
});

test("Method Call 편집기는 번호·이름 강조와 기존 Tag 열 없이 생성 모달을 사용한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<strong>\{index \+ 1\}\. \{call\.name\}<\/strong>/);
  assert.match(source, /Generate Tags/);
  assert.doesNotMatch(source, /<th>Source<\/th>/);
  assert.doesNotMatch(source, /<th>Order<\/th>/);
  assert.match(source, /setGeneratorOpen\(true\)/);
});

test("Method Call은 이름, Interface·Method, Parameter 순서로 배치한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /<Field label="Call Name" wide>/);
  assert.match(source, /<Field label="DBus Interface">[\s\S]*?<Field label="Method">[\s\S]*?\{\(method\?\.inputs \|\| \[\]\)\.map/);
});

test("Output Mapping은 Output 단위 목록과 단일 편집 모달로 나눈다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, />Add Output<\/button>/);
  assert.match(source, /function OutputMappingList\(/);
  assert.match(source, /function OutputMappingModal\(/);
  assert.match(source, /<th>Output<\/th><th>Format<\/th><th>Tags<\/th>/);
  assert.match(source, /selection \? `Edit Output/);
  assert.match(source, /icon="edit" label=\{`Edit \$\{label\}`\}/);
  assert.match(source, /className="neo-output-list__actions"/);
  assert.match(source, /className="neo-array-tag-actions"/);
  assert.match(source, /<Icon name="auto_awesome" \/>Generate from Array/);
});

test("Output Mapping은 Tag 이름을 요약하고, Tag 이름 수정 중 행을 다시 만들지 않는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /if \(selection\.valueType === "array"\) return `\$\{tags\[0\]\.name\} ~ \$\{tags\[tags\.length - 1\]\.name\}`;/);
  assert.match(source, /return tags\[0\]\.name;/);
  assert.match(source, /<tr key=\{tagIndex\}>/);
  assert.doesNotMatch(source, /<tr key=\{`\$\{tag\.name\}-\$\{tagIndex\}`\}>/);
  assert.match(source, /variant="tag-generator"/);
  assert.match(css, /\.neo-modal__dialog--tag-generator \{ width: min\(100%, 480px\); padding: 0;/);
  assert.match(css, /\.neo-modal__dialog--tag-generator \.neo-actions \{ margin-top: 16px; justify-content: flex-end; \}/);
});

test("행 선택은 상세 API를 부르지 않고 Edit만 상세를 읽는다", async () => {
  const alpha = interfaceValue("alpha");
  const calls = [];
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async (id) => {
    calls.push(id);
    return { interface: alpha, references: [] };
  };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  assert.deepEqual(calls, []);

  await act(async () => { renderer.root.findAll((node) => node.type === "button" && node.props["aria-pressed"] === false)[0].props.onClick(); });
  await flush();
  assert.deepEqual(calls, []);

  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  assert.deepEqual(calls, ["alpha"]);
  await act(async () => { renderer.unmount(); });
});

test("참조 결과가 바뀌면 사용자 Interface Edit는 다시 상세를 읽고 열린다", async () => {
  const alpha = interfaceValue("alpha");
  const calls = [];
  const details = [
    { interface: alpha, references: [{ name: "line-a", documentName: "line-a", calls: ["read-a"], methodIds: ["read-a"], invalidConfig: false }] },
    { interface: alpha, references: [] },
  ];
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async (id) => {
    calls.push(id);
    return details.shift();
  };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();

  assert.deepEqual(calls, []);
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  assert.deepEqual(calls, ["alpha"]);
  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "Edit DBus Interface").length);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /line-a/);
  await act(async () => { buttonText(renderer.root, "Cancel").props.onClick(); });
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  assert.deepEqual(calls, ["alpha", "alpha"]);
  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "Edit DBus Interface").length);

  await act(async () => { renderer.unmount(); });
});

test("참조 결과가 바뀌면 사용자 Interface Delete는 다시 상세를 읽고 열린다", async () => {
  const alpha = interfaceValue("alpha");
  const calls = [];
  const details = [
    { interface: alpha, references: [{ name: "line-a", documentName: "line-a", calls: ["read-a"], methodIds: ["read-a"], invalidConfig: false }] },
    { interface: alpha, references: [] },
  ];
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async (id) => { calls.push(id); return details.shift(); };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Delete DBus Interface").props.onClick(); });
  await flush();
  assert.deepEqual(calls, ["alpha"]);
  assert.notEqual(button(renderer.root, "Delete DBus Interface").props.disabled, true);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /line-a/);

  await act(async () => { button(renderer.root, "Delete DBus Interface").props.onClick(); });
  await flush();
  assert.deepEqual(calls, ["alpha", "alpha"]);
  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "Delete DBus Interface").length);
  await act(async () => { renderer.unmount(); });
});

test("Built-in Edit는 읽기 전용 상세를 열고 Delete는 비활성이다", async () => {
  const builtIn = interfaceValue("ls-plc", {
    builtIn: true,
    methods: [{ id: "get-device-data", member: "GetDeviceData", source: "manual", inputs: [], outputs: [] }],
  });
  const calls = [];
  api.interfaces.list = async () => [builtIn];
  api.interfaces.get = async (id) => {
    calls.push(id);
    return { interface: builtIn, references: [] };
  };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();

  const edit = button(renderer.root, "Edit DBus Interface");
  assert.notEqual(edit.props.disabled, true);
  const remove = button(renderer.root, "Delete DBus Interface");
  assert.equal(remove.props.disabled, true);
  await act(async () => { edit.props.onClick(); });
  await flush();

  assert.deepEqual(calls, ["ls-plc"]);
  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "View DBus Interface").length);
  assert.ok(renderer.root.findAll((node) => node.type === "input").every((node) => node.props.disabled));
  assert.ok(renderer.root.findAll((node) => node.type === "select").every((node) => node.props.disabled));
  for (const label of ["Discover", "Save Interface"]) {
    const mutationButton = buttonText(renderer.root, label);
    assert.ok(mutationButton, `${label} control이 있어야 합니다.`);
    assert.equal(mutationButton.props.disabled, true, `${label}는 비활성이어야 합니다.`);
  }
  assert.ok(buttonText(renderer.root, "Methods (1)"));
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });
  assert.equal(renderer.root.findAll((node) => ["Edit Method", "Delete Method", "Add Method"].includes(node.props["aria-label"]) || node.children?.join("") === "Add Method").length, 0);
  await act(async () => { renderer.unmount(); });
});

test("참조 중인 Built-in도 Edit로 읽기 전용 상세를 연다", async () => {
  const builtIn = interfaceValue("ls-plc", { builtIn: true });
  api.interfaces.list = async () => [builtIn];
  api.interfaces.get = async () => ({ interface: builtIn, references: [{ name: "line-a" }] });

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();

  const edit = button(renderer.root, "Edit DBus Interface");
  assert.notEqual(edit.props.disabled, true);
  assert.equal(edit.props.title, "View DBus Interface");
  await act(async () => { edit.props.onClick(); });
  await flush();

  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "View DBus Interface").length);
  assert.ok(renderer.root.findAll((node) => node.type === "input").every((node) => node.props.disabled));
  assert.ok(renderer.root.findAll((node) => node.type === "select").every((node) => node.props.disabled));
  await act(async () => { renderer.unmount(); });
});

test("Built-in View는 Method 전체와 참조 Job을 읽기 전용으로 보여 준다", async () => {
  const builtIn = interfaceValue("ls-plc", {
    builtIn: true,
    methodCount: 1,
    methods: [{
      id: "get-device-data",
      member: "GetDeviceData",
      source: "discovered",
      inputs: [{ name: "dataCount", type: "uint16", required: true, validation: { minimum: 1, maximum: 64 } }, { name: "optional", type: "string", required: false }, { name: "defaultRequired", type: "string" }],
      outputs: [{ name: "result", type: "string", required: false, validation: { pattern: "^OK" } }],
    }],
  });
  api.interfaces.list = async () => [builtIn];
  api.interfaces.get = async () => ({
    interface: builtIn,
    references: [
      { name: "line-a", documentName: "line-a", calls: ["read-a"], methodIds: ["get-device-data"], invalidConfig: false },
      { name: "broken-job", documentName: null, calls: [], methodIds: [], invalidConfig: true },
    ],
  });

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });

  const text = renderer.toJSON();
  const smallText = renderer.root.findAll((node) => node.type === "small").map((node) => node.children.join(""));
  const badges = renderer.root.findAll((node) => node.props.className?.includes("neo-dbus-method-badge")).map((node) => node.children.join(""));
  assert.match(JSON.stringify(text), /GetDeviceData/);
  assert.doesNotMatch(JSON.stringify(text), /get-device-data/);
  assert.ok(badges.includes("Discovered"));
  assert.equal(renderer.root.findAll((node) => node.props.className === "neo-dbus-method-card__title").length, 1);
  assert.match(JSON.stringify(text), /dataCount/);
  assert.match(JSON.stringify(text), /uint16/);
  assert.equal(badges.filter((value) => value === "Required").length, 2);
  assert.match(JSON.stringify(text), /optional/);
  assert.equal(badges.filter((value) => value === "Optional").length, 2);
  assert.match(JSON.stringify(text), /defaultRequired/);
  assert.match(JSON.stringify(text), /minimum: 1/);
  assert.match(JSON.stringify(text), /maximum: 64/);
  assert.match(JSON.stringify(text), /result/);
  assert.match(JSON.stringify(text), /string/);
  assert.match(JSON.stringify(text), /pattern: \^OK/);
  assert.ok(renderer.root.findAll((node) => node.type === "input").every((node) => node.props.disabled));
  assert.ok(renderer.root.findAll((node) => node.type === "select").every((node) => node.props.disabled));
  await act(async () => { renderer.unmount(); });
});

test("LS 원본의 required 생략 입출력은 읽기 전용 상세에서 Required로 보인다", async () => {
  const asset = JSON.parse(fs.readFileSync(new URL("../../products/ls/interfaces/ls-plc-device.json", import.meta.url), "utf8"));
  const builtIn = interfaceValue(asset.id, { ...asset, methodCount: asset.methods.length });
  api.interfaces.list = async () => [builtIn];
  api.interfaces.get = async () => ({ interface: builtIn, references: [] });

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  await act(async () => { buttonText(renderer.root, `Methods (${asset.methods.length})`).props.onClick(); });

  const badges = renderer.root.findAll((node) => node.props.className?.includes("neo-dbus-method-badge")).map((node) => node.children.join(""));
  assert.equal(asset.methods[0].inputs.every((input) => input.required === undefined), true);
  assert.equal(asset.methods[0].outputs.every((output) => output.required === undefined), true);
  assert.equal(badges.filter((text) => text === "Required").length, asset.methods[0].inputs.length + asset.methods[0].outputs.length);
  assert.equal(badges.includes("Optional"), false);
  await act(async () => { renderer.unmount(); });
});

test("Discover는 선택 목록에 장비 Interface를 먼저 보이고 표준 표기를 붙인다", async () => {
  api.interfaces.discover = async () => [
    interfaceValue("standard", { interface: "org.freedesktop.DBus" }),
    interfaceValue("device", { interface: "com.ls.Device" }),
  ];
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: false, onSaved: async () => {}, onCancel: () => {} })); });
  const inputs = renderer.root.findAll((node) => node.type === "input");
  await act(async () => {
    inputs[1].props.onChange({ target: { value: "com.ls.Device" } });
    inputs[2].props.onChange({ target: { value: "/device" } });
    buttonText(renderer.root, "Discover").props.onClick();
  });
  await flush();
  const select = renderer.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "Discovered Interface")[0];
  assert.deepEqual(select.findAll((node) => node.type === "option").map((node) => node.children.join("")), ["Select discovered Interface", "com.ls.Device", "org.freedesktop.DBus (Standard)", "Direct input"]);
  assert.equal(select.findAll((node) => node.type === "option").at(-1).props.value, "__manual__");
  await act(async () => { renderer.unmount(); });
});

test("Discover 선택은 Method를 단일 Save Interface 폼에 반영하고 Save All 또는 카드 저장을 제공하지 않는다", async () => {
  const alpha = interfaceValue("alpha", { methods: [{
    id: "read-device",
    source: "discovered",
    member: "ReadDevice",
    inputs: [{ name: "address", type: "uint32" }],
    outputs: [{ name: "value", type: "string" }],
  }] });
  const beta = interfaceValue("beta");
  const created = [];
  api.interfaces.discover = async () => [beta, alpha];
  api.interfaces.create = async (value) => { created.push(value); return value; };

  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: false, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { renderer.root.findAll((node) => node.type === "input")[0].props.onChange({ target: { value: "line-alpha" } }); });
  await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); });
  await flush();

  const select = renderer.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "Discovered Interface")[0];
  assert.equal(select.props.value, "alpha");
  assert.equal(renderer.root.findAll((node) => node.type === "button" && node.children.join("") === "Save All").length, 0);
  assert.equal(renderer.root.findAll((node) => node.type === "section" && node.props.className === "neo-dbus-interface-discovery__interface").length, 0);

  await act(async () => { select.props.onChange({ target: { value: alpha.id } }); });
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });
  assert.ok(renderer.root.findAll((node) => node.type === "input" && node.props.value === "line-alpha").length > 0);
  assert.ok(renderer.root.findAll((node) => node.type === "strong" && node.children.join("") === "ReadDevice").length > 0);
  assert.equal(renderer.root.findAll((node) => node.props?.role === "status" && node.children.join("").includes("저장할 Interface에 반영")).length, 0);
  await act(async () => { buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();

  const { id: ignoredId, ...expectedCreate } = alpha;
  assert.deepEqual(created, [{ ...expectedCreate, name: "line-alpha", origin: "discovered" }]);
  await act(async () => { renderer.unmount(); });
});

test("Discover를 다시 실행해도 사용자가 고른 Interface는 유지한다", async () => {
  const alpha = interfaceValue("alpha");
  const beta = interfaceValue("beta");
  api.interfaces.discover = async () => [alpha, beta];
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: false, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); });
  await flush();
  const select = renderer.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "Discovered Interface")[0];
  await act(async () => { select.props.onChange({ target: { value: "beta" } }); });
  await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); });
  await flush();
  assert.equal(renderer.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "Discovered Interface")[0].props.value, "beta");
  await act(async () => { renderer.unmount(); });
});

test("Edit discovered Interface는 열릴 때 Discover하고 기존 Interface를 선택한다", async () => {
  const current = interfaceValue("device", { origin: "discovered", methods: [] });
  const discovered = interfaceValue("device", { origin: "discovered", methods: [{ id: "read", member: "Read", source: "discovered", inputs: [], outputs: [] }] });
  api.interfaces.discover = async () => [interfaceValue("other"), discovered];
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, initialValue: current, onSaved: async () => {}, onCancel: () => {} })); });
  await flush();
  const select = renderer.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "Discovered Interface")[0];
  assert.equal(select.props.value, "device");
  assert.ok(buttonText(renderer.root, "Methods (1)"));
  await act(async () => { renderer.unmount(); });
});

test("기존 Interface 다시 Discover 선택은 단일 발견 병합 PUT으로 저장한다", async () => {
  const current = interfaceValue("alpha", { methods: [{ id: "manual", source: "manual", member: "Manual", inputs: [], outputs: [] }] });
  const discovered = interfaceValue("alpha", { methods: [{ id: "read", source: "discovered", member: "Read", inputs: [], outputs: [] }] });
  const calls = [];
  api.interfaces.discover = async () => [discovered];
  api.interfaces.update = async () => { throw new Error("일반 수정 API를 쓰면 안 됩니다."); };
  api.interfaces.updateDiscovered = async (value) => { calls.push(value); return value; };

  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, initialValue: current, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); });
  await flush();
  const select = renderer.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "Discovered Interface")[0];
  await act(async () => { select.props.onChange({ target: { value: "alpha" } }); });
  await act(async () => { buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();
  assert.deepEqual(calls, [{ ...discovered, origin: "discovered" }]);
  await act(async () => { renderer.unmount(); });
});

test("선택하지 않은 사용자 Interface의 Edit와 Delete는 한 번 클릭으로 상세 뒤 작업을 연다", async () => {
  const alpha = interfaceValue("alpha");
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async () => ({ interface: alpha, references: [] });

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "Edit DBus Interface").length);

  await act(async () => { renderer.unmount(); });
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Delete DBus Interface").props.onClick(); });
  await flush();
  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "Delete DBus Interface").length);
  await act(async () => { renderer.unmount(); });
});

test("목록 조회 중 Discover를 눌러도 DBus Interface API 요청은 겹치지 않는다", async () => {
  const listGate = deferred();
  const discoverGate = deferred();
  const device = interfaceValue("device");
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const tracked = async (name, operation) => {
    calls.push(name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try { return await operation(); } finally { active -= 1; }
  };
  api.interfaces.list = async () => tracked("list", () => listGate.promise);
  api.interfaces.discover = async () => tracked("discover", () => discoverGate.promise);
  api.interfaces.create = async () => tracked("create", async () => device);
  api.interfaces.get = async () => tracked("get", async () => ({ interface: device, references: [] }));

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await act(async () => { buttonText(renderer.root, "Add Interface").props.onClick(); });
  const inputs = renderer.root.findAll((node) => node.type === "input");
  await act(async () => {
    inputs[1].props.onChange({ target: { value: "com.example.Device" } });
    inputs[2].props.onChange({ target: { value: "/device" } });
    buttonText(renderer.root, "Discover").props.onClick();
  });
  await flush();
  await act(async () => { listGate.resolve([]); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { discoverGate.resolve([device]); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { buttonText(renderer.root, "Save Interface").props.onClick(); await new Promise((resolve) => setTimeout(resolve, 10)); });

  assert.equal(maximumActive, 1);
  assert.deepEqual(calls, ["list", "discover", "create", "list"]);
  await act(async () => { renderer.unmount(); });
});

test("모달 unmount는 진행 중인 Interface 상세 GET을 abort한다", async () => {
  const alpha = interfaceValue("alpha");
  let detailSignal;
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async (_id, options = {}) => {
    detailSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  assert.ok(detailSignal);
  await act(async () => { renderer.unmount(); });
  assert.equal(detailSignal.aborted, true);
});

test("모달 Close는 진행 중인 Interface 상세 GET을 abort한다", async () => {
  const alpha = interfaceValue("alpha");
  let detailSignal;
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async (_id, options = {}) => {
    detailSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
  };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  assert.ok(detailSignal);
  await act(async () => { buttonText(renderer.root, "Close").props.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(detailSignal.aborted, true);
  await act(async () => { renderer.unmount(); });
});

test("Interface 입력 모달을 닫는 모든 방법은 활성 요청을 abort하고 대기 요청을 시작하지 않는다", async () => {
  const originalWindow = globalThis.window;
  const keydownListeners = new Set();
  globalThis.window = {
    addEventListener(type, listener) { if (type === "keydown") keydownListeners.add(listener); },
    removeEventListener(type, listener) { if (type === "keydown") keydownListeners.delete(listener); },
  };
  const closeCases = [
    ["Cancel", (root) => buttonText(root, "Cancel").props.onClick()],
    ["Close", (root) => button(root, "Close").props.onClick()],
    ["backdrop", (root) => { const backdrop = root.findAll((node) => node.type === "div" && node.props.className === "neo-modal")[0]; backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop }); }],
    ["Escape", () => { for (const listener of keydownListeners) listener({ key: "Escape" }); }],
  ];

  try {
    for (const [label, closeForm] of closeCases) {
      const activeGate = deferred();
      const signals = [];
      let createCalls = 0;
      api.interfaces.list = async () => [];
      api.interfaces.discover = async () => [interfaceValue("device")];
      api.interfaces.create = async (_value, options = {}) => {
        createCalls += 1;
        signals.push(options.signal);
        return activeGate.promise;
      };

      let renderer;
      await act(async () => { renderer = renderModal(); });
      await flush();
      await act(async () => { buttonText(renderer.root, "Add Interface").props.onClick(); });
      await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); });
      await flush();
      await act(async () => { renderer.root.findAll((node) => node.type === "select" && node.props["aria-label"] === "Discovered Interface")[0].props.onChange({ target: { value: "__manual__" } }); });
      const inputs = renderer.root.findAll((node) => node.type === "input");
      await act(async () => {
        inputs[0].props.onChange({ target: { value: "cancel-test" } });
        inputs[1].props.onChange({ target: { value: "com.example.Device" } });
        inputs[2].props.onChange({ target: { value: "/device" } });
        inputs[3].props.onChange({ target: { value: "com.example.Device" } });
      });
      await act(async () => {
        buttonText(renderer.root, "Save Interface").props.onClick();
        buttonText(renderer.root, "Save Interface").props.onClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(createCalls, 1, `${label}: 첫 요청만 시작해야 합니다.`);
      assert.equal(signals[0].aborted, false, `${label}: 닫기 전 요청은 활성 상태여야 합니다.`);

      await act(async () => { closeForm(renderer.root); });
      assert.equal(signals[0].aborted, true, `${label}: 활성 요청을 abort해야 합니다.`);
      activeGate.resolve({ id: "cancel-test" });
      await flush();
      assert.equal(createCalls, 1, `${label}: 대기 요청은 시작하지 않아야 합니다.`);
      assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "DBus Interfaces").length, `${label}: 목록으로 돌아가야 합니다.`);
      await act(async () => { renderer.unmount(); });
    }
  } finally {
    globalThis.window = originalWindow;
  }
});

test("저장 뒤 캐시를 버리고 목록으로 돌아가며 새 상세를 읽지 않는다", async () => {
  const alpha = interfaceValue("alpha");
  const calls = [];
  api.interfaces.list = async () => { calls.push("list"); return [alpha]; };
  api.interfaces.get = async () => {
    calls.push("get");
    return { interface: alpha, references: [] };
  };
  api.interfaces.update = async (value) => { calls.push("update"); return value; };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  calls.length = 0;
  await act(async () => { buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();

  assert.deepEqual(calls, ["update", "list"]);
  assert.ok(renderer.root.findAll((node) => node.type === "h2" && node.children.join("") === "DBus Interfaces").length);
  await act(async () => { renderer.unmount(); });
});

test("사용자 Interface 저장은 저장 Method 구조를 그대로 보낸다", async () => {
  const alpha = interfaceValue("alpha", {
    methods: [{ id: "read-a", member: "ReadA", source: "manual", inputs: [], outputs: [] }],
    methodCount: 1,
  });
  let saved;
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async () => ({ interface: alpha, references: [] });
  api.interfaces.update = async (value) => { saved = value; return value; };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  await act(async () => { buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();

  assert.deepEqual(saved.methods, alpha.methods);
  await act(async () => { renderer.unmount(); });
});

test("Interface 저장 버튼은 생성과 수정을 구분해 표시한다", async () => {
  let createRenderer;
  await act(async () => { createRenderer = create(React.createElement(DbusInterfaceFormModal, { editing: false, initialValue: interfaceValue("new"), onSaved: async () => {}, onCancel: () => {} })); });
  assert.ok(buttonText(createRenderer.root, "Create Interface"));
  await act(async () => { createRenderer.unmount(); });

  let updateRenderer;
  await act(async () => { updateRenderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, initialValue: interfaceValue("existing"), onSaved: async () => {}, onCancel: () => {} })); });
  assert.ok(buttonText(updateRenderer.root, "Update Interface"));
  await act(async () => { updateRenderer.unmount(); });
});

test("Method 수정 저장은 validation을 보존한다", async () => {
  const alpha = interfaceValue("alpha", {
    methods: [{
      id: "read-a",
      member: "ReadA",
      source: "manual",
      inputs: [{ name: "count", type: "uint16", required: true, validation: { minimum: 1, maximum: 64 } }],
      outputs: [{ name: "result", type: "string", required: false, validation: { pattern: "^OK" } }],
    }],
    methodCount: 1,
  });
  let saved;
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async () => ({ interface: alpha, references: [] });
  api.methods.update = async (_interfaceId, _methodId, value) => { saved = value; return value; };

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });
  await act(async () => { button(renderer.root, "Edit Method").props.onClick(); });
  await flush();
  await act(async () => { buttonText(renderer.root, "Save Method").props.onClick(); });
  await flush();

  assert.deepEqual(saved.inputs, alpha.methods[0].inputs);
  assert.deepEqual(saved.outputs, alpha.methods[0].outputs);
  await act(async () => { renderer.unmount(); });
});

test("참조 Job이 있으면 모든 Method control을 잠근다", async () => {
  const alpha = interfaceValue("alpha", { methods: [
    { id: "read-a", source: "manual", member: "ReadA", inputs: [], outputs: [] },
    { id: "read-b", source: "manual", member: "ReadB", inputs: [], outputs: [] },
  ], methodCount: 2 });
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async () => ({ interface: alpha, references: [{ name: "line-a", documentName: "line-a", calls: ["call-a"], methodIds: ["read-a"], invalidConfig: false }] });

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  await act(async () => { buttonText(renderer.root, "Methods (2)").props.onClick(); });
  const editButtons = renderer.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Edit Method");
  assert.deepEqual(editButtons, []);
  assert.equal(renderer.root.findAll((node) => node.props["aria-label"] === "Delete Method").length, 0);
  await act(async () => { renderer.unmount(); });
});

test("참조 Job이 한 Method만 써도 새 Method 추가를 막는다", async () => {
  const alpha = interfaceValue("alpha", { methods: [
    { id: "read-a", source: "manual", member: "ReadA", inputs: [], outputs: [] },
  ], methodCount: 1 });
  api.interfaces.list = async () => [alpha];
  api.interfaces.get = async () => ({ interface: alpha, references: [{ name: "line-a", documentName: "line-a", calls: ["call-a"], methodIds: ["read-a"], invalidConfig: false }] });

  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { button(renderer.root, "Edit DBus Interface").props.onClick(); });
  await flush();
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });

  assert.equal(renderer.root.findAll((node) => node.type === "input" && node.props.value === "").length, 0);
  assert.equal(buttonText(renderer.root, "Add Method"), undefined);
  await act(async () => { renderer.unmount(); });
});

test("Discover 뒤에만 선택 상자가 보이고 발견 Method는 읽기 전용 모달로 연다", async () => {
  const discovered = interfaceValue("device", {
    methods: [{ id: "read", member: "Read", source: "discovered", inputs: [], outputs: [] }],
    methodCount: 1,
  });
  api.interfaces.discover = async () => [discovered];
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DbusInterfaceFormModal, {
      editing: false,
      onSaved: async () => {},
      onCancel: () => {},
    }));
  });
  assert.equal(renderer.root.findAll((node) => node.props["aria-label"] === "Discovered Interface").length, 0);
  await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); });
  await flush();
  const select = renderer.root.findAll((node) => node.props["aria-label"] === "Discovered Interface")[0];
  assert.ok(select);
  await act(async () => { select.props.onChange({ target: { value: "device" } }); });
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });
  assert.equal(renderer.root.findAll((node) => node.props["aria-label"] === "DBus Methods").length, 1);
  assert.equal(renderer.root.findAll((node) => node.props["aria-label"] === "Edit Method").length, 0);
  await act(async () => { renderer.unmount(); });
});

test("Discover 저장은 discovered origin을 보내고 Method 수정 control을 만들지 않는다", async () => {
  const discovered = interfaceValue("device", { methods: [{ id: "read", member: "Read", source: "discovered", inputs: [], outputs: [] }] });
  const created = [];
  api.interfaces.discover = async () => [discovered];
  api.interfaces.create = async (value) => { created.push(value); return value; };
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: false, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { renderer.root.findAll((node) => node.type === "input")[0].props.onChange({ target: { value: "device line" } }); buttonText(renderer.root, "Discover").props.onClick(); });
  await flush();
  await act(async () => { renderer.root.findAll((node) => node.props["aria-label"] === "Discovered Interface")[0].props.onChange({ target: { value: "device" } }); });
  await act(async () => { buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();
  assert.equal(created[0].origin, "discovered");
  assert.equal(created[0].methods[0].source, "discovered");
  await act(async () => { renderer.unmount(); });
});

test("Direct input은 local manual Method를 Interface POST body에 넣는다", async () => {
  const created = [];
  api.interfaces.discover = async () => [interfaceValue("device")];
  api.interfaces.create = async (value) => { created.push(value); return value; };
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: false, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); });
  await flush();
  await act(async () => { renderer.root.findAll((node) => node.props["aria-label"] === "Discovered Interface")[0].props.onChange({ target: { value: "__manual__" } }); });
  const inputs = renderer.root.findAll((node) => node.type === "input");
  await act(async () => { inputs[0].props.onChange({ target: { value: "manual line" } }); });
  await act(async () => { renderer.root.findAll((node) => node.type === "input")[1].props.onChange({ target: { value: "manual.destination" } }); });
  await act(async () => { renderer.root.findAll((node) => node.type === "input")[2].props.onChange({ target: { value: "/manual" } }); });
  await act(async () => { renderer.root.findAll((node) => node.type === "input")[3].props.onChange({ target: { value: "com.example.Manual" } }); });
  await act(async () => { buttonText(renderer.root, "Methods (0)").props.onClick(); });
  const methodInputs = renderer.root.findAll((node) => node.type === "input" && node.props.value === "");
  await act(async () => { methodInputs[0].props.onChange({ target: { value: "read" } }); });
  await act(async () => { renderer.root.findAll((node) => node.type === "input" && node.props.value === "")[0].props.onChange({ target: { value: "Read" } }); });
  await act(async () => { buttonText(renderer.root, "Add Method").props.onClick(); });
  await act(async () => { button(renderer.root, "Close").props.onClick(); buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();
  assert.equal(created[0].origin, "manual");
  assert.deepEqual(created[0].methods.map((method) => ({ id: method.id, source: method.source })), [{ id: "read", source: "manual" }]);
  await act(async () => { renderer.unmount(); });
});

test("목록 행 선택은 아래 Methods 영역을 만들지 않는다", async () => {
  const alpha = interfaceValue("alpha", { methods: [{ id: "read", member: "Read", source: "manual", inputs: [], outputs: [] }] });
  api.interfaces.list = async () => [alpha];
  let renderer;
  await act(async () => { renderer = renderModal(); });
  await flush();
  await act(async () => { renderer.root.findAll((node) => node.props["aria-pressed"] === false)[0].props.onClick(); });
  assert.equal(renderer.root.findAll((node) => node.props.className === "neo-dbus-interface-detail").length, 0);
  assert.equal(renderer.root.findAll((node) => node.props["aria-label"] === "Edit Method").length, 0);
  await act(async () => { renderer.unmount(); });
});

test("저장된 discovered Interface는 origin/source를 유지하고 Method control을 숨긴다", async () => {
  const item = interfaceValue("found", { origin: "discovered", methods: [{ id: "read", member: "Read", source: "discovered", inputs: [], outputs: [] }] });
  let saved;
  api.interfaces.update = async (value) => { saved = value; return value; };
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, initialValue: item, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });
  assert.equal(renderer.root.findAll((node) => ["Edit Method", "Delete Method"].includes(node.props["aria-label"]) || node.children?.join("") === "Add Method").length, 0);
  await act(async () => { button(renderer.root, "Close").props.onClick(); buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();
  assert.equal(saved.origin, "discovered");
  assert.equal(saved.methods[0].source, "discovered");
  await act(async () => { renderer.unmount(); });
});

test("참조 Interface는 Name만 바꾸고 연결 필드와 Discover를 잠근다", async () => {
  const item = interfaceValue("manual", { methods: [{ id: "read", member: "Read", source: "manual", inputs: [], outputs: [] }] });
  let saved;
  api.interfaces.update = async (value) => { saved = value; return value; };
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, initialValue: item, references: [{ name: "job-a" }], onSaved: async () => {}, onCancel: () => {} })); });
  const inputs = renderer.root.findAll((node) => node.type === "input");
  assert.equal(inputs[0].props.disabled, false);
  assert.ok(inputs.slice(1).every((node) => node.props.disabled));
  assert.equal(buttonText(renderer.root, "Discover").props.disabled, true);
  await act(async () => { inputs[0].props.onChange({ target: { value: "renamed" } }); });
  await act(async () => { buttonText(renderer.root, "Save Interface").props.onClick(); });
  await flush();
  assert.equal(saved.name, "renamed");
  for (const key of ["id", "origin", "busType", "destination", "objectPath", "interface", "methods"]) assert.deepEqual(saved[key], item[key], `${key}는 참조 Interface 저장에서 보존되어야 합니다.`);
  await act(async () => { renderer.unmount(); });
});

test("참조가 없는 자동 발견 Interface는 연결 정보와 Discover를 수정할 수 있다", async () => {
  const item = interfaceValue("discovered", { origin: "discovered", methods: [{ id: "read", member: "Read", source: "discovered", inputs: [], outputs: [] }] });
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, initialValue: item, onSaved: async () => {}, onCancel: () => {} })); });
  const selects = renderer.root.findAll((node) => node.type === "select");
  const inputs = renderer.root.findAll((node) => node.type === "input");
  assert.equal(selects[0].props.disabled, false);
  assert.ok(inputs.every((node) => node.props.disabled === false));
  assert.equal(buttonText(renderer.root, "Discover").props.disabled, false);
  await act(async () => { renderer.unmount(); });
});

test("Method 모달 스크롤은 dialog가 아니라 본문에 적용한다", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /neo-modal__dialog--dbus-methods \{ display: grid; grid-template-rows: auto minmax\(0, 1fr\); max-height: min\(calc\(100vh - 80px\), calc\(var\(--neo-row-height\) \* 24\)\);/);
  assert.match(css, /neo-modal__dialog--dbus-methods \.neo-modal__body \{ min-height: 0; overflow-y: auto; scrollbar-width: thin;/);
  assert.match(css, /neo-modal__body::-webkit-scrollbar-thumb \{ border: 2px solid var\(--neo-elevated\);/);
  assert.match(css, /neo-dbus-method-list--scroll \{ min-height: 0; \}/);
  assert.doesNotMatch(css, /neo-dbus-method-list--scroll \{[^}]*overflow-y/);
});

test("Job 생성과 수정 폼은 계산된 Service Name 필드를 표시하지 않는다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<Field label="Service Name">/);
});

test("새 Job 이름은 목록 준비 뒤 한 번만 기본값을 적용하고 사용자 입력을 보존한다", () => {
  const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /nextDefaultJobName\(app\.jobs\)/);
  assert.match(source, /if \(editing \|\| app\.loading \|\| app\.error/);
  assert.match(source, /defaultNameApplied\.current/);
  assert.match(source, /nameEdited\.current/);
  assert.match(source, /nameEdited\.current = true; setJobConfigurationDraft\(\(current\) => \(\{ \.\.\.current, name: value\.toLowerCase\(\) \}\)\)/);
});

test("Job Configuration 모달은 Apply한 값을 summary에 반영하고 Edit 이름을 잠근다", async () => {
  const original = {
    settingsGet: api.settings.get,
    interfacesList: api.interfaces.list,
    jobsGet: api.jobs.get,
    jobsList: api.jobs.list,
    serversList: api.db.servers.list,
  };
  let listedJobs = [{ name: "job-1" }, { name: "job-2" }];
  Object.assign(api.settings, { get: async () => ({ provider: null, defaults: { database: { server: "local-db" } }, limits: {} }) });
  Object.assign(api.interfaces, { list: async () => [] });
  Object.assign(api.jobs, {
    list: async () => listedJobs,
    get: async (name) => ({ name, statusKnown: true, configState: "installed", executionState: "stopped", controllerState: "STOPPED", config: {} }),
  });
  Object.assign(api.db.servers, { list: async () => [{ name: "local-db" }] });
  let renderer;
  const jobNameInput = () => renderer.root.findAll((node) => node.type === "input" && node.props.maxLength === 100)[0];
  try {
    await act(async () => {
      renderer = create(React.createElement(MemoryRouter, { initialEntries: ["/jobs/legacy-job/edit"] }, React.createElement(AppProvider, { surface: "main" }, React.createElement(ConnectedSide), React.createElement(MainRoutes))));
    });
    await flush();
    assert.equal(jobNameInput(), undefined);
    await act(async () => { button(renderer.root, "Edit Job Configuration").props.onClick(); });
    assert.equal(jobNameInput().props.value, "legacy-job");
    assert.equal(jobNameInput().props.disabled, true);
    assert.equal(jobNameInput().props.readOnly, true);

    await act(async () => { button(renderer.root, "New Job").props.onClick(); });
    await flush();
    assert.equal(jobNameInput(), undefined);
    await act(async () => { button(renderer.root, "Edit Job Configuration").props.onClick(); });
    assert.equal(jobNameInput().props.value, "job-3");

    await act(async () => { jobNameInput().props.onChange({ target: { value: "custom-job" } }); });
    const intervalInput = renderer.root.findAll((node) => node.type === "input" && node.props["aria-label"] === "Run Interval (ms)")[0];
    const savePolicySelect = renderer.root.findAll((node) => node.type === "select" && node.props.value === "perMethod")[0];
    await act(async () => {
      intervalInput.props.onChange({ target: { value: "2500" } });
      savePolicySelect.props.onChange({ target: { value: "afterAllMethods" } });
    });
    await act(async () => { buttonText(renderer.root, "Apply").props.onClick(); });
    assert.equal(jobNameInput(), undefined);
    const summary = renderer.root.findAll((node) => node.props["aria-label"] === "Job Configuration summary")[0];
    assert.deepEqual(summary.findAll((node) => node.type === "strong").map((node) => node.children.join("")), ["custom-job", "2500 ms", "afterAllMethods"]);

    await act(async () => { button(renderer.root, "Edit Job Configuration").props.onClick(); });
    listedJobs = [...listedJobs, { name: "job-3" }];
    await act(async () => { button(renderer.root, "Refresh").props.onClick(); });
    await flush();
    assert.equal(jobNameInput().props.value, "custom-job");
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(api.settings, { get: original.settingsGet });
    Object.assign(api.interfaces, { list: original.interfacesList });
    Object.assign(api.jobs, { get: original.jobsGet, list: original.jobsList });
    Object.assign(api.db.servers, { list: original.serversList });
  }
});

test("Database의 빈 Server와 Table은 레이블 아래 대시로 표시한다", async () => {
  const original = {
    settingsGet: api.settings.get,
    interfacesList: api.interfaces.list,
    jobsList: api.jobs.list,
    serversList: api.db.servers.list,
  };
  Object.assign(api.settings, { get: async () => ({
    provider: null,
    defaults: { database: { server: "" } },
    limits: {},
  }) });
  Object.assign(api.interfaces, { list: async () => [] });
  Object.assign(api.jobs, { list: async () => [] });
  Object.assign(api.db.servers, { list: async () => [] });
  let renderer;
  try {
    await act(async () => {
      renderer = create(React.createElement(
        MemoryRouter,
        { initialEntries: ["/jobs/new"] },
        React.createElement(AppProvider, { surface: "main" }, React.createElement(MainRoutes)),
      ));
    });
    await flush();
    const summary = renderer.root.findAll((node) => node.props["aria-label"] === "Database summary")[0];
    assert.deepEqual(summary.findAll((node) => node.type === "strong").map((node) => node.children.join("")), ["—", "—"]);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(api.settings, { get: original.settingsGet });
    Object.assign(api.interfaces, { list: original.interfacesList });
    Object.assign(api.jobs, { list: original.jobsList });
    Object.assign(api.db.servers, { list: original.serversList });
  }
});

test("Edit Job의 Database는 요약에 저장된 Server와 Table을 표시한다", async () => {
  const original = {
    settingsGet: api.settings.get,
    interfacesList: api.interfaces.list,
    jobsGet: api.jobs.get,
    jobsList: api.jobs.list,
    serversList: api.db.servers.list,
    tablesList: api.db.tables.list,
  };
  Object.assign(api.settings, { get: async () => ({
    provider: null,
    defaults: { database: { server: "default-db" } },
    limits: {},
  }) });
  Object.assign(api.interfaces, { list: async () => [] });
  Object.assign(api.jobs, {
    list: async () => [{ name: "saved-job" }],
    get: async (name) => ({
      name,
      statusKnown: true,
      configState: "installed",
      executionState: "stopped",
      controllerState: "STOPPED",
      config: { database: { server: "saved-db", table: "SAVED_TABLE" } },
    }),
  });
  Object.assign(api.db.servers, { list: async () => [
    { name: "default-db", defaultTable: "DEFAULT_TABLE" },
    { name: "saved-db", defaultTable: "OTHER_TABLE" },
  ] });
  Object.assign(api.db.tables, { list: async () => [] });
  let renderer;
  try {
    await act(async () => {
      renderer = create(React.createElement(
        MemoryRouter,
        { initialEntries: ["/jobs/saved-job/edit"] },
        React.createElement(AppProvider, { surface: "main" }, React.createElement(MainRoutes)),
      ));
    });
    await flush();
    const summary = renderer.root.findAll((node) => node.props["aria-label"] === "Database summary")[0];
    assert.deepEqual(summary.findAll((node) => node.type === "strong").map((node) => node.children.join("")), ["saved-db", "SAVED_TABLE"]);
    assert.ok(button(renderer.root, "Edit Database"));
    assert.equal(renderer.root.findAll((node) => node.type === "input" && node.props.placeholder === "Select or enter a table...").length, 0);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(api.settings, { get: original.settingsGet });
    Object.assign(api.interfaces, { list: original.interfacesList });
    Object.assign(api.jobs, { get: original.jobsGet, list: original.jobsList });
    Object.assign(api.db.servers, { list: original.serversList });
    Object.assign(api.db.tables, { list: original.tablesList });
  }
});

test("Database 모달은 Apply한 Server와 Table만 요약에 반영한다", async () => {
  const original = {
    settingsGet: api.settings.get,
    interfacesList: api.interfaces.list,
    jobsList: api.jobs.list,
    serversList: api.db.servers.list,
    tablesList: api.db.tables.list,
  };
  Object.assign(api.settings, { get: async () => ({
    provider: null,
    defaults: { database: { server: "local-db" } },
    limits: {},
  }) });
  Object.assign(api.interfaces, { list: async () => [] });
  Object.assign(api.jobs, { list: async () => [] });
  Object.assign(api.db.servers, { list: async () => [
    { name: "local-db", defaultTable: "DEFAULT_DBUS" },
    { name: "backup-db", defaultTable: "" },
  ] });
  Object.assign(api.db.tables, { list: async () => [] });
  let renderer;
  const summaryValues = () => renderer.root
    .findAll((node) => node.props["aria-label"] === "Database summary")[0]
    .findAll((node) => node.type === "strong")
    .map((node) => node.children.join(""));
  try {
    await act(async () => {
      renderer = create(React.createElement(
        MemoryRouter,
        { initialEntries: ["/jobs/new"] },
        React.createElement(AppProvider, { surface: "main" }, React.createElement(MainRoutes)),
      ));
    });
    await flush();
    assert.deepEqual(summaryValues(), ["local-db", "DEFAULT_DBUS"]);
    const summary = renderer.root.findAll((node) => node.props["aria-label"] === "Database summary")[0];
    assert.equal(summary.findAll((node) => ["input", "select", "button", "a"].includes(node.type)).length, 0);

    await act(async () => { button(renderer.root, "Edit Database").props.onClick(); });
    const serverSelect = renderer.root.findAll((node) => node.type === "select" && node.props.value === "local-db")[0];
    const tableInput = renderer.root.findAll((node) => node.type === "input" && node.props.placeholder === "Select or enter a table...")[0];
    await act(async () => { serverSelect.props.onChange({ target: { value: "backup-db" } }); });
    await act(async () => { tableInput.props.onChange({ target: { value: "events" } }); });
    assert.deepEqual(summaryValues(), ["local-db", "DEFAULT_DBUS"]);
    await act(async () => { buttonText(renderer.root, "Apply").props.onClick(); });
    assert.deepEqual(summaryValues(), ["backup-db", "EVENTS"]);
    assert.equal(renderer.root.findAll((node) => node.type === "select" && node.props.value === "backup-db").length, 0);
    assert.equal(renderer.root.findAll((node) => node.type === "input" && node.props.placeholder === "Select or enter a table...").length, 0);

    await act(async () => { button(renderer.root, "Edit Database").props.onClick(); });
    const reopenedServer = renderer.root.findAll((node) => node.type === "select" && node.props.value === "backup-db")[0];
    await act(async () => { reopenedServer.props.onChange({ target: { value: "local-db" } }); });
    await act(async () => { buttonText(renderer.root, "Cancel").props.onClick(); });
    assert.deepEqual(summaryValues(), ["backup-db", "EVENTS"]);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(api.settings, { get: original.settingsGet });
    Object.assign(api.interfaces, { list: original.interfacesList });
    Object.assign(api.jobs, { list: original.jobsList });
    Object.assign(api.db.servers, { list: original.serversList });
    Object.assign(api.db.tables, { list: original.tablesList });
  }
});

test("Direct input Interface Field는 선택 상자의 바로 다음 Field다", async () => {
  api.interfaces.discover = async () => [interfaceValue("device")];
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: false, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { buttonText(renderer.root, "Discover").props.onClick(); }); await flush();
  await act(async () => { renderer.root.findAll((node) => node.props["aria-label"] === "Discovered Interface")[0].props.onChange({ target: { value: "__manual__" } }); });
  const fields = renderer.root.findAll((node) => node.props.className?.split(" ").includes("neo-field")).map((node) => node.findAll((child) => child.props.className === "neo-field__label")[0]?.children.join(""));
  assert.equal(fields.indexOf("Interface"), fields.indexOf("Discovered Interface") + 1);
  await act(async () => { renderer.unmount(); });
});

test("Built-in Method 모달은 모든 reference 필드를 보여 준다", async () => {
  const item = interfaceValue("builtin", { builtIn: true, methods: [{ id: "read", member: "Read", source: "discovered", inputs: [], outputs: [] }] });
  const references = [{ name: "line-a", documentName: null, calls: ["call-a"], methodIds: ["read"], invalidConfig: true }];
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, readOnly: true, initialValue: item, references, onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });
  const text = renderer.root.findAll((node) => typeof node.children?.[0] === "string").map((node) => node.children.join(" ")).join("\n").replaceAll(/\s+/g, " ");
  for (const value of ["line-a", "documentName: null", "calls: call-a", "invalidConfig: true"]) assert.ok(text.includes(value), value);
  assert.equal(text.includes("methodIds:"), false);
  await act(async () => { renderer.unmount(); });
});

test("Method 상세는 내부 ID를 숨기고 영어 상태 뱃지를 보여 준다", async () => {
  const item = interfaceValue("builtin", { builtIn: true, methods: [{
    id: "check-device-string-rule", member: "CheckDeviceStringRule", source: "discovered",
    inputs: [{ name: "DeviceString", type: "string" }],
    outputs: [{ name: "Return", type: "string", required: false }],
  }] });
  let renderer;
  await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, readOnly: true, initialValue: item, references: [], onSaved: async () => {}, onCancel: () => {} })); });
  await act(async () => { buttonText(renderer.root, "Methods (1)").props.onClick(); });
  const text = JSON.stringify(renderer.toJSON());
  assert.match(text, /Discovered/);
  assert.match(text, /Required/);
  assert.match(text, /Optional/);
  assert.doesNotMatch(text, /check-device-string-rule|required: omitted/);
  await act(async () => { renderer.unmount(); });
});

test("중첩 Method 모달 Escape는 자식만 닫고 부모 draft를 유지한다", async () => {
  const originalWindow = globalThis.window; const listeners = new Set();
  globalThis.window = { addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) };
  try {
    const item = interfaceValue("manual"); let cancelled = 0; let renderer;
    await act(async () => { renderer = create(React.createElement(DbusInterfaceFormModal, { editing: true, initialValue: item, onSaved: async () => {}, onCancel: () => { cancelled += 1; } })); });
    await act(async () => { renderer.root.findAll((node) => node.type === "input")[0].props.onChange({ target: { value: "kept name" } }); buttonText(renderer.root, "Methods (0)").props.onClick(); });
    await act(async () => { for (const listener of listeners) listener({ key: "Escape" }); });
    assert.equal(cancelled, 0);
    assert.equal(renderer.root.findAll((node) => node.props["aria-label"] === "DBus Methods").length, 0);
    assert.ok(renderer.root.findAll((node) => node.type === "input" && node.props.value === "kept name").length);
    await act(async () => { renderer.unmount(); });
  } finally { globalThis.window = originalWindow; }
});

test("LS Call 목록은 오른쪽 상세 높이를 넘을 때만 내부 스크롤한다", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.neo-fixed-calls__list-shell\s*\{[^}]*position:\s*relative;[^}]*align-self:\s*stretch;/);
  assert.match(css, /\.neo-fixed-calls__list\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*overflow-y:\s*auto;/);
  assert.doesNotMatch(css, /\.neo-fixed-calls__list\s*\{[^}]*max-height:\s*calc\(var\(--neo-row-height\)\s*\*\s*16\)/);
});

test("Time Range의 From과 To 입력은 짧은 라벨 뒤 남는 너비를 사용한다", () => {
  const css = fs.readFileSync(new URL("../src/data-viewer/opcua-data-viewer.css", import.meta.url), "utf8");
  assert.match(css, /\.data-viewer-time-field\s*\{[^}]*grid-template-columns:\s*calc\(var\(--spacing-32\)\s*\*\s*2\)\s+minmax\(0,\s*1fr\);/);
  assert.doesNotMatch(css, /var\(--spacing-64\)/);
});

test("Time Range 입력은 바깥 제어에만 테두리와 배경을 표시한다", () => {
  const css = fs.readFileSync(new URL("../src/data-viewer/opcua-data-viewer.css", import.meta.url), "utf8");
  assert.match(css, /\.data-viewer-time-field \.input-icon-wrap > input:not\(\[type="checkbox"\]\)\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(css, /\.data-viewer-time-field \.input-icon-wrap > input:focus-visible\s*\{[^}]*outline:\s*0;/s);
});

test("Job 상세와 Log API는 polling Live Logs의 공개 계약을 사용한다", () => {
  const sdd = fs.readFileSync(new URL("../../docs/specs/DBUS_SDD.md", import.meta.url), "utf8");
  const feDesign = fs.readFileSync(new URL("../../docs/specs/FE_DESIGN.md", import.meta.url), "utf8");
  const beDesign = fs.readFileSync(new URL("../../docs/specs/BE_DESIGN.md", import.meta.url), "utf8");
  assert.match(sdd, /CCR-070/);
  for (const document of [sdd, feDesign, beDesign]) {
    assert.match(document, /\/log\/content\?name=.*file=.*page=.*lines=/);
    assert.match(document, /\/log\/content\/all\?name=.*file=/);
    assert.match(document, /\/log\/tail\?name=.*file=/);
    assert.match(document, /\{name,file,page,linesPerPage,totalLines,lines,nextPage,previousPage\}/);
    assert.match(document, /\{name,file,size,content\}/);
    assert.match(document, /\{name,file,lines,totalLines\}/);
  }
  assert.match(sdd, /`GET \/log\/content` \| `name`, `file` \| `page`, `lines`/);
  assert.match(sdd, /`GET \/log\/tail` \| `name`, `file` \| `lines`/);
  assert.match(feDesign, /1초마다.*\/log\/tail/);
  assert.match(beDesign, /새 endpoint를 추가하지 않는다/);
});

await vite.close();
