# Database Defaults Review Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 새 Job이 DBus Interface 유무와 관계없이 저장된 Database 기본값을 복사하고, Database Server 편집에서 없는 기본 Table도 직접 입력해 자동 생성할 수 있게 한다.

**Architecture:** Database 기본값은 `settings.json.defaults.database.server`와 해당 DB Server의 `defaultTable`, `valueColumn`, `stringValueColumn`으로만 구성한다. 프론트는 새 Job 초기 상태와 Database Server 폼에 이 값을 적용하고, 기존 `validateServerDefaults()`가 없는 TAG Table을 생성하는 Backend 경로를 그대로 사용한다.

**Tech Stack:** React, Vite, Neo JSH CommonJS CGI, Node.js test runner.

## Global Constraints

- 기준 브랜치는 `feat/database-defaults`, 기준 커밋은 `9177f3817583da022e542b753a717049121f6d51`이다.
- LS 고정 Method, DBus Interface/Method 기본값, 출력 파싱 기본값, 자동 Tag 규칙은 수정하거나 추가하지 않는다.
- 비밀번호는 요청 처리 중에만 사용하며 저장 응답·오류·로그에 노출하지 않는다.
- 디자인 값은 루트 `DESIGN.md`의 토큰만 사용한다.
- `frontend/neo-proxy.json`은 사용자 로컬 설정이므로 수정·커밋하지 않는다.

---

### Task 1: Interface가 없는 새 Job에도 Database 기본값 복사

**Files:**
- Modify: `frontend/src/App.jsx:552-570`
- Test: `frontend/tests/app-contract.test.mjs`

**Consumes:** `settings.defaults.database.server`, `servers[].defaultTable`, `servers[].valueColumn`, `servers[].stringValueColumn`.

**Produces:** Interface 목록이 비어 있어도 `config.database`가 기본 서버의 네 값을 가진 새 Job 상태.

- [ ] **Step 1: 실패하는 계약 테스트 작성**

  `app-contract.test.mjs`에 다음 정적 계약을 추가한다.

  ```js
  test("새 Job은 Interface 목록이 비어도 Database 기본값을 복사한다", () => {
    const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    assert.match(source, /const server = \(servers \|\| \[\]\)\.find/);
    assert.match(source, /setConfig\(\{ \.\.\.createDefaultJobConfig\(null, databaseServer\), database:/);
    assert.match(source, /table: server\?\.defaultTable \|\| ""/);
  });
  ```

- [ ] **Step 2: 테스트가 실패하는지 확인**

  Run: `node --test frontend/tests/app-contract.test.mjs`

  Expected: 새 테스트가 `createDefaultJobConfig(null, databaseServer)` 경로에 기본 Table/Column이 없어서 실패한다.

- [ ] **Step 3: 최소 구현**

  `JobForm`의 새 Job 초기화에서 Interface 분기 전에 Database 값을 만든다.

  ```js
  const database = {
    server: databaseServer,
    table: server?.defaultTable || "",
    valueColumn: server?.valueColumn || "",
    stringValueColumn: server?.stringValueColumn || "",
  };
  setConfig(interfaces.length
    ? { ...DEFAULT_CONFIG, database }
    : { ...createDefaultJobConfig(null, databaseServer), database });
  ```

  기존 Interface가 있는 경우에는 사용자가 아직 Method를 고르기 전의 일반 편집 흐름을 유지한다.

- [ ] **Step 4: 테스트 통과 확인**

  Run: `node --test frontend/tests/app-contract.test.mjs`

  Expected: Interface가 비어 있는 경우와 기존 프론트 계약 테스트가 모두 통과한다.

- [ ] **Step 5: 커밋**

  ```bash
  git add frontend/src/App.jsx frontend/tests/app-contract.test.mjs
  git commit -m "fix: copy database defaults without interfaces"
  ```

### Task 2: Default Table 입력+선택 콤보박스 복원

**Files:**
- Modify: `frontend/src/App.jsx:1136-1185`
- Modify: `frontend/src/styles.css`의 `.neo-combobox` 공용 규칙 사용부
- Test: `frontend/tests/app-contract.test.mjs`

**Consumes:** `api.db.preview.tables(draft)`, `api.db.preview.columns({ ...draft, table })`.

**Produces:** 저장 전 연결 정보로 목록을 불러오고, 목록 선택 또는 직접 입력한 Default Table을 `draft.defaultTable`에 저장하는 폼.

- [ ] **Step 1: 실패하는 계약 테스트 작성**

  ```js
  test("Database Server 기본 Table은 목록 선택과 직접 입력을 함께 제공한다", () => {
    const source = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    assert.match(source, /neo-default-table-combobox/);
    assert.match(source, /placeholder="Select or enter a default table\.\.\."/);
    assert.match(source, /api\.db\.preview\.tables\(draft\)/);
    assert.match(source, /api\.db\.preview\.columns\(\{ \.\.\.draft, table \}\)/);
  });
  ```

- [ ] **Step 2: 테스트가 실패하는지 확인**

  Run: `node --test frontend/tests/app-contract.test.mjs`

  Expected: 현재 `<select>` 전용 구현에는 `neo-default-table-combobox`와 직접 입력 placeholder가 없어 실패한다.

- [ ] **Step 3: 최소 구현**

  `Default Table` 필드를 일반 `<select>`에서 기존 Job Table과 같은 `.neo-combobox`로 바꾼다.

  ```jsx
  <div className="neo-combobox neo-default-table-combobox">
    <Input
      disabled={!defaultTablesReady}
      placeholder="Select or enter a default table..."
      value={draft.defaultTable}
      onChange={(table) => setDraft((current) => ({
        ...current, defaultTable: table.toUpperCase(), valueColumn: "", stringValueColumn: "",
      }))}
    />
  </div>
  ```

  목록에서 선택했을 때는 목록을 닫고 `loadDefaultColumns(table)`을 호출한다. 직접 입력한 이름이 목록에 없으면 Column 선택은 비활성화하고, 저장 시 Backend가 TAG Table을 자동 생성하도록 `defaultTable`만 보낸다. 이 경로에서는 `VALUE`와 `STR_VALUE`를 프론트에서 강제하지 않는다.

- [ ] **Step 4: 테스트 통과 확인**

  Run: `node --test frontend/tests/app-contract.test.mjs && npm --prefix frontend run build:root`

  Expected: 계약 테스트와 프론트 빌드가 통과하고, DBus Method 관련 산출물 변화가 없다.

- [ ] **Step 5: 커밋**

  ```bash
  git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/app-contract.test.mjs
  git commit -m "fix: allow entering default database tables"
  ```

### Task 3: 자동 생성과 기본 서버 삭제 차단 테스트 보강

**Files:**
- Modify: `cgi-bin/tests/db-log-cgi-api.test.cjs`
- Modify: `cgi-bin/tests/settings-contract.test.cjs`
- Test: `cgi-bin/tests/*.test.cjs`

**Consumes:** `validateServerDefaults()`, `metadataReader.createTagTable()`, `DB_SERVER_DEFAULT_REQUIRED`.

**Produces:** 없는 Default Table 생성, 생성 후 `VALUE`/`STR_VALUE` 저장, 기본 서버 삭제 차단을 고정하는 회귀 테스트.

- [ ] **Step 1: 실패하는 CGI 테스트 작성**

  `db-log-cgi-api.test.cjs`에 `columns()`가 처음 `NOT_FOUND`, 다음에 `TAG`와 `VALUE`/`STR_VALUE`를 주는 stub을 둔다.

  ```js
  assert.deepEqual(createdTable, { table: 'NEW_TAG' });
  assert.equal(savedServer.defaultTable, 'NEW_TAG');
  assert.equal(savedServer.valueColumn, 'VALUE');
  assert.equal(savedServer.stringValueColumn, 'STR_VALUE');
  ```

  기본 서버 DELETE 요청에는 settings stub의 `defaults.database.server`와 같은 name을 주고 다음을 검증한다.

  ```js
  assert.equal(deleteHarness.failures[0].failure.code, 'DB_SERVER_DEFAULT_REQUIRED');
  assert.equal(deleteHarness.failures[0].status, 409);
  ```

- [ ] **Step 2: 테스트가 실패하는지 확인**

  Run: `node --test cgi-bin/tests/db-log-cgi-api.test.cjs`

  Expected: 현재 테스트에 해당 검증이 없으므로 새 assertion이 실패한다.

- [ ] **Step 3: 구현 상태 확인 및 필요한 최소 수정**

  `cgi-bin/src/cgi/db-api.js`가 다음 순서를 지키는지 확인한다.

  ```js
  NOT_FOUND -> createTagTable(connection, table) -> columns(connection, table)
  -> store.create/update({ defaultTable: table, valueColumn: 'VALUE', stringValueColumn: 'STR_VALUE' })
  ```

  순서나 응답 코드가 다를 때만 수정한다. 비밀번호가 응답이나 오류 details에 포함되지 않도록 테스트도 유지한다.

- [ ] **Step 4: 전체 Backend 테스트 통과 확인**

  Run: `node --test cgi-bin/tests/*.test.cjs`

  Expected: 모든 CGI 테스트가 통과한다.

- [ ] **Step 5: 커밋**

  ```bash
  git add cgi-bin/tests/db-log-cgi-api.test.cjs cgi-bin/tests/settings-contract.test.cjs cgi-bin/src/cgi/db-api.js
  git commit -m "test: cover database default table creation"
  ```

### Task 4: 계약 문서와 최종 검증

**Files:**
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/FE_DESIGN.md`
- Modify: `docs/specs/BE_DESIGN.md`

**Consumes:** Task 1~3 완료 상태.

**Produces:** DB 기본값만 이식한다는 범위와 자동 생성 조건을 명시한 계약 문서.

- [ ] **Step 1: 문서에 확정 동작 기록**

  세 문서에 다음을 명시한다.

  ```text
  새 Job은 Interface 목록 유무와 상관없이 Database 기본값만 복사한다.
  기본 DBus Interface, Method, output parser, 자동 Tag는 이 기능에 포함하지 않는다.
  Database Server의 Default Table은 연결 후 목록에서 고르거나 직접 입력할 수 있다.
  직접 입력한 없는 Table은 저장 시 TAG Table로 생성되고 VALUE/STR_VALUE를 기본 Column으로 사용한다.
  기본 Database Server는 다른 서버를 기본값으로 바꾸기 전에는 삭제할 수 없다.
  ```

- [ ] **Step 2: 최종 검증**

  Run:

  ```bash
  node --test cgi-bin/tests/*.test.cjs
  node --test frontend/tests/*.test.mjs
  npm --prefix frontend run build:root
  git diff --check
  ```

  Expected: 모든 테스트와 빌드가 통과하고 공백 오류가 없다.

- [ ] **Step 3: 범위 검사**

  Run: `git diff 9177f3817583da022e542b753a717049121f6d51 -- frontend/src/App.jsx cgi-bin/src docs/specs`

  Expected: DBus Method 기본값, LS 고정 Method, 자동 Tag, 출력 파싱 템플릿 변경이 없다.

- [ ] **Step 4: 커밋**

  ```bash
  git add docs/specs/DBUS_SDD.md docs/specs/FE_DESIGN.md docs/specs/BE_DESIGN.md
  git commit -m "docs: clarify database default behavior"
  ```

## Self-review

- [x] P0 Interface 없는 새 Job 기본값 누락은 Task 1에서 해결한다.
- [x] P1 Default Table 직접 입력 누락은 Task 2에서 해결한다.
- [x] P2 자동 생성·삭제 차단 테스트 부족은 Task 3에서 해결한다.
- [x] DBus Method와 LS 자동 Tag를 제외하는 범위는 모든 Task와 최종 검사에 적었다.
- [x] 모든 Task는 파일, 실패 테스트, 최소 구현, 검증, 커밋 단계를 포함한다.
