# Job-Time Default Table Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Database Server 저장의 Table 생성 부수 효과를 없애고, Job 저장 시 Output Mapping에 필요한 Column만 가진 TAG Table을 생성하며 String Value Column이 없을 때 문자열 행만 버린다.

**Architecture:** 공통 저장 자료형 판정 모듈이 Job Output Mapping과 Method output type을 읽어 String Column 필요 여부를 결정한다. Job mutation은 이 결정을 Database validation adapter에 넘겨 없는 Table만 생성하고, 기존 Table은 metadata를 재검증하지 않는다. Frontend는 같은 규칙으로 없는 Table의 제출 mapping만 준비하지만 Backend 판정을 최종 기준으로 사용한다.

**Tech Stack:** Machbase Neo JSH CommonJS Backend, React 19/Vite Frontend, Node `node:test`·`assert` 계약 테스트

## Global Constraints

- 최소 Machbase Neo version은 `8.5.6`이다.
- 기본 `npm run build`는 항상 generic 완성 산출물을 루트에 남겨야 한다.
- `localhost` 초기 Default Table은 `DEFAULT_DBUS`이며 실제 Table과 두 Column은 미리 만들지 않는다.
- Database Server Create·Update는 Table 생성과 metadata 검증을 하지 않는다.
- Job POST와 정지된 PUT만 없는 Table을 생성하고 `/job/validate`와 Start는 생성하지 않는다.
- 기존 Table은 Column 존재·자료형을 재검증하거나 schema를 변경하지 않는다.
- 사용자 변경인 `frontend/neo-proxy.json`, DataViewer 파일과 관련 테스트 hunk를 커밋하지 않는다.

---

### Task 1: Output 저장 자료형 정책과 Job 저장 전달값

**Files:**
- Create: `cgi-bin/src/output/storage-policy.js`
- Modify: `cgi-bin/src/jobs/manager.js:110-122, 480, 619`
- Modify: `cgi-bin/tests/job-manager.test.cjs`
- Test: `cgi-bin/tests/output-storage-policy.test.cjs`

**Interfaces:**
- Produces: `selectionStorageType(selection, outputType) -> "numeric" | "string"`
- Produces: `jobNeedsStringValueColumn(config, interfaceStore) -> boolean`
- Changes: `databaseAdapter.ensure(database, { needsStringValueColumn }, callback)`

- [x] **Step 1: 저장 자료형 정책 실패 테스트 작성**

```js
const { selectionStorageType, jobNeedsStringValueColumn } = require('../src/output/storage-policy.js');

assert.equal(selectionStorageType({ valueType: 'array', elementType: 'numeric' }, 'string'), 'numeric');
assert.equal(selectionStorageType({ valueType: 'array', elementType: 'json' }, 'string'), 'string');
assert.equal(selectionStorageType({ interpretation: 'native' }, 'uint16'), 'numeric');
assert.equal(selectionStorageType({ interpretation: 'native' }, 'string'), 'string');
assert.equal(selectionStorageType({ interpretation: 'native' }, 'boolean'), 'string');
assert.equal(jobNeedsStringValueColumn(numericJob, interfaceStore), false);
assert.equal(jobNeedsStringValueColumn(stringJob, interfaceStore), true);
```

- [x] **Step 2: 정책 테스트가 RED인지 확인**

Run: `node cgi-bin/tests/output-storage-policy.test.cjs`

Expected: `Cannot find module '../src/output/storage-policy.js'`

- [x] **Step 3: 공통 정책 모듈 최소 구현**

```js
'use strict';

const NUMERIC_DBUS_TYPES = new Set(['byte', 'uint16', 'uint32', 'uint64', 'int16', 'int32', 'int64', 'double']);

function selectionStorageType(selection, outputType) {
  const selected = selection.valueType === 'array' ? selection.elementType : selection.valueType;
  if (selected) return selected === 'numeric' ? 'numeric' : 'string';
  return NUMERIC_DBUS_TYPES.has(outputType) ? 'numeric' : 'string';
}

function jobNeedsStringValueColumn(config, interfaceStore) {
  return config.methodCalls.some((call) => {
    const method = interfaceStore.find(call.interfaceId).methods.find((item) => item.id === call.methodId);
    return call.outputSelections.some((selection) => (
      selectionStorageType(selection, method.outputs[selection.sourceIndex].type) === 'string'
    ));
  });
}

module.exports = { jobNeedsStringValueColumn, selectionStorageType };
```

- [x] **Step 4: Job create/update가 정책 결과를 ensure에 전달하는 실패 테스트 작성**

`fakeDatabase.ensure`가 두 번째 인자를 기록하게 하고 숫자 Job create는
`{needsStringValueColumn:false}`, 문자열 Job update는
`{needsStringValueColumn:true}`를 받는지 검사한다.

- [x] **Step 5: Job manager 최소 구현**

```js
const { jobNeedsStringValueColumn } = require('../output/storage-policy.js');

databaseOptions(config) {
  return { needsStringValueColumn: jobNeedsStringValueColumn(config, this.interfaceStore) };
}

this.database.ensure(config.database, this.databaseOptions(config), (databaseError) => {
  // 기존 원자적 create/update 흐름 유지
});
```

- [x] **Step 6: Task 1 테스트 GREEN 확인**

Run: `node cgi-bin/tests/output-storage-policy.test.cjs && node cgi-bin/tests/job-manager.test.cjs`

Expected: 두 테스트 모두 PASS

---

### Task 2: Database Server 저장 부수 효과 제거와 localhost 기본값

**Files:**
- Modify: `cgi-bin/src/db/server-store.js:89-115`
- Modify: `cgi-bin/src/cgi/db-api.js:53-91, 108-119`
- Modify: `cgi-bin/tests/db-server-store-api.test.cjs`
- Modify: `cgi-bin/tests/db-log-cgi-api.test.cjs`

**Interfaces:**
- Preserves: DB Server POST/PUT payload와 공개 응답 구조
- Changes: 새 `localhost` document는 `{defaultTable:"DEFAULT_DBUS", valueColumn:"", stringValueColumn:""}`
- Removes: DB Server POST/PUT 중 `metadataReader.columns()`와 `createTagTable()` 호출

- [x] **Step 1: localhost 초기값 RED 테스트 작성**

```js
const servers = await call(store, 'list');
assert.deepEqual(servers.find(({ name }) => name === 'localhost'), {
  schemaVersion: 1,
  name: 'localhost',
  host: '127.0.0.1',
  port: 5656,
  user: 'sys',
  hasPassword: true,
  defaultTable: 'DEFAULT_DBUS',
  valueColumn: '',
  stringValueColumn: '',
});
```

- [x] **Step 2: DB Server 저장이 Table API를 호출하지 않는 RED 테스트 작성**

```js
const metadataReader = {
  columns() { throw new Error('server save must not inspect table metadata'); },
  createTagTable() { throw new Error('server save must not create a table'); },
};
// 없는 NEW_TAG와 빈 Column을 POST하고 그대로 저장되는지 검사한다.
assert.equal(savedServer.defaultTable, 'NEW_TAG');
assert.equal(savedServer.valueColumn, '');
assert.equal(savedServer.stringValueColumn, '');
```

- [x] **Step 3: RED 확인**

Run: `node cgi-bin/tests/db-server-store-api.test.cjs && node cgi-bin/tests/db-log-cgi-api.test.cjs`

Expected: 기존 localhost 빈 Table 또는 `createTagTable` 호출 기대와 달라 FAIL

- [x] **Step 4: localhost 초기 document 변경**

```js
atomicWriter(file(name), validateDocument(name, {
  schemaVersion: 1,
  name,
  host: '127.0.0.1',
  port: 5656,
  user: 'sys',
  password: 'manager',
  defaultTable: 'DEFAULT_DBUS',
  valueColumn: '',
  stringValueColumn: '',
}));
```

- [x] **Step 5: DB API에서 `validateServerDefaults` 제거**

POST와 PUT은 body 형식 검증 후 store에 바로 넘긴다.

```js
if (verb === 'POST') {
  const payload = body();
  if (payload) store.create(payload, callback(201));
} else if (verb === 'PUT') {
  const params = query();
  if (!params) return;
  const payload = body();
  if (payload) store.update(params.name, payload, callback(200));
}
```

- [x] **Step 6: Task 2 GREEN 확인**

Run: `node cgi-bin/tests/db-server-store-api.test.cjs && node cgi-bin/tests/db-log-cgi-api.test.cjs`

Expected: 두 테스트 모두 PASS

---

### Task 3: Job 시점 조건부 Table 생성과 기존 Table 무검증

**Files:**
- Modify: `cgi-bin/src/db/validation-adapter.js:53-156`
- Modify: `cgi-bin/tests/database-validation-adapter.test.cjs`

**Interfaces:**
- Consumes: `ensure(database, { needsStringValueColumn }, callback)`
- Existing Table result: 입력 mapping을 SQL 대문자로 정규화해 반환하되 metadata Column을 검사하지 않음
- New Table request: `{server, table, valueColumn:"VALUE", stringValueColumn:"STR_VALUE" | null}`

- [x] **Step 1: 기존 Table 무검증 RED 테스트 작성**

metadata에 선택 Column이 없거나 문자열 자료형으로 보고되어도 기존 Table이면 ensure가
입력 mapping을 반환하는지 검사한다.

```js
assert.deepEqual(await ensure(existingAdapter, {
  ...database, valueColumn: 'EXTERNAL_VALUE', stringValueColumn: ''
}, { needsStringValueColumn: false }), {
  server: 'local-db', table: 'TAG', valueColumn: 'EXTERNAL_VALUE', stringValueColumn: ''
});
```

- [x] **Step 2: 조건부 생성 RED 테스트 작성**

```js
await ensure(adapter, numericDatabase, { needsStringValueColumn: false });
assert.deepEqual(created[0], {
  server: 'local-db', table: 'DEFAULT_DBUS', valueColumn: 'VALUE', stringValueColumn: null,
});
assert.equal(numericDatabase.stringValueColumn, '');

await ensure(adapter, stringDatabase, { needsStringValueColumn: true });
assert.equal(created[1].stringValueColumn, 'STR_VALUE');
assert.equal(stringDatabase.stringValueColumn, 'STR_VALUE');
```

- [x] **Step 3: RED 확인**

Run: `node cgi-bin/tests/database-validation-adapter.test.cjs`

Expected: ensure 인자와 기존 fixed `STR_VALUE` 동작 때문에 FAIL

- [x] **Step 4: ensure 구현 단순화**

```js
ensure(database, options, callback) {
  // server 존재와 Table 존재 여부만 조회한다.
  // NOT_FOUND가 아니면 SQL 식별자 mapping을 그대로 반환한다.
  const needsString = options && options.needsStringValueColumn === true;
  database.table = String(database.table).toUpperCase();
  database.valueColumn = 'VALUE';
  database.stringValueColumn = needsString ? 'STR_VALUE' : '';
  const request = {
    server: database.server,
    table: database.table,
    valueColumn: 'VALUE',
    stringValueColumn: needsString ? 'STR_VALUE' : null,
  };
  // create 성공 후 post-create metadata 재검증 없이 callback(null, mapping)
}
```

- [x] **Step 5: TABLE_ALREADY_EXISTS 경쟁 테스트 추가**

생성 API가 `TABLE_ALREADY_EXISTS`를 반환하면 기존 Table로 처리하고 schema 변경이나
두 번째 create를 하지 않는지 검사한다.

- [x] **Step 6: Task 3 GREEN 확인**

Run: `node cgi-bin/tests/database-validation-adapter.test.cjs && node cgi-bin/tests/job-manager.test.cjs`

Expected: 두 테스트 모두 PASS

---

### Task 4: String Value Column 없는 Collector의 문자열 행 생략

**Files:**
- Modify: `cgi-bin/src/db/appender.js:80-113`
- Modify: `cgi-bin/src/collector/cycle.js:75-105`
- Modify: `cgi-bin/tests/collector-entry-adapters.test.cjs`
- Modify: `cgi-bin/tests/collector-runtime.test.cjs`

**Interfaces:**
- Produces: `database.append(rows) -> 실제 append한 행 수`
- Collector `storedCount`와 `lastStoredAt`은 버린 문자열 행을 포함하지 않음

- [x] **Step 1: Appender RED 테스트 변경**

```js
const stored = database.append([
  { name: 'NUM', requestTime, value: 1.5, stringValue: null },
  { name: 'TEXT', requestTime, value: 0, stringValue: 'READY' },
]);
assert.equal(stored, 1);
assert.deepEqual(appended, [['NUM', requestTime, 1.5, null]]);
```

- [x] **Step 2: Cycle storedCount RED 테스트 작성**

String Value Column이 없는 Job에서 숫자와 문자열 selection이 함께 성공하면 cycle은
`success`, 숫자 행만 `storedCount`와 `lastStoredAt`에 반영되는지 검사한다. 문자열만
있는 경우 `storedCount:0`이고 `lastStoredAt`은 이전 값을 유지한다.

- [x] **Step 3: RED 확인**

Run: `node cgi-bin/tests/collector-entry-adapters.test.cjs && node cgi-bin/tests/collector-runtime.test.cjs`

Expected: 기존 `DB_APPEND_FAILED`와 기존 행 수 계산 때문에 FAIL

- [x] **Step 4: Appender가 문자열 행을 걸러내고 실제 수를 반환**

```js
const writable = mapping.stringValue
  ? rows
  : rows.filter((row) => row.stringValue === null || row.stringValue === undefined);
writable.forEach((row) => { /* 기존 named append */ });
if (writable.length) appender.flush();
return writable.length;
```

- [x] **Step 5: Cycle이 append 반환값으로 저장 수 계산**

`perMethod`는 `const appended = context.database.append(rows)`를 사용한다.
`afterAllMethods`는 Method별 행의 문자열 여부를 알고 실제 저장 가능한 수를 계산해
각 `storedCount`를 설정한다. Appender가 반환값을 주지 않는 기존 test double은
호환을 위해 입력 행 수로 fallback한다.

- [x] **Step 6: Task 4 GREEN 확인**

Run: `node cgi-bin/tests/collector-entry-adapters.test.cjs && node cgi-bin/tests/collector-runtime.test.cjs`

Expected: 두 테스트 모두 PASS

---

### Task 5: Job·Database Server 화면의 새 Table 상태

**Files:**
- Modify: `frontend/src/model.js`
- Modify: `frontend/src/App.jsx:680-815, 1190-1250`
- Create: `frontend/tests/job-table-provisioning-contract.test.mjs`
- Modify: `frontend/tests/model-contract.test.mjs`

**Interfaces:**
- Produces: `jobNeedsStringValueColumn(methodCalls, interfaceDetails) -> boolean`
- New Table submit mapping: `{valueColumn:"VALUE", stringValueColumn:"STR_VALUE" | ""}`
- Default Server missing Table mapping: `{defaultTable, valueColumn:"", stringValueColumn:""}`

- [x] **Step 1: Frontend 자료형 판정 RED 테스트 작성**

```js
assert.equal(jobNeedsStringValueColumn(numericCalls, details), false);
assert.equal(jobNeedsStringValueColumn(stringCalls, details), true);
assert.equal(jobNeedsStringValueColumn(jsonArrayCalls, details), true);
```

- [x] **Step 2: 화면 계약 RED 테스트 작성**

새 전용 테스트 파일에서 다음 source 계약을 검사한다.

```js
assert.doesNotMatch(source, /stringValueColumn: "STR_VALUE" \? current/);
assert.match(source, /needsStringValueColumn \? "STR_VALUE" : ""/);
assert.match(source, /defaultColumnSelectionDisabled = !defaultTablesReady \|\| !defaultTableKnown/);
assert.match(source, /Table not found\. It will be created automatically when the job is saved\./);
```

- [x] **Step 3: RED 확인**

Run: `node frontend/tests/model-contract.test.mjs && node frontend/tests/job-table-provisioning-contract.test.mjs`

Expected: helper 부재와 기존 항상 `STR_VALUE` 설정 때문에 FAIL

- [x] **Step 4: Frontend helper와 Job 제출 mapping 구현**

```js
const needsStringValueColumn = jobNeedsStringValueColumn(config.methodCalls, interfaceDetails);
const configForSave = tableWillBeCreated ? {
  ...config,
  database: {
    ...config.database,
    valueColumn: 'VALUE',
    stringValueColumn: needsStringValueColumn ? 'STR_VALUE' : '',
  },
} : config;
```

없는 Table을 감지했을 때 화면 state를 항상 `VALUE`/`STR_VALUE`로 덮어쓰는 effect는
삭제한다. Column control은 기존 `columnSelectionDisabled` 규칙을 유지한다.

- [x] **Step 5: Database Server 모달 저장 상태 확인**

없는 Default Table을 직접 입력하면 두 Column을 빈 값으로 유지하고, 기존 Table을
목록에서 고른 경우에만 `loadDefaultColumns`를 실행한다. Create·Update 성공 뒤 현재
목록을 갱신하는 기존 동작은 유지한다.

- [x] **Step 6: Task 5 GREEN 확인**

Run: `node frontend/tests/model-contract.test.mjs && node frontend/tests/job-table-provisioning-contract.test.mjs`

Expected: 두 테스트 모두 PASS

---

### Task 6: 전체 회귀, 제품 빌드와 최종 커밋

**Files:**
- Verify: `cgi-bin/tests/*.test.cjs`
- Verify: `frontend/tests/*.test.mjs`
- Verify: `tests/product-build.test.cjs`
- Verify: `tests/product-modules.test.mjs`
- Verify: root generated `index.html`, `main.html`, `side.html`, `cgi-bin/product/`

**Interfaces:**
- Produces: generic Git 완성 산출물과 generic·LS 양쪽에서 통과한 공통 동작

- [x] **Step 1: Backend 전체 회귀 실행**

Run: `node --test cgi-bin/tests/*.test.cjs`

Expected: 모든 테스트 PASS

- [x] **Step 2: Frontend 전체 회귀 실행**

Run: `npm --prefix frontend test`

Expected: 모든 테스트 PASS

- [x] **Step 3: 제품 계약 테스트 실행**

Run: `npm run test:products`

Expected: generic·LS 제품 테스트 모두 PASS

- [x] **Step 4: LS 완성 빌드 검증**

Run: `npm run build -- --target=ls`

Expected: build 성공, `cgi-bin/provider.json.id === "ls"`

- [x] **Step 5: 커밋 직전 generic 완성 빌드 복원**

Run: `npm run build`

Expected: build 성공, `cgi-bin/provider.json` 없음, `cgi-bin/product/index.js` target은 generic

- [x] **Step 6: 공백·범위 확인**

Run: `GIT_CONFIG_GLOBAL=/dev/null git diff --check && GIT_CONFIG_GLOBAL=/dev/null git status --short`

Expected: 공백 오류 없음. 프록시·DataViewer 사용자 변경은 unstaged로 남고 이번 구현
파일과 generic 생성 산출물만 구현 범위다.

- [x] **Step 7: 구현 커밋**

```bash
git add cgi-bin/src/output/storage-policy.js \
  cgi-bin/src/jobs/manager.js cgi-bin/src/db/server-store.js \
  cgi-bin/src/cgi/db-api.js cgi-bin/src/db/validation-adapter.js \
  cgi-bin/src/db/appender.js cgi-bin/src/collector/cycle.js \
  cgi-bin/tests/output-storage-policy.test.cjs \
  cgi-bin/tests/job-manager.test.cjs cgi-bin/tests/db-server-store-api.test.cjs \
  cgi-bin/tests/db-log-cgi-api.test.cjs cgi-bin/tests/database-validation-adapter.test.cjs \
  cgi-bin/tests/collector-entry-adapters.test.cjs cgi-bin/tests/collector-runtime.test.cjs \
  frontend/src/model.js frontend/src/App.jsx \
  frontend/tests/model-contract.test.mjs frontend/tests/job-table-provisioning-contract.test.mjs
git commit -m "feat: create default tables when jobs are saved"
```

Expected: max-kim profile로 구현 파일만 커밋되고 사용자 변경은 남음
