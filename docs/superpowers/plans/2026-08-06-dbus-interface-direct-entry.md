# DBus Interface 직접 입력 선택 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover 결과 목록의 마지막 항목에서 직접 입력 모드로 전환하게 한다.

**Architecture:** Interface 이름 입력은 기본 폼에서 제거한다. Discover 결과 목록에는 마지막 `Direct input` 값을 추가하고, 선택하면 수동 Interface 입력 필드를 보인다. 실제 Interface를 선택하면 발견한 Interface와 Method를 단일 저장 draft에 반영한다.

**Tech Stack:** React 19, react-test-renderer, 기존 DBus Interface API.

## Global Constraints

- Discover는 저장하지 않고 footer의 단일 `Save Interface`만 사용한다.
- 목록의 실제 발견 Interface가 항상 `Manual entry`보다 먼저 나온다.
- 수동 입력은 Introspection 실패 시에도 사용할 수 있다.
- 새 색·간격·컴포넌트를 만들지 않고 `DESIGN.md`의 기존 입력·버튼을 사용한다.

---

### Task 1: Discover 목록의 수동 입력 전환

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `docs/specs/FE_DESIGN.md`
- Modify: `docs/specs/DBUS_SDD.md`

**Consumes:** `Discovered Interface` select의 `discovered[]`, `selectedDiscoveredId`, `selectDiscovered(id)` 상태.

**Produces:** 마지막 option 값 `__manual__`을 선택하면 `manualEntry === true`이고 Interface 입력과 `DbusMethodEditor`가 보이는 폼.

- [x] **Step 1: 실패하는 화면 계약 테스트 작성**

```js
assert.match(source, /value="__manual__"/);
assert.match(source, /Direct input/);
assert.ok(source.indexOf('Direct input') > source.indexOf('discovered.map'));
```

- [x] **Step 2: 테스트가 실패하는지 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: `Direct input` 관련 assertion 실패.

- [x] **Step 3: 최소 화면 구현**

```jsx
<option value="__manual__">Manual entry</option>
```

`selectDiscovered('__manual__')`는 발견된 draft를 선택하지 않고 `manualEntry`를 켠다. 기본 Interface 입력은 숨기고 `manualEntry`일 때만 보인다. Method editor도 수동 모드에서 보인다.

- [x] **Step 4: 테스트 통과 확인**

Run: `npm test`

Expected: frontend 계약 테스트 전체 PASS.

- [x] **Step 5: 계약 문서 갱신**

Discover 선택 목록의 마지막 `Manual entry` 항목과 수동 입력 전환 규칙을 `FE_DESIGN.md`, `DBUS_SDD.md`에 기록한다.

- [x] **Step 6: 전체 검증**

### Task 2: 선택한 Method 확인과 ID 유지

- [x] **Step 1: 실패하는 계약 테스트 작성** — 선택 Method 표시, 기존 ID 유지, 안내 문구 제거를 검증한다.
- [x] **Step 2: 실패 확인** — Discover 선택 뒤 입력 ID가 발견 ID로 바뀌는 실패를 확인했다.
- [x] **Step 3: 최소 구현** — ID가 비었을 때만 발견 ID를 제안하고, 선택 Method의 읽기 전용 상세를 모달에 표시한다.
- [x] **Step 4: 계약·회귀 검증** — `frontend/tests/app-contract.test.mjs`가 통과한다.

Run: `node --test cgi-bin/tests/*.test.cjs` and `npm test`

Expected: backend 82개와 frontend 계약 테스트 전체 PASS.
