# LS Call 목록 스크롤과 Transform Stepper 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LS Method Call 목록은 8행에서 높이를 고정하고, Transform 숫자 입력은 공통 Stepper로 통일한다.

**Architecture:** 공통 `NumberStepper`가 최소값이 없는 숫자도 처리하게 확장한다. LS Call 목록의 스크롤은 목록 컨테이너와 선택 행 ref만 사용하며 Job 저장 데이터에는 상태를 추가하지 않는다.

**Tech Stack:** React, CSS, Node test runner, react-test-renderer, Vite

## Global Constraints

- generic 제품 동작과 Job 저장 payload를 바꾸지 않는다.
- Call 목록은 최대 8행, 9번째부터 내부 스크롤이다.
- Bias 음수와 기존 Transform 계산 범위를 유지한다.
- 기존 Design System 토큰만 사용한다.

---

### Task 1: 실패 테스트 추가

**Files:**
- Modify: `frontend/tests/ls-fixed-calls-editor.test.mjs`
- Modify: `frontend/tests/app-contract.test.mjs`

- [x] Transform Bias·Multiplier에 공통 증가·감소 버튼이 있고 Bias가 음수로 감소하는 테스트를 추가한다.
- [x] Call 목록이 8행 최대 높이와 내부 스크롤을 갖는 계약 테스트를 추가한다.
- [x] 대상 테스트를 실행해 기존 구현에서 실패하는 이유가 각각 기본 숫자 입력과 무제한 목록임을 확인한다.

### Task 2: 최소 구현

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/styles.css`

- [x] `NumberStepper`가 최소값 생략 시 음수까지 허용하도록 확장한다.
- [x] Bias·Multiplier 입력을 `NumberStepper`로 교체한다.
- [x] Call 목록을 8행 높이로 제한하고 `overflow-y: auto`를 적용한다.
- [x] 선택 Call이 바뀌면 해당 행에 `scrollIntoView({ block: "nearest" })`를 실행한다.
- [x] 대상 테스트를 실행해 통과시킨다.

### Task 3: 회귀 및 화면 검증

**Files:**
- Verify: `frontend/src/App.jsx`
- Verify: `frontend/src/styles.css`

- [x] Frontend와 제품 전체 테스트를 실행한다.
- [x] LS 화면에서 Call 9개를 만들고 목록 높이 고정, 내부 스크롤, 마지막 Call 노출을 확인한다.
- [x] Tags를 펼쳐 Bias·Multiplier 공통 화살표와 Bias 음수 입력을 확인한다.
- [x] `npm run build`로 기본 generic 산출물을 복원한다.
