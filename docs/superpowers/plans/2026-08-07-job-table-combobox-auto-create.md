# Job Table Combobox and Auto-create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job Database Mapping에서 서버를 관리하고, TAG Table을 직접 입력 또는 목록에서 선택하며, 없는 Table은 Job 저장 시 자동 생성한다.

**Architecture:** JobManager가 Job mutation lock 안에서 DB Table 존재를 확인한다. 없으면 설정의 value/string column으로 TAG Table을 만들고 다시 metadata 검증한 뒤에만 Job config와 Controller service를 저장한다. 화면은 기존 Database Server 관리 모달을 재사용하고, Table/Column 후보는 발견 목록과 직접 입력을 한 콤보 입력으로 제공한다.

**Tech Stack:** React 19, Vite, Node/JSH CGI, Machbase Neo TAG Table API, node:test.

## Global Constraints

- 새 Table은 `valueColumn`이 반드시 필요하고 숫자 `DOUBLE SUMMARIZED` column으로 생성한다.
- `stringValueColumn`은 선택이며, 입력 시 `VARCHAR(1024)` column으로 생성한다.
- 생성 실패 시 Job config와 Controller service를 만들거나 갱신하지 않는다.
- 기존 Table은 생성하지 않고 기존 TAG metadata·column 검증을 그대로 적용한다.
- DB server password는 Job 요청·설정·오류에 포함하지 않는다.
- UI는 `DESIGN.md`의 32px control, 4px 모서리, 16px grid gap만 사용한다.
- 계약 변경은 CCR에 승인 상태와 근거를 함께 남긴다.

---

### Task 1: Backend table provisioning

**Files:**
- Modify: `cgi-bin/src/db/validation-adapter.js`
- Modify: `cgi-bin/src/jobs/manager.js`
- Test: `cgi-bin/tests/job-manager.test.cjs`

**Interfaces:**
- Consumes: `databaseAdapter.validate(database, callback)`.
- Produces: `databaseAdapter.ensure(database, callback)`, which creates a missing TAG Table then validates its metadata.
- Produces: Job create/update call `ensure` before config repository and Controller side effects.

- [x] **Step 1: Write the failing tests**

```js
it('creates a missing configured TAG table before saving a Job', async () => {
  const database = fakeDatabase({ tableExists: false });
  await create(managerFor(root, service, database), payload);
  assert.deepEqual(database.calls, ['ensure']);
  assert.equal(repositoryFileExists(root, 'line-a'), true);
});

it('does not save the Job when automatic table creation fails', async () => {
  const database = fakeDatabase({ ensureError: error('TABLE_INVALID', 'bad table') });
  await assert.rejects(() => create(managerFor(root, service, database), payload));
  assert.equal(repositoryFileExists(root, 'line-a'), false);
});
```

- [x] **Step 2: Run the focused tests and verify they fail because `ensure` is not called.**

Run: `node --test cgi-bin/tests/job-manager.test.cjs`

- [x] **Step 3: Implement the smallest provisioning adapter.**

```js
ensure(database, callback) {
  // Read server and metadata. If metadata reports no Table, call the existing
  // TAG Table creator with database.server/table/valueColumn/stringValueColumn,
  // then call validate(database, callback). Existing tables only call validate.
}
```

Use the existing server-store/metadata-reader dependencies and the same normalized identifier checks as `/db/table/create`. Change JobManager create/update to call `database.ensure` rather than `database.validate`; retain `validate` for `/job/validate` and start.

- [x] **Step 4: Run the focused tests and verify they pass.**

Run: `node --test cgi-bin/tests/job-manager.test.cjs`

### Task 2: Job form server management and table combobox

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: `api.db.servers.list`, `api.db.tables.list`, `api.db.tables.columns`, and `app.openCreateModal('db-server')`.
- Produces: Database Mapping controls with a server management action, Table direct input/list toggle, and unknown-table status message.

- [x] **Step 1: Write failing render tests.**

```js
assert.match(source, /label="Manage Database Servers"/);
assert.match(source, /Table not found\. It will be created automatically when the job is saved\./);
assert.match(source, /Toggle table list/);
```

- [x] **Step 2: Run the frontend contract test and verify the new assertions fail.**

Run: `node frontend/tests/app-contract.test.mjs`

- [x] **Step 3: Implement the smallest UI change.**

```jsx
<Field label="Registered Server" action={<IconButton icon="add" label="Manage Database Servers" onClick={() => app.openCreateModal('db-server')} />}>
  <select ... />
</Field>
<Field label="Table">
  <div className="neo-combobox">...</div>
</Field>
```

Keep the typed Table after choosing a server; reset columns only when Table changes. Show the exact info message only after a server and a non-empty Table name are available and that Table is absent from the loaded server list. Let users enter columns for a missing Table. Use the existing server manager modal rather than a second server form.

- [x] **Step 4: Run the frontend contract test and verify it passes.**

Run: `node frontend/tests/app-contract.test.mjs`

### Task 3: Approved contract record and regression verification

**Files:**
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/FE_DESIGN.md`
- Modify: `docs/specs/BE_DESIGN.md`
- Test: `frontend/tests/model-contract.test.mjs`
- Test: `frontend/tests/api-channel-contract.test.mjs`
- Test: `frontend/tests/app-contract.test.mjs`
- Test: `cgi-bin/tests/*.test.cjs`

**Interfaces:**
- Consumes: approved behavior in this plan.
- Produces: CCR entry and matching FE/BE implementation requirements.

- [x] **Step 1: Add CCR-046.**

Record the prior list-only/explicit-table-create behavior, the approved direct-input combobox/server modal/automatic-creation behavior, the reason, effects, and `승인됨 — 2026-08-07 사용자 “그리고 설계 승인”`.

- [x] **Step 2: Update the three design documents.**

Specify that create and stopped-job update provision only a missing Table while holding the Job mutation lock; `/job/validate` and runtime start never create it. State that existing invalid/non-TAG tables are still rejected and table creation failure leaves the Job untouched.

- [x] **Step 3: Run regression tests.**

Run: `npm test --prefix frontend`

Run: `node --test cgi-bin/tests/*.test.cjs`

- [x] **Step 4: Verify the rendered flow.**

Run the local frontend and verify: `#/jobs/new` → choose server → open the `+` server manager → type a non-existing Table → see the info message → type numeric and optional string columns → Create. Confirm no console error and no framework error page.
