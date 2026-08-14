# Job Logging Controls and Live Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DBus Job 상세에 OPC UA 형식의 Logging Controls, Live Logs 패널, 아이콘과 의미 색을 가진 상단 동작 버튼을 공통 기능으로 추가한다.

**Architecture:** `JobDetail`은 현재 Job과 패널 open 상태만 소유하고, 로그 표시·polling·drag·resize는 새 `LiveLogs` 컴포넌트로 분리한다. Backend는 변경하지 않고 기존 `/log/list`, `/log/tail` JSON API를 1초 polling으로 사용한다. 순수 로그 모델 함수는 별도 모듈로 분리해 level·active file·clear 이후 표시 줄을 DOM 없이 검증한다.

**Tech Stack:** React 19, React Router 7, Vite 6, Node test runner, react-test-renderer, 기존 Material Symbols와 `DESIGN.md` 토큰

## Global Constraints

- Generic과 LS 제품에 같은 공통 화면을 적용한다.
- 새 Backend endpoint, SSE, WebSocket과 외부 dependency를 추가하지 않는다.
- `GET /log/list?name=`과 필수 `name`, `file`을 가진 `GET /log/tail` 계약을 유지한다.
- Live Logs는 1초 polling, 최대 100줄, 460×360px 기본 크기, 320×220px 최소 크기를 사용한다.
- 상단 순서는 Live Logs, Data Viewer, Edit, Delete다.
- 기존 Edit/Delete 비활성 규칙과 `/logs/:name` 저장 로그 화면을 유지한다.
- 색상·간격·반경·아이콘은 `DESIGN.md`와 OPC UA 원본에 정의된 값만 사용한다.
- 커밋 전 루트에서 인자 없는 `npm run build`로 Generic 산출물을 복원하고 성공을 확인한다.
- `frontend/neo-proxy.json`과 `implementation-ls-device-string-picker.png`는 사용자 변경이므로 수정·스테이징하지 않는다.

---

### Task 1: 승인된 계약 문서 반영

**Files:**
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/FE_DESIGN.md`
- Modify: `docs/specs/BE_DESIGN.md`
- Test: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: 승인된 설계 `docs/superpowers/specs/2026-08-14-job-logging-controls-live-logs-design.md`
- Produces: CCR-070, Job 상세 로그 UX와 기존 JSON API 유지 계약

- [ ] **Step 1: 계약을 검증하는 실패 테스트 작성**

`frontend/tests/app-contract.test.mjs`에 문서와 화면 source가 다음 문자열을 가져야 한다는 검증을 추가한다.

```js
test("Job detail은 Logging Controls와 polling Live Logs 계약을 사용한다", () => {
  const sdd = fs.readFileSync(new URL("../../docs/specs/DBUS_SDD.md", import.meta.url), "utf8");
  const feDesign = fs.readFileSync(new URL("../../docs/specs/FE_DESIGN.md", import.meta.url), "utf8");
  const beDesign = fs.readFileSync(new URL("../../docs/specs/BE_DESIGN.md", import.meta.url), "utf8");
  assert.match(sdd, /CCR-070/);
  assert.match(feDesign, /1초마다.*\/log\/tail/);
  assert.match(beDesign, /새 endpoint를 추가하지 않는다/);
});
```

- [ ] **Step 2: RED 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: `CCR-070` 또는 Live Logs 계약 문구가 없어서 FAIL.

- [ ] **Step 3: 계약 문서 최소 수정**

`DBUS_SDD.md` 변경 기록에 다음을 고정한다.

```text
CCR-070: 상단 Logs를 Live Logs로 대체하고, 저장 로그는 Logging Controls의 View Logs에서 연다.
Live Logs는 기존 JSON /log/list와 /log/tail을 1초 polling하며 SSE를 추가하지 않는다.
```

`FE_DESIGN.md`에는 버튼 순서·Logging Controls·최대 100줄·Pause/Clear/drag/resize·오류 복구를 기록한다. `BE_DESIGN.md`에는 API 변경이 없고 기존 필수 `name`, `file`과 응답 `lines`, `totalLines`를 그대로 사용한다고 기록한다. `DBUS_SDD.md`의 기존 `/log/tail` 응답이 `{name,file,content}`로 묶여 있으면 실제 공개 응답 `{name,file,lines,totalLines}`로 바로잡고, `/log/content`의 `{name,file,content}`와 행을 분리한다.

- [ ] **Step 4: GREEN 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: PASS.

---

### Task 2: Live Logs 순수 모델

**Files:**
- Create: `frontend/src/live-logs/liveLogsModel.js`
- Create: `frontend/src/live-logs/liveLogsModel.test.mjs`
- Modify: `frontend/package.json`

**Interfaces:**
- Consumes: `/log/list`의 `{files:[{name,active}]}`, `/log/tail`의 `{file,lines,totalLines}`
- Produces: `recordedLevels(level)`, `activeLogFile(files)`, `visibleTail(snapshot, clearState, maximum=100)`, `nextClearState(tail)`

- [ ] **Step 1: 순수 모델 실패 테스트 작성**

```js
test("info level은 INFO WARN ERROR를 기록한다", () => {
  assert.deepEqual(recordedLevels("info"), ["INFO", "WARN", "ERROR"]);
});

test("active 파일을 고르고 tail을 마지막 100줄로 제한한다", () => {
  assert.equal(activeLogFile([{ name: "old.log" }, { name: "job.log", active: true }]), "job.log");
  const lines = Array.from({ length: 120 }, (_, index) => `line-${index}`);
  assert.deepEqual(visibleTail({ file: "job.log", lines, totalLines: 120 }, null), lines.slice(20));
});

test("clear 뒤 추가된 줄만 보이고 truncation은 새 snapshot으로 처리한다", () => {
  const clear = nextClearState({ file: "job.log", totalLines: 5 });
  assert.deepEqual(visibleTail({ file: "job.log", lines: ["4", "5", "6"], totalLines: 6 }, clear), ["6"]);
  assert.deepEqual(visibleTail({ file: "job.log", lines: ["new"], totalLines: 1 }, clear), ["new"]);
});
```

- [ ] **Step 2: RED 확인**

Run: `node --test frontend/src/live-logs/liveLogsModel.test.mjs`

Expected: module 또는 export가 없어 FAIL.

- [ ] **Step 3: 최소 모델 구현**

```js
export const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

export function recordedLevels(level) {
  const index = LOG_LEVELS.indexOf(String(level || "info").toUpperCase());
  return LOG_LEVELS.slice(index < 0 ? 2 : index);
}

export function activeLogFile(files = []) {
  return files.find((file) => file?.active)?.name || "";
}
```

`visibleTail`은 clear의 file과 `totalLines`를 비교해 추가분만 자른 뒤 마지막 `maximum`줄을 반환한다. 파일 변경 또는 `totalLines` 감소는 clear 기준을 무효화한다.

- [ ] **Step 4: GREEN 및 frontend test script 연결**

Run: `node --test frontend/src/live-logs/liveLogsModel.test.mjs`

Expected: PASS.

`frontend/package.json`의 `test:layout` 끝에 새 test를 추가하고 `npm --prefix frontend test`가 PASS인지 확인한다.

---

### Task 3: Live Logs polling 및 패널 컴포넌트

**Files:**
- Create: `frontend/src/live-logs/LiveLogs.jsx`
- Create: `frontend/tests/live-logs.test.mjs`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/package.json`

**Interfaces:**
- Consumes: `api.logs.list(name, options)`, `api.logs.tail(name, file, options)`, Task 2 모델 함수
- Produces: `<LiveLogs jobName open onClose />`
- Test seam: 선택 prop `logsApi=api.logs`, `schedule=setTimeout`, `cancelSchedule=clearTimeout`; `JobDetail`에서는 기본값만 사용한다.

- [ ] **Step 1: polling·정리·버튼 동작 실패 테스트 작성**

`react-test-renderer`와 선택적으로 주입 가능한 `logsApi`, `schedule`, `cancelSchedule` prop을 사용한다. 실제 제품 호출은 이 prop을 넘기지 않아 기본 `api.logs`, `setTimeout`, `clearTimeout`을 사용한다.

```js
test("open 시 active file을 찾아 tail을 읽고 close 시 timer를 정리한다", async () => {
  const calls = [];
  const logsApi = {
    list: async () => ({ files: [{ name: "job.log", active: true }] }),
    tail: async (_name, file) => (calls.push(file), { file, lines: ["[INFO] ready"], totalLines: 1 }),
  };
  // render, effect flush
  assert.deepEqual(calls, ["job.log"]);
  assert.equal(root.findByProps({ "aria-label": "Live log lines" }).children.join(""), "[INFO] ready");
  // unmount
  assert.equal(cancelled, true);
});
```

별도 테스트로 Pause가 결과 반영을 멈추고 Resume이 즉시 다시 읽는지, Clear가 이후 줄만 보이게 하는지, Close가 `onClose`를 호출하는지 검증한다.

- [ ] **Step 2: RED 확인**

Run: `node --test frontend/tests/live-logs.test.mjs`

Expected: `LiveLogs.jsx`가 없어 FAIL.

- [ ] **Step 3: 최소 polling 컴포넌트 구현**

`LiveLogs`는 open일 때 `AbortController` 하나와 1초 timer 하나만 만든다. 각 tick은 active file이 없으면 list를 다시 읽고, 있으면 tail을 읽는다. 요청 성공은 connected, 실패는 disconnected로 표시하고 기존 줄을 보존한다.

Header는 `terminal`, 상태 dot, 상태 문구, `N/100`, Pause/Resume, Clear, Close를 표시한다. 본문은 각 로그 줄의 level 토큰에 class를 적용한다.

- [ ] **Step 4: drag·resize·viewport clamp 구현과 source 계약 테스트**

OPC UA의 검증된 mouse move/up 정리 구조를 이식한다. 크기 상수는 460×360, 최소 320×220, viewport margin 24다. header의 button을 누른 경우 drag를 시작하지 않는다. 오른쪽·아래·오른쪽 아래 handle만 resize한다.

`frontend/tests/live-logs.test.mjs`에서 상수, handle class와 event listener cleanup을 검증한다.

- [ ] **Step 5: GREEN 확인**

Run: `node --test frontend/tests/live-logs.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend test`

Expected: 전체 PASS.

---

### Task 4: Job 상세 연결과 OPC UA 버튼·Logging Controls 디자인

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: `<LiveLogs jobName open onClose />`, `recordedLevels(config.log.level)`
- Produces: 상단 action bar와 `neo-logging-controls`

- [ ] **Step 1: Job 상세 실패 테스트 작성**

```js
test("Job detail actions와 Logging Controls는 OPC UA 순서와 아이콘을 사용한다", () => {
  assert.match(source, /terminal.*Live Logs[\s\S]*query_stats.*Data Viewer[\s\S]*edit.*Edit[\s\S]*delete.*Delete/);
  assert.doesNotMatch(source, />Logs<\/Link>/);
  assert.match(source, /LOGGING CONTROLS/);
  assert.match(source, /description.*View Logs/);
});
```

CSS 검증은 Primary outline, danger, 한 줄 Logging Controls, level badge와 Live Logs panel이 `DESIGN.md` 토큰을 사용하는지 확인한다.

- [ ] **Step 2: RED 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: 기존 Logs 텍스트 버튼과 Logging Controls 부재로 FAIL.

- [ ] **Step 3: JobDetail 최소 연결 구현**

`JobDetail`에 `liveLogsOpen` state를 추가한다. 헤더 action을 다음처럼 구성한다.

```jsx
<button className="neo-button" onClick={() => setLiveLogsOpen(true)}><Icon name="terminal" />Live Logs</button>
<Link className="neo-button neo-button--primary-outline" to={...}><Icon name="query_stats" />Data Viewer</Link>
<Link className="neo-button" ...><Icon name="edit" />Edit</Link>
<button className="neo-button neo-button--danger" ...><Icon name="delete" />Delete</button>
```

`LATEST RUN` 아래 Logging Controls에 level 배지, `Records ... messages`, file limit, `View Logs`를 표시한다. 마지막에 `<LiveLogs jobName={name} open={liveLogsOpen} onClose={() => setLiveLogsOpen(false)} />`를 렌더링한다.

- [ ] **Step 4: OPC UA 원본에 맞춘 CSS 구현**

`neo-logging-controls`는 16px 세로 padding, 24px group gap, wrap 가능한 한 줄 카드다. Primary outline은 투명 배경·primary border/text이며 hover 시 기존 interactive-hover를 사용한다. Live Logs는 fixed panel, 기존 panel/elevated/input surface와 4px radius를 쓴다. level 색은 기존 success/warning/error 토큰과 OPC UA 원본 색을 매핑한다.

- [ ] **Step 5: GREEN 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend test`

Expected: 전체 PASS.

---

### Task 5: 제품 경계·빌드·브라우저 디자인 QA

**Files:**
- Create: `design-qa-live-logs.md`
- Test: `tests/product-build.test.cjs`
- Test: `tests/product-modules.test.mjs`
- Test: `frontend/tests/build-ls-interface.test.mjs`

**Interfaces:**
- Consumes: 완성된 공통 frontend와 승인된 OPC UA 원본 screenshot
- Produces: Generic·LS 경계 검증과 시각 QA 결과

- [ ] **Step 1: 자동 회귀 테스트 실행**

Run: `npm --prefix frontend test`

Expected: 전체 PASS.

Run: `npm run test:products`

Expected: 전체 PASS.

Run: `node --test cgi-bin/tests/*.test.cjs`

Expected: 전체 PASS.

- [ ] **Step 2: LS 임시 빌드로 공통 기능 경계 확인**

Run: `npm run build -- --target=ls`

Expected: 성공하고 LS Job 상세에도 Logging Controls와 Live Logs 문자열·스타일이 존재한다.

- [ ] **Step 3: Generic root build 복원**

Run: `npm run build`

Expected: 성공하고 root 산출물에 `provider.json`과 LS 전용 Interface가 없으며 Logging Controls와 Live Logs는 존재한다.

- [ ] **Step 4: 사용자가 선택한 in-app Browser에서 기능 검증**

Job 상세에서 다음을 직접 확인한다.

1. 상단 버튼 순서·아이콘·색·disabled 상태
2. Logging Controls의 INFO/WARN/ERROR와 File Limit
3. View Logs route
4. Live Logs open, 1초 갱신, Pause/Resume, Clear, Close
5. header drag, 세 resize handle, viewport clamp
6. route 이동 뒤 polling 정리와 console 오류 부재

- [ ] **Step 5: 동일 viewport 시각 비교와 QA 기록**

OPC UA `docs/images/opcua-job-detail.png`의 Logging Controls/Live Logs와 DBus Job 상세를 같은 viewport/state로 캡처해 비교한다. `design-qa-live-logs.md`에 P0~P3 차이와 `final result: passed|blocked`를 기록한다. P0/P1/P2는 수정하고 다시 캡처한다.

- [ ] **Step 6: 최종 diff와 커밋 전 Generic build 확인**

Run: `git diff --check`

Expected: 출력 없음.

Run: `npm run build`

Expected: 성공. `frontend/neo-proxy.json`, 기존 이미지와 LS build 산출물은 staged diff에 없어야 한다.
