# Database Collapsed Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New/Edit Job의 접힌 Database 섹션에서 현재 Database Server와 Table을 `server / table` 읽기 전용 요약으로 표시한다.

**Architecture:** 공통 `JobForm`의 기존 `databaseOpen` 상태와 `config.database` draft를 그대로 사용한다. 제목 행에 별도 저장 상태가 없는 Database summary를 추가하고, 기존 Job Configuration summary와 CSS 배치 규칙만 공유한다. Backend API, Job schema와 저장 payload는 변경하지 않는다.

**Tech Stack:** React 19, React Router, `react-test-renderer`, Node.js `assert`, CSS design tokens, Vite single-file build

## Global Constraints

- New/Edit Job의 Database는 route 진입 시 기본 접힘을 유지한다.
- 접힌 summary는 레이블 없이 `Database Server / Table` 순서의 값만 표시한다.
- 비어 있는 각 값은 `—`로 표시하며 둘 다 비어 있으면 `— / —`다.
- summary 안에는 input, select, link 또는 별도 동작 버튼을 넣지 않는다.
- 펼치면 기존 Database Server, Table, Value Column, String Value Column control과 Table 자동 생성 안내를 그대로 제공한다.
- summary는 별도 상태를 만들지 않고 현재 `config.database` draft를 직접 읽는다.
- API, Backend, Job schema, validation과 저장 payload를 변경하지 않는다.
- generic과 LS target은 같은 공통 구현을 사용한다.
- `DESIGN.md`에 없는 색상, 글꼴, 간격과 모서리 값을 추가하지 않는다.
- `frontend/neo-proxy.json`은 수정하거나 커밋하지 않는다.
- 커밋 직전 인자 없는 `npm run build`를 실행하고 Git 산출물은 generic이어야 한다.

---

### Task 1: Database 읽기 전용 summary와 동작 테스트

**Files:**
- Modify: `frontend/src/App.jsx:801-836`
- Modify: `frontend/src/styles.css:248-253,342-350`
- Test: `frontend/tests/app-contract.test.mjs:67-73`
- Test: `frontend/tests/app-contract.test.mjs:1146-1205`

**Interfaces:**
- Consumes: `databaseOpen: boolean`, `config.database.server: string`, `config.database.table: string`
- Produces: `aria-label="Database summary"`를 가진 읽기 전용 `<div>`와 `server / table` 텍스트

- [ ] **Step 1: source/style 계약 실패 테스트 작성**

`Database 영역은 공통 상태로 기본 접힘이고 펼침 뒤 기존 control을 표시한다` 테스트에 다음 assertion을 추가한다.

```js
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(source, /className="neo-database-summary" aria-label="Database summary"/);
assert.match(source, /config\.database\.server \|\| "—"/);
assert.match(source, /config\.database\.table \|\| "—"/);
assert.match(styles, /\.neo-job-configuration-summary, \.neo-database-summary/);
```

- [ ] **Step 2: 실제 렌더 상호작용 실패 테스트 작성**

`Job Configuration은 실제 입력 변경을 summary에 반영하고 Edit 이름을 잠근다` 테스트 다음에 독립 테스트를 추가한다. API 원본은 `finally`에서 모두 복원한다.

```js
test("Database의 빈 Server와 Table은 대시로 표시한다", async () => {
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
    assert.deepEqual(summary.findAll((node) => node.type === "span").map((node) => node.children.join("")), ["— / —"]);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(api.settings, { get: original.settingsGet });
    Object.assign(api.interfaces, { list: original.interfacesList });
    Object.assign(api.jobs, { list: original.jobsList });
    Object.assign(api.db.servers, { list: original.serversList });
  }
});

test("Database는 접힌 Server와 Table을 표시하고 현재 draft를 즉시 반영한다", async () => {
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
    .findAll((node) => node.type === "span")
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
    assert.deepEqual(summaryValues(), ["local-db / DEFAULT_DBUS"]);
    const summary = renderer.root.findAll((node) => node.props["aria-label"] === "Database summary")[0];
    assert.equal(summary.findAll((node) => ["input", "select", "button", "a"].includes(node.type)).length, 0);
    assert.equal(button(renderer.root, "Toggle Database").props["aria-expanded"], false);

    await act(async () => { button(renderer.root, "Toggle Database").props.onClick(); });
    const serverSelect = renderer.root.findAll((node) => node.type === "select" && node.props.value === "local-db")[0];
    const tableInput = renderer.root.findAll((node) => node.type === "input" && node.props.placeholder === "Select or enter a table...")[0];
    await act(async () => { serverSelect.props.onChange({ target: { value: "backup-db" } }); });
    await act(async () => { tableInput.props.onChange({ target: { value: "events" } }); });
    await act(async () => { button(renderer.root, "Toggle Database").props.onClick(); });
    assert.deepEqual(summaryValues(), ["backup-db / EVENTS"]);
  } finally {
    if (renderer) await act(async () => { renderer.unmount(); });
    Object.assign(api.settings, { get: original.settingsGet });
    Object.assign(api.interfaces, { list: original.interfacesList });
    Object.assign(api.jobs, { list: original.jobsList });
    Object.assign(api.db.servers, { list: original.serversList });
    Object.assign(api.db.tables, { list: original.tablesList });
  }
});
```

- [ ] **Step 3: 실패 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: `neo-database-summary` markup이 없어 새 source assertion 또는 렌더 summary 조회에서 FAIL.

- [ ] **Step 4: Database summary markup 구현**

`frontend/src/App.jsx`의 Database title row를 다음 구조로 바꾼다.

```jsx
<div className="neo-panel__title">
  <h2>DATABASE</h2>
  <div className="neo-database-summary" aria-label="Database summary">
    <span>{`${config.database.server || "—"} / ${config.database.table || "—"}`}</span>
  </div>
  <IconButton
    icon={databaseOpen ? "expand_less" : "expand_more"}
    label="Toggle Database"
    aria-expanded={databaseOpen}
    onClick={() => setDatabaseOpen((open) => !open)}
  />
</div>
```

summary는 `databaseOpen` 여부와 관계없이 제목 행에 남아 현재 draft를 표시한다. 기존 `databaseOpen ? <>...</> : null` 내부는 수정하지 않는다.

- [ ] **Step 5: 기존 DESIGN token을 공유하도록 CSS 수정**

`frontend/src/styles.css`의 기존 Job Configuration summary selector를 다음과 같이 확장한다.

```css
.neo-job-configuration-summary, .neo-database-summary { display: flex; min-width: 0; margin-left: auto; align-items: center; gap: 16px; color: var(--neo-text-secondary); font-size: 12px; }
.neo-job-configuration-summary span, .neo-database-summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

640px media query도 두 summary가 같은 줄바꿈 규칙을 쓰게 한다.

```css
.neo-job-configuration-summary, .neo-database-summary { flex-wrap: wrap; }
```

- [ ] **Step 6: 집중 GREEN 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: App contract 전체 PASS. 새 렌더 테스트가 초기 `local-db / DEFAULT_DBUS`, control 0개, 변경 후 `backup-db / EVENTS`를 확인한다.

- [ ] **Step 7: Frontend 전체 회귀 확인**

Run: `npm --prefix frontend test`

Expected: App, model, Database provisioning, Data Viewer와 build contract 전체 PASS. sandbox의 Vite WebSocket `EPERM`과 `react-test-renderer` deprecation 로그는 exit code가 0이면 기존 경고다.

- [ ] **Step 8: Task 1 커밋**

```bash
npm run build
git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/app-contract.test.mjs index.html main.html side.html
git commit -m "feat: summarize collapsed database settings"
```

---

### Task 2: generic/LS 제품 경계와 최종 산출물 검증

**Files:**
- Verify: `products/generic/frontend/index.jsx`
- Verify: `products/ls/frontend/index.jsx`
- Verify: `cgi-bin/product/index.js`
- Verify: `index.html`
- Verify: `main.html`
- Verify: `side.html` build 완료 여부 (JobForm summary 문자열 검사는 제외)

**Interfaces:**
- Consumes: 공통 `JobForm` Database summary와 제품 build script
- Produces: generic/LS의 JobForm 화면(`index.html`, `main.html`) 검증 결과와 최종 generic Git 산출물

`index.html`은 `CombinedApp`으로 `MainRoutes`를 포함하고, `main.html`은 `MainApp`으로 `MainRoutes`를 렌더한다. `JobForm`의 `/jobs/new`, `/jobs/:name/edit` route는 `MainRoutes`에만 있다. 반면 `side.html`은 `SideApp`으로 `ConnectedSide`만 렌더하므로 JobForm과 `Database summary` 문자열을 포함하지 않는 것이 정상이다. 세 entry는 모두 build 성공을 확인하되, summary 문자열 검사는 JobForm surface인 index/main에만 적용한다.

- [ ] **Step 1: Backend·Frontend·제품 전체 테스트 실행**

Run: `node --test cgi-bin/tests/*.test.cjs && npm --prefix frontend test && npm run test:products`

Expected: 모든 명령 exit 0. Backend 계약, Frontend 렌더, generic 자유 Job과 LS fixed Job 제품 테스트가 모두 PASS.

- [ ] **Step 2: LS build에서 공통 summary 포함 확인**

Run: `npm run build -- --target=ls`

Expected: build 성공, `cgi-bin/product/index.js`의 `target`이 `ls`, `cgi-bin/provider.json.id`가 `ls`, JobForm surface인 `index.html`과 `main.html`에 `Database summary` 문자열이 포함된다. `side.html`은 build되지만 JobForm 미포함이 정상이다.

- [ ] **Step 3: 최종 generic build로 복구**

Run: `npm run build`

Expected: build 성공, `cgi-bin/product/index.js`의 `target`이 `generic`, `cgi-bin/provider.json`이 없고 `cgi-bin/interfaces.d`가 비어 있으며 JobForm surface인 `index.html`과 `main.html`에 `Database summary` 문자열이 포함된다. `side.html`은 build되지만 JobForm 미포함이 정상이다.

- [ ] **Step 4: 최종 diff와 사용자 파일 보존 확인**

Run: `git diff --check && git status --short`

Expected: 구현 및 generic HTML 변경만 추적 대상이며 `frontend/neo-proxy.json`은 별도 unstaged 사용자 변경으로 남는다. Provider 전용 생성 파일은 없다.
