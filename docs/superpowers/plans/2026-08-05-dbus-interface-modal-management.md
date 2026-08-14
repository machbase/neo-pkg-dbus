# DBus Interface 모달 관리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DBus Interface를 Database Servers와 같은 목록 모달에서 추가·수정·삭제하고, 선택한 Interface의 Method도 관리한다.

**Architecture:** `CreateModalLayer`의 `dbus-interface` 분기를 단순 생성 모달에서 `DbusInterfacesModal`로 바꾼다. 목록 모달은 list/detail/references 상태와 Add/Edit/Delete 전환만 맡고, 입력·Discover·저장은 `DbusInterfaceFormModal`, Method 변경은 `DbusMethodEditor`가 맡는다. 기존 Backend API와 저장 형식은 그대로 쓴다.

**Tech Stack:** React 19, React Router 7, Vite, 기존 `api.js` fetch wrapper, Node 내장 test runner와 정적 프런트엔드 계약 테스트.

## Global Constraints

- `DESIGN.md`의 기존 `--neo-*` 색상, 4px 모서리, 32px 입력·주요 버튼, 28px 일반 버튼만 사용한다.
- Side의 `New DBus Interface`는 route를 바꾸지 않고 `open-create-modal: dbus-interface` 메시지로 현재 화면 위에 모달을 연다.
- built-in LS PLC Interface와 그 Method는 읽기 전용이다.
- references가 있는 사용자 Interface/Method는 FE에서 수정·삭제를 disabled 처리하고 Backend의 최종 검증도 그대로 사용한다.
- DBus Interface API와 Method API의 request/response 형식, Interface ID, 저장 JSON은 변경하지 않는다.
- 모달 닫기·취소·Esc·바깥 클릭 뒤에는 현재 Job route와 입력 중 Job draft를 유지한다.

---

### Task 1: 목록 모달 계약과 목록·삭제 상태

**Files:**

- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `frontend/src/App.jsx: CreateModalLayer, InterfaceCreateModal 교체 위치`
- Modify: `frontend/src/styles.css: database modal 인접 모달 스타일`

**Interfaces:**

- Consumes: `api.interfaces.list(options)`, `api.interfaces.get(id, options)`, `api.interfaces.remove(id, options)`.
- Produces: `DbusInterfacesModal()`과 `DbusInterfaceDeleteConfirmModal({ item, references, onCancel, onConfirm })`.
- State: `mode`는 `"list" | "form"`, `selectedId`는 `string`, `pendingDelete`는 `string`, 선택 detail은 `{ interface, references } | null`이다.

- [x] **Step 1: 목록 모달의 실패하는 정적 계약 테스트를 쓴다.**

  `frontend/tests/app-contract.test.mjs`에 다음 검사를 추가한다.

  ```js
  assert.ok(app.includes("function DbusInterfacesModal()"));
  assert.ok(app.includes('title="DBus Interfaces"'));
  assert.ok(app.includes('label="Edit DBus Interface"'));
  assert.ok(app.includes('label="Delete DBus Interface"'));
  assert.ok(app.includes("function DbusInterfaceDeleteConfirmModal"));
  assert.ok(!app.includes("function InterfaceCreateModal()"));
  ```

- [x] **Step 2: 새 테스트가 현재 구현에서 실패하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: `DbusInterfacesModal` 또는 목록 모달 문자열이 없어 assertion 실패.

- [x] **Step 3: 목록 모달과 삭제 확인 모달을 최소 구현한다.**

  `App.jsx`에서 `InterfaceCreateModal`을 아래 책임의 `DbusInterfacesModal`로 교체한다.

  ```jsx
  function DbusInterfacesModal() {
    const app = useApp();
    const loaded = useLoad((signal) => api.interfaces.list({ signal }), [app.resourceRevision]);
    const [selectedId, setSelectedId] = useState("");
    const [detail, setDetail] = useState(null);
    const [mode, setMode] = useState("list");
    const [pendingDelete, setPendingDelete] = useState("");
    // selectedId가 바뀌면 api.interfaces.get()으로 interface와 references를 읽는다.
    // builtIn 또는 references.length > 0이면 mutation 버튼을 disabled 처리한다.
  }
  ```

  목록 행은 기존 `.neo-db-server-card` 구조와 action 아이콘 버튼을 재사용한다. 행에는 Interface 이름, `busType · destination`, objectPath, Method 수, Built-in/User와 Standard 상태를 보여 준다. `api.interfaces.remove(id)` 성공 뒤 `app.resourceChanged()`와 `loaded.reload()`를 실행하고 선택·삭제 상태를 비운다. 삭제 확인 문구에는 Interface 이름을 넣는다.

- [x] **Step 4: 목록 모달 테스트가 통과하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: PASS.

- [x] **Step 5: 목록 모달 작업을 커밋한다.**

  ```bash
  git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/app-contract.test.mjs
  git commit -m "feat: add dbus interface management modal"
  ```

### Task 2: Interface 입력·Discover·Save All 흐름

**Files:**

- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `frontend/src/App.jsx: DbusInterfaceFormModal 추가`
- Modify: `frontend/src/styles.css: dbus interface form modal 클래스`

**Interfaces:**

- Consumes: `api.interfaces.discover(connection)`, `api.interfaces.create(value)`, `api.interfaces.update(value)`, `api.interfaces.saveAll(interfaces)`.
- Produces: `DbusInterfaceFormModal({ editing, initialValue, onSaved, onCancel })`.
- Form value: `{ id, busType, destination, objectPath, interface, methods }`; Discover 요청은 `{ busType, destination, objectPath }`만 보낸다.

- [x] **Step 1: 입력 모달의 실패하는 정적 계약 테스트를 쓴다.**

  `frontend/tests/app-contract.test.mjs`에 다음 검사를 추가한다.

  ```js
  assert.ok(app.includes("function DbusInterfaceFormModal"));
  assert.ok(app.includes('title={editing ? "Edit DBus Interface" : "Add DBus Interface"}'));
  assert.ok(app.includes(">Discover<"));
  assert.ok(app.includes(">Save All<"));
  assert.ok(app.includes(">Save Interface<"));
  ```

- [x] **Step 2: 새 테스트가 현재 구현에서 실패하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: `DbusInterfaceFormModal`과 직접 저장 control 문자열이 없어 app 계약이 실패.

- [x] **Step 3: 입력 모달을 최소 구현한다.**

  `DbusInterfaceFormModal`은 Add에서 빈 draft, Edit에서 상세 Interface draft를 사용한다. Edit의 ID input에는 `readOnly`를 준다. Discover 결과는 `<details open>`으로 모든 Interface·Method·입력·출력을 표시한다.

  ```jsx
  const discover = async () => {
    const found = await api.interfaces.discover({
      busType: draft.busType,
      destination: draft.destination,
      objectPath: draft.objectPath,
    });
    setDiscovered(found);
  };
  const save = async () => {
    if (discovered.length) await api.interfaces.saveAll(discovered);
    else if (editing) await api.interfaces.update(draft);
    else await api.interfaces.create({ ...draft, methods: [] });
    await onSaved();
  };
  ```

  Save All은 Discover 결과가 있을 때만 활성화하고, 직접 저장은 `id`, `destination`, `objectPath`, `interface`가 비어 있으면 disabled 처리한다. Discover 실패 시 draft와 이전 discovered 결과를 보존하고 `Notice error`에 표시한다. 성공 시 목록 재조회와 `resourceChanged()` 후 목록 모달로 돌아간다.

- [x] **Step 4: 입력·API 계약 테스트가 통과하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: PASS.

- [x] **Step 5: 입력·Discover 작업을 커밋한다.**

  ```bash
  git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/app-contract.test.mjs
  git commit -m "feat: add dbus interface edit and discover modal"
  ```

### Task 3: Method 관리 연결과 전용 route 제거

**Files:**

- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `frontend/src/App.jsx: DbusMethodEditor 추가, PageNav, MainRoutes, InterfacesPage 제거`
- Modify: `frontend/src/styles.css: dbus interface Method 목록 스타일`
- Modify: `docs/specs/FE_DESIGN.md: DBus Interface 관리 진입점 설명`

**Interfaces:**

- Consumes: `api.methods.create(interfaceId, method)`, `api.methods.update(interfaceId, methodId, method)`, `api.methods.remove(interfaceId, methodId)`.
- Produces: `DbusMethodEditor({ item, references, onChanged, onError })`.
- Method draft: `{ id, member, source: "manual", inputs: [], outputs: [] }`.

- [x] **Step 1: Method 모달과 route 제거의 실패하는 정적 계약 테스트를 쓴다.**

  `frontend/tests/app-contract.test.mjs`에 다음 검사를 추가한다.

  ```js
  assert.ok(app.includes("function DbusMethodEditor"));
  assert.ok(app.includes('label="Edit Method"'));
  assert.ok(app.includes('label="Delete Method"'));
  assert.ok(!app.includes('path="/interfaces"'));
  assert.ok(!app.includes('<Link to="/interfaces">DBus Interfaces</Link>'));
  ```

- [x] **Step 2: 새 테스트가 현재 구현에서 실패하는지 확인한다.**

  Run: `cd frontend && node tests/app-contract.test.mjs`

  Expected: `DbusMethodEditor`가 없고 `/interfaces` route가 남아 assertion 실패.

- [x] **Step 3: 선택 Interface의 Method editor와 단일 진입점을 구현한다.**

  `DbusInterfacesModal`의 선택 상세 아래에 `DbusMethodEditor`를 넣는다. 이 컴포넌트는 Method 목록과 Add/Edit/Delete controls를 보여 준다. built-in Interface 또는 references가 있는 Method는 controls를 disabled 처리하고 참조 Job 이름을 표시한다. Create/Update/Delete 성공 뒤 부모의 detail 재조회와 목록 재조회를 호출한다.

  `PageNav`의 DBus Interfaces 링크, `InterfacesPage` 함수, `MainRoutes`의 `/interfaces` route를 삭제한다. Side의 기존 `New DBus Interface` 아이콘은 변경하지 않는다.

  `FE_DESIGN.md`의 화면 설명을 “Side의 New DBus Interface가 목록 모달을 열고, 목록에서 Interface와 Method를 관리한다”로 구체화한다. 공개 API·동작 계약은 바꾸지 않는다.

- [x] **Step 4: 프런트엔드 전체 계약과 빌드를 확인한다.**

  Run: `cd frontend && npm run test:layout && npm run build:root -- --with-ls-interface`

  Expected: 모든 계약 테스트와 LS 선택 빌드 테스트가 PASS, 빌드 exit 0.

- [x] **Step 5: 전체 프런트엔드 작업을 커밋한다.**

  ```bash
  git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/app-contract.test.mjs docs/specs/FE_DESIGN.md
  git commit -m "feat: manage dbus interface methods from modal"
  ```

### Task 4: 실제 패키지 화면 검증

**Files:**

- Modify: `docs/superpowers/plans/2026-08-05-dbus-interface-modal-management.md` 체크 표시만 갱신
- Test: `frontend` 빌드 산출물과 Neo 서버의 `/public/neo-pkg-dbus/` 화면

**Interfaces:**

- Consumes: Task 1~3의 목록 모달, 입력 모달, Method editor와 기존 Neo API.
- Produces: 실제 브라우저 검증 기록과 완료된 계획 체크.

- [x] Side의 New DBus Interface가 현재 Job 화면 위에서 목록 모달을 연다.
- [x] 사용자 Interface의 Add/Edit/Delete와 Method Add/Edit/Delete가 동작한다.
- [x] built-in과 참조 중 항목의 mutation control이 disabled이며 이유가 보인다.
- [x] Close, Esc, 바깥 클릭 뒤 현재 Job route가 유지된다.

- [x] **Step 1: 선택 LS 빌드와 화면 확인 전 테스트가 통과하는지 확인한다.**

  Run: `cd frontend && npm run test:layout && npm run build:root -- --with-ls-interface`

  Expected: PASS 및 exit 0.

- [x] **Step 2: 실제 Neo 배포본에서 모달 흐름을 확인한다.**

  브라우저에서 `http://192.168.1.55:5654/public/neo-pkg-dbus/`를 열고, 기존 integration Job을 선택한 상태에서 위 네 체크를 수행한다. 사용자 test Interface는 검증 직후 삭제한다. built-in LS Interface와 실행 중인 Job의 참조는 변경하지 않는다.

- [x] **Step 3: 결과를 기록하고 완료 체크를 갱신한다.**

  실제 요청 성공, disabled control, 현재 route 유지 여부를 계획의 네 체크에 각각 반영한다. 실패한 항목은 체크하지 않고 오류 응답·재현 단계와 함께 남긴다.

- [x] **Step 4: 검증 기록을 커밋한다.**

  ```bash
  git add docs/superpowers/plans/2026-08-05-dbus-interface-modal-management.md
  git commit -m "test: verify dbus interface modal management"
  ```
