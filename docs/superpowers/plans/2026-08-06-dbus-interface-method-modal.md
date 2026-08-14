# DBus Interface Method 모달 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover 흐름을 단순화하고, Method를 별도 스크롤 모달에서 보며 참조 중 Interface의 호출 구조를 보호한다.

**Architecture:** `DbusInterfacesModal`의 목록 선택 상세 영역을 없애고, `DbusInterfaceFormModal`이 Discover 결과와 저장된 Method를 전용 모달로 연다. Interface 문서의 `origin: "discovered"|"manual"`이 생성 경로를 보존한다. Backend는 Interface 참조가 있으면 `name`만 저장하도록 `updateInterface`과 `updateDiscoveredInterface`를 제한한다. 자동 발견 Method는 항상 읽기 전용이고, `origin: "manual"` Interface의 `manual` Method만 참조가 없을 때 API와 모달에서 관리한다.

**Tech Stack:** React, Node.js CGI, node:test, 기존 Neo 디자인 토큰.

**Commit Policy:** 사용자 요청에 따라 Task별 커밋을 만들지 않는다. 모든 Task와 최종 검토가 끝난 뒤 이 계획의 변경만 하나의 커밋으로 만든다.

## Global Constraints

- Destination과 Object Path는 같은 폼 행에 둔다.
- Discover 성공 전에는 Discovered Interface 선택 상자를 렌더링하지 않는다.
- Direct input을 고른 경우에만 Interface 입력을 선택 상자 아래에 둔다.
- Job 참조가 있으면 `name`만 바꿀 수 있고, 연결 정보·Interface·Method 재발견·삭제는 `DBUS_INTERFACE_IN_USE`으로 막는다.
- 자동 발견(`source: "discovered"`) Method는 POST·PUT·DELETE `/dbus-method`로 직접 바꾸지 않는다.
- 직접 만든 Interface의 `manual` Method는 Job 참조가 없을 때만 POST·PUT·DELETE `/dbus-method`로 관리한다.
- 기존 Interface 파일에서 `origin`이 빠졌으면 discovered-only Method일 때만 `discovered`, 혼합·manual-only Method는 `manual`로 안전하게 읽는다.

---

### Task 1: 참조 보호와 자동 발견 Method API

**Files:**
- Modify: `cgi-bin/src/interfaces/manager.js`
- Modify: `cgi-bin/src/interfaces/validator.js`
- Modify: `cgi-bin/src/interfaces/store.js`
- Modify: `cgi-bin/api/dbus-interface.js`
- Modify: `cgi-bin/tests/interfaces-api.test.cjs`
- Modify: `cgi-bin/tests/interfaces-cgi-api.test.cjs`

**Interfaces:**
- Consumes: `references.find(interfaceId)`와 `Method.source`.
- Produces: 참조 중 Interface의 name-only PUT 허용, `DBUS_INTERFACE_IN_USE`, 발견 Method의 `DBUS_METHOD_READ_ONLY` 거부.

- [x] **Step 1: 실패 테스트 작성**

```js
const renamed = await call(manager, 'updateInterface', { ...current, name: '새 이름' });
assert.equal(renamed.name, '새 이름');
await rejectsCode(call(manager, 'updateInterface', { ...current, destination: 'other.device' }), 'DBUS_INTERFACE_IN_USE');
await rejectsCode(call(manager, 'updateDiscoveredInterface', current), 'DBUS_INTERFACE_IN_USE');
await rejectsCode(call(manager, 'updateMethod', 'device-status', 'read-value', changedDiscoveredMethod), 'DBUS_METHOD_READ_ONLY');
assert.equal((await call(manager, 'updateMethod', 'manual-interface', 'manual-read', changedManualMethod)).member, 'ManualRead2');
assert.equal(manager.store.find('legacy-manual').origin, 'manual');
assert.equal(manager.store.find('legacy-discovered').origin, 'discovered');
```

- [x] **Step 2: 실패 확인**

Run: `node --test cgi-bin/tests/interfaces-api.test.cjs cgi-bin/tests/interfaces-cgi-api.test.cjs`

Expected: name-only 참조 수정 또는 발견 Method 수정 규칙이 현재 구현과 달라 실패한다.

- [x] **Step 3: 최소 구현**

```js
const callShapeChanged = !same(
  { ...current, name: next.name },
  { ...next, name: current.name },
);
if (refs.length && callShapeChanged) throw error('DBUS_INTERFACE_IN_USE', 'Job이 참조하는 DBus Interface는 호출 구조를 바꿀 수 없습니다.', { jobs: refs });
if (item.origin !== 'manual' || method.source !== 'manual') {
  throw error('DBUS_METHOD_READ_ONLY', '자동 발견 DBus Method가 있는 Interface에서는 Method를 직접 바꿀 수 없습니다.', { interfaceId, methodId });
}
```

`validateInterface`은 `origin`을 검증하고 `origin: "discovered"`이면 모든 Method가 `source: "discovered"`인지 검사한다. `origin: "manual"`은 이전 혼합 Method를 보존할 수 있지만 CRUD 대상은 `source: "manual"`만 허용한다. `/dbus-interface` body allow-list에 `origin`을 추가한다. Discover 결과에는 `origin: "discovered"`, Direct input POST에는 `origin: "manual"`을 넣는다. `InterfaceStore.readDirectory`는 이전 파일의 origin을 Method source로 보완한다. `updateDiscoveredInterface`도 guard callback의 refs를 받아 참조가 있으면 거부한다. `createMethod`은 `origin !== "manual"`인 Interface를 `DBUS_METHOD_READ_ONLY`으로 거부한다. 직접 만든 Interface는 참조가 없을 때 manual Method를 create/update/delete할 수 있다.

- [x] **Step 4: 통과 확인**

Run: `node --test cgi-bin/tests/interfaces-api.test.cjs cgi-bin/tests/interfaces-cgi-api.test.cjs`

Expected: PASS.

- [x] **Step 5: 통합 커밋 대기**

Task 3의 전체 검토가 끝날 때까지 커밋하지 않고, 변경 파일과 테스트 결과를 기록한다.

### Task 2: Method 모달과 Discover 폼

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: `DbusInterfaceFormModal`의 `draft.methods`, `editing`, `references`.
- Produces: `DbusMethodModal`과 `Methods (N)` 열기 버튼. 목록 화면은 선택 상세 Methods 편집기를 렌더링하지 않는다.

- [x] **Step 1: 실패 테스트 작성**

```js
assert.equal(discoveredSelect(renderer.root), undefined);
await discover();
assert.ok(discoveredSelect(renderer.root));
await chooseDiscovered('device');
await clickText('Methods (1)');
assert.ok(renderer.root.findAll((node) => node.props['aria-label'] === 'DBus Methods').length);
assert.equal(renderer.root.findAll((node) => node.props['aria-label'] === 'Edit Method').length, 0);
assert.equal(renderer.root.findAll((node) => node.props.className === 'neo-dbus-interface-detail').length, 0);
```

- [x] **Step 2: 실패 확인**

Run: `cd frontend && node tests/app-contract.test.mjs`

Expected: Discover 전 선택 상자와 목록 아래 Method 편집기가 남아 있어 실패한다.

- [x] **Step 3: 최소 구현**

```jsx
function DbusMethodModal({ item, editable, onClose }) {
  return <Modal title={`Methods (${item.methods.length})`} aria-label="DBus Methods" onClose={onClose}>
    <section className="neo-dbus-method-list neo-dbus-method-list--scroll">
      {item.methods.map((method) => <DbusMethodReadOnlyCard key={method.id} method={method} />)}
    </section>
  </Modal>;
}
```

`DbusInterfaceFormModal`은 `discovered.length > 0`일 때만 선택 상자를 보이고, `manualEntry`일 때만 바로 아래 Interface Field를 렌더링한다. Destination과 Object Path Field는 모두 `wide`가 아닌 한 행의 두 열에 둔다. 새 Direct input Interface는 모달 안에서 draft의 manual Method 배열을 직접 추가·수정·삭제한 뒤 POST body에 넣는다. 저장된 manual Interface는 `/dbus-method` API를 쓴다. Discover 선택 결과는 모든 Method control을 숨긴 읽기 전용 모달로 연다. `DbusInterfacesModal`의 `selectedItem` 상세 section을 제거한다.

- [x] **Step 4: 통과 확인**

Run: `cd frontend && npm test`

Expected: PASS.

- [x] **Step 5: 통합 커밋 대기**

Task 3의 전체 검토가 끝날 때까지 커밋하지 않고, 변경 파일과 테스트 결과를 기록한다.

### Task 3: 계약 문서와 배포 산출물

**Files:**
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/FE_DESIGN.md`
- Modify: `docs/specs/BE_DESIGN.md`
- Modify: `index.html`
- Modify: `main.html`
- Modify: `side.html`

**Interfaces:**
- Consumes: Task 1의 API 오류와 Task 2의 화면 동작.
- Produces: CCR 기록과 최신 단일 파일 화면 산출물.

- [x] **Step 1: 문서 확인 기준 작성**

```text
CCR에는 이전 참조 규칙, name-only 예외, Discover 전 선택 상자 비표시,
별도 Method 모달, 자동 발견 Method 읽기 전용을 모두 기록한다.
```

- [x] **Step 2: 문서와 계약 구현**

`DBUS_SDD.md`에 새 CCR을 추가하고 Interface의 `origin`, 상세 응답·오류 목록의 `DBUS_METHOD_READ_ONLY`, 참조 중 name-only 예외를 적는다. `FE_DESIGN.md`와 `BE_DESIGN.md`는 같은 규칙을 참조한다.

- [x] **Step 3: 빌드와 전체 회귀**

Run: `node --test cgi-bin/tests/*.test.cjs`

Expected: PASS.

Run: `cd frontend && npm test && npm run build:root`

Expected: PASS, `index.html`, `main.html`, `side.html` 갱신.


- [ ] **Step 4: 하나의 통합 커밋**

```bash
git add cgi-bin/api/dbus-interface.js cgi-bin/src/interfaces/manager.js cgi-bin/src/interfaces/store.js cgi-bin/src/interfaces/validator.js cgi-bin/tests/interfaces-api.test.cjs cgi-bin/tests/interfaces-cgi-api.test.cjs frontend/src/App.jsx frontend/tests/app-contract.test.mjs docs/specs/DBUS_SDD.md docs/specs/FE_DESIGN.md docs/specs/BE_DESIGN.md index.html main.html side.html
git commit -m "feat: manage dbus interfaces and methods safely"
```
