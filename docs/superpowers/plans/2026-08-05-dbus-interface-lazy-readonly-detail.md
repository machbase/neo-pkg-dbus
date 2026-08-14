# DBus Interface 지연 상세·Built-in 읽기 전용 상세 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 목록 선택은 상세 API를 호출하지 않고, Edit로 연 상세에서 사용자 Interface는 편집하고 Built-in Interface는 읽기 전용으로 보여 준다.

**Architecture:** `DbusInterfacesModal`은 목록 상태와 상세 입력 모달을 분리한다. 목록 행 선택은 로컬 상태만 바꾸며, Edit는 단일 큐를 통해 상세 API를 읽는다. Backend는 `reviewRequired` 계산 실패가 Interface 상세 전체를 실패시키지 않도록 안전한 기본값을 사용한다.

**Tech Stack:** React 19, Vite, Node test runner, Machbase Neo JSH CGI

## Global Constraints

- 공개 상세 응답은 `docs/specs/DBUS_SDD.md` 4.1을 유지한다.
- Built-in은 조회만 가능하고 저장·Discover·삭제·Method mutation은 불가하다.
- 목록 모달의 행 선택은 네트워크 요청을 만들지 않는다.
- Neo CGI 요청은 기존 단일 FIFO 큐와 AbortSignal 규칙을 따른다.
- Neo 최소 버전은 8.5.6이다.

---

### Task 1: 목록과 Edit 상세 흐름

**Files:**
- Modify: `frontend/src/App.jsx: DbusInterfacesModal, DbusInterfaceFormModal`
- Modify: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: `api.interfaces.list()`, `api.interfaces.get(id, {signal})`
- Produces: 선택은 로컬 상태만 바꾸고 Edit만 상세 API를 호출하는 모달 흐름

- [x] **Step 1: 실패하는 동작 테스트를 쓴다.**

  `app-contract.test.mjs`에 다음을 추가한다.

  ```js
  test("행 선택은 상세 API를 부르지 않고 Edit만 상세를 읽는다", async () => {
    api.interfaces.list = async () => [builtIn];
    api.interfaces.get = async () => detail;
    // 행 선택 뒤 get 호출 수는 0
    // Edit 뒤 get 호출 수는 1
  });
  ```

- [x] **Step 2: 새 테스트가 실패하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: 현재 hydrate 효과가 목록 직후 상세 GET을 호출해 실패.

- [x] **Step 3: 목록 hydrate를 제거하고 Edit 시에만 상세를 읽는다.**

  `loaded.data`를 순회하는 `hydrate` effect를 제거한다. `select(id)`는 `selectedId`와 오류 상태만 갱신한다. `openForm(id)`는 `apiQueue.run()`을 통해 `loadDetail(id, { force: true })`를 완료한 뒤 form state를 연다. 삭제도 Edit와 같은 방식으로 상세를 읽어 참조 여부를 확인한다.

- [x] **Step 4: 테스트가 통과하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: 행 선택 0회, Edit 1회 GET assertion PASS.

- [x] **Step 5: 커밋한다.**

  ```bash
  git add frontend/src/App.jsx frontend/tests/app-contract.test.mjs
  git commit -m "fix: load dbus interface details on edit"
  ```

### Task 2: Built-in 읽기 전용 상세

**Files:**
- Modify: `frontend/src/App.jsx: DbusInterfacesModal, DbusInterfaceFormModal, DbusMethodEditor`
- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/FE_DESIGN.md`

**Interfaces:**
- Consumes: Task 1의 Edit 상세 결과
- Produces: Built-in Edit 상세는 열리지만 어떤 mutation control도 동작하지 않는 화면

- [x] **Step 1: Built-in 상세의 실패하는 테스트를 쓴다.**

  ```js
  test("Built-in Edit는 읽기 전용 상세를 열고 Delete는 비활성이다", async () => {
    // Edit 버튼은 enabled, form 필드/Discover/Save는 disabled
    // Delete DBus Interface는 disabled
  });
  ```

- [x] **Step 2: 새 테스트가 실패하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: 현재 built-in Edit가 disabled여서 실패.

- [x] **Step 3: Built-in Edit를 읽기 전용 상세로 구현한다.**

  built-in 행의 Edit는 enabled로 두고 제목을 `View DBus Interface`로 표시한다. form에 `readOnly` prop을 추가해 모든 Input/select, Discover, Save Interface, Save All과 Method mutation control을 disabled로 만든다. Delete는 계속 disabled로 둔다.

- [x] **Step 4: 계약 문서를 갱신한다.**

  `DBUS_SDD.md`에 이전 동작·새 동작·이유·사용자 승인 상태를 CCR로 기록한다. `FE_DESIGN.md`에는 목록 선택의 무네트워크 규칙과 built-in Edit 읽기 전용 상세를 명시한다. API 형식은 바꾸지 않는다.

- [x] **Step 5: 테스트와 빌드를 확인하고 커밋한다.**

  Run: `cd frontend && npm run test:layout && npm run build:root -- --with-ls-interface`

  ```bash
  git add frontend/src/App.jsx frontend/tests/app-contract.test.mjs docs/specs/DBUS_SDD.md docs/specs/FE_DESIGN.md
  git commit -m "feat: show built-in dbus interface details"
  ```

### Task 3: Neo 상세 API 500 복구

**Files:**
- Modify: `cgi-bin/src/interfaces/manager.js`
- Modify: `cgi-bin/src/interfaces/store.js`
- Modify: `cgi-bin/tests/interfaces-api.test.cjs`

**Interfaces:**
- Consumes: `InterfaceStore.reviewRequired(interfaceId, methodId)`
- Produces: `GET /dbus-interface?id=`가 상태 읽기 문제에도 계약상 Method detail과 `reviewRequired: false`를 반환

- [ ] **Step 1: 상태 읽기 실패의 실패하는 Backend 테스트를 쓴다.**

  ```js
  test("상태 파일 읽기 실패도 Interface 상세를 500으로 만들지 않는다", () => {
    const store = { find: () => builtIn, reviewRequired: () => { throw new Error("neo failure"); } };
    manager.getInterface("ls-plc-device", callback);
    assert.equal(result.interface.methods[0].reviewRequired, false);
  });
  ```

- [ ] **Step 2: 새 테스트가 실패하는지 확인한다.**

  Run: `node cgi-bin/tests/interfaces-api.test.cjs`

  Expected: `withReviewRequired()` 예외로 상세 callback이 실패.

- [ ] **Step 3: reviewRequired 계산을 안전하게 감싼다.**

  `withReviewRequired()`에 Method별 `try/catch`를 넣어 상태 계산 실패 시 `reviewRequired: false`를 사용한다. Interface 문서 검증 오류와 Job 참조 오류는 숨기지 않는다.

- [ ] **Step 4: Backend 전체 테스트와 실제 API 확인을 한다.**

  Run: `node --test cgi-bin/tests/*.test.cjs`

  실제 Neo 확인: `GET /dbus-interface?id=ls-plc-device`가 HTTP 200이며 Method에 `reviewRequired` boolean이 있어야 한다.

- [ ] **Step 5: 커밋한다.**

  ```bash
  git add cgi-bin/src/interfaces/manager.js cgi-bin/src/interfaces/store.js cgi-bin/tests/interfaces-api.test.cjs
  git commit -m "fix: keep dbus interface detail available"
  ```
