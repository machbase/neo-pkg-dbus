# Job Lifecycle and Screen Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job을 만들면 즉시 Controller service까지 등록하고, Start/Stop 결과를 Side와 Main에 즉시 같은 상태로 보인다.

**Architecture:** Backend의 create mutation은 설정 저장 뒤 Neo Controller install을 같은 operation lock 안에서 수행한다. Frontend는 Job 상태 변경을 revision으로 알리고 Side 목록과 Main 상세가 그 revision을 구독해 재조회한다. 목록이 이미 있으면 새로 읽는 동안 목록을 유지한다.

**Tech Stack:** Node.js CGI, Neo Controller API, React, BroadcastChannel, node:test, Vite.

## Global Constraints

- Neo 서버 모듈은 수정하지 않는다.
- Job 생성 성공 상태는 `installed` / `stopped`다.
- Start/Stop 중 Side 목록 전체를 로딩 상태로 바꾸지 않는다.
- 계약 문서 `DBUS_SDD.md`, `FE_DESIGN.md`, `BE_DESIGN.md`를 같은 생명주기 규칙으로 갱신한다.
- `frontend/neo-proxy.json`과 사용자가 작성한 기존 계획 문서는 수정·커밋하지 않는다.

---

### Task 1: 자동 설치 Job 생성 계약과 Backend

**Files:**
- Modify: `cgi-bin/src/jobs/manager.js`
- Modify: `cgi-bin/tests/job-api.test.cjs`
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/BE_DESIGN.md`

**Interfaces:**
- Consumes: `JobManager.create({ name, config }, callback)`와 Controller `install`.
- Produces: 성공한 `POST /job`의 `configState: "installed"`, `executionState: "stopped"`.

- [x] **Step 1: 자동 설치 성공과 설치 실패 정리 테스트를 작성한다.**
- [x] **Step 2: 새 테스트가 기존 create 구현에서 실패하는지 실행한다.**
- [x] **Step 3: create가 설정 저장 후 service를 install하고, install 실패면 생성한 설정을 지우는 최소 구현을 작성한다.**
- [x] **Step 4: Backend Job 테스트를 실행한다.**
- [x] **Step 5: 공개 API와 오류 규칙을 계약 문서에 기록한다.**

### Task 2: Install 없는 화면과 Side/Main 상태 동기화

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/model.js`
- Modify: `frontend/src/api.js`
- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `frontend/tests/api-channel-contract.test.mjs`
- Modify: `docs/specs/FE_DESIGN.md`

**Interfaces:**
- Consumes: Job 목록·상세 API 및 `BroadcastChannel`의 `refresh` 메시지.
- Produces: Install 버튼/API/아이콘이 없고, 상태 mutation 뒤 Side 목록과 Main 상세가 다시 읽힌다.

- [x] **Step 1: 설치 전용 UI/API가 남아 있지 않고 refresh 신호가 상세 재조회를 유발하는 실패 테스트를 작성한다.**
- [x] **Step 2: 새 테스트가 현 구현에서 실패하는지 실행한다.**
- [x] **Step 3: Install 액션을 제거하고, refresh revision과 mutation 중인 Job 이름으로 상태 동기화를 구현한다.**
- [x] **Step 4: 기존 Job이 있는 refresh에는 Loading jobs 문구 대신 기존 목록을 유지하도록 수정한다.**
- [x] **Step 5: Frontend 테스트를 실행한다.**

### Task 3: 패키지 산출물과 회귀 확인

**Files:**
- Modify: `index.html`
- Modify: `main.html`
- Modify: `side.html`

**Interfaces:**
- Consumes: Frontend source와 build script.
- Produces: Neo가 실제로 여는 세 HTML에 같은 화면 동작.

- [x] **Step 1: CGI 전체 테스트를 실행한다.**
- [x] **Step 2: Frontend 전체 테스트를 실행한다.**
- [x] **Step 3: `npm --prefix frontend run build:root -- --with-ls-interface`로 세 HTML을 다시 만든다.**
- [ ] **Step 4: 변경 파일·계약·테스트 결과를 다시 확인하고 하나의 커밋을 만든다.**
