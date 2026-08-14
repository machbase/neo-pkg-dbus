# Data Viewer Stable Notify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기본 `notify`를 전달하지 않은 Data Viewer도 태그 목록을 한 번만 불러와 표시한다.

**Architecture:** 모듈 범위의 안정적인 빈 알림 함수를 기본값으로 사용한다. 태그 로드 효과의 의존성은 그대로 두므로 실제로 전달된 알림 함수가 바뀌는 경우만 다시 실행된다.

**Tech Stack:** React, node:test, react-test-renderer.

## Global Constraints

- `frontend/neo-proxy.json`은 사용자 로컬 설정이므로 수정하거나 커밋하지 않는다.
- generic과 LS는 같은 공통 Data Viewer 소스를 사용한다.

---

### Task 1: Data Viewer 기본 알림 함수 안정화

**Files:**
- Modify: `frontend/src/data-viewer/DataViewerPage.jsx:931`
- Modify: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: 선택적 `notify(message, level)` prop.
- Produces: `notify` prop이 없을 때도 안정적인 기본 함수 참조.

- [ ] **Step 1: Write the failing test**

```js
test("Data Viewer는 기본 notify에서도 Tag를 한 번만 불러온다", async () => {
  let tagCalls = 0;
  tables.tags = async () => ({ tags: (tagCalls += 1, [{ id: "1", name: "TAG1" }]) });
  // notify prop 없이 mount한 뒤 TAG1 표시와 tagCalls === 1을 검증한다.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/app-contract.test.mjs`

Expected: `tagCalls`가 2 이상이어서 실패한다.

- [ ] **Step 3: Write minimal implementation**

```js
const NOOP_NOTIFY = () => {};

export default function DataViewerPage({ notify = NOOP_NOTIFY, ...props }) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/app-contract.test.mjs`

Expected: 테스트 전체 통과, 새 테스트의 요청 수는 1이다.

- [ ] **Step 5: Run full frontend verification**

Run: `npm --prefix frontend test && npm --prefix frontend run build`

Expected: 테스트와 generic build가 모두 성공한다.
