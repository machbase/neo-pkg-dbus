# Job Default Name and Collapsible Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 새 Job에 충돌하지 않는 `job-N` 기본 이름을 제안하고 Job Configuration을 읽기 전용 summary가 있는 기본 접힘 panel로 바꾼다.

**Architecture:** `frontend/src/model.js`의 순수 함수가 이미 읽은 Job 목록에서 다음 이름을 계산한다. `JobForm`은 최초 목록 로딩이 끝난 새 Job route에만 그 값을 적용하고, 별도 state로 Job Configuration disclosure를 제어한다. Backend API와 저장 schema는 바꾸지 않는다.

**Tech Stack:** React 19, React Router, Vite SSR test harness, Node.js `assert`, `react-test-renderer`, CSS design tokens

## Global Constraints

- 자동 이름 대상은 정규식 `^job-([1-9][0-9]*)$`와 일치하는 현재 Job뿐이다.
- 별도 Job 목록 요청, Backend last counter, 새 API를 만들지 않는다.
- New/Edit Job Configuration은 기본 접힘이며 summary는 Job Name, Run Interval, Save Policy를 읽기 전용 텍스트로 표시한다.
- Edit Job Name 불변 계약과 Job 저장 payload는 바꾸지 않는다.
- generic과 LS는 같은 공통 구현을 사용한다.
- `DESIGN.md`에 없는 색상·간격·크기를 추가하지 않는다.
- `frontend/neo-proxy.json`은 수정하거나 커밋하지 않는다.
- 커밋 직전 인자 없는 `npm run build`를 실행하고 Git 산출물은 generic이어야 한다.

---

### Task 1: 다음 Job 기본 이름 계산

**Files:**
- Modify: `frontend/src/model.js`
- Test: `frontend/tests/model-contract.test.mjs`

**Interfaces:**
- Consumes: `jobs: Array<{name?: string}>`
- Produces: `nextDefaultJobName(jobs): string`

- [ ] **Step 1: 모델 실패 테스트 작성**

`frontend/tests/model-contract.test.mjs` import에 `nextDefaultJobName`을 추가하고 다음 assertion을 작성한다.

```js
assert.equal(nextDefaultJobName([]), "job-1");
assert.equal(nextDefaultJobName([{ name: "job-1" }, { name: "job-2" }]), "job-3");
assert.equal(nextDefaultJobName([{ name: "job-1" }, { name: "job-3" }]), "job-4");
assert.equal(nextDefaultJobName([
  { name: "collector-a" }, { name: "job-a" }, { name: "job-0" }, { name: "job-01" },
]), "job-1");
```

- [ ] **Step 2: 실패 확인**

Run: `node frontend/tests/model-contract.test.mjs`

Expected: `nextDefaultJobName` export가 없어 FAIL.

- [ ] **Step 3: 최소 모델 구현**

`frontend/src/model.js`에 다음 순수 함수를 추가한다.

```js
export function nextDefaultJobName(jobs = []) {
  const maximum = jobs.reduce((current, job) => {
    const match = /^job-([1-9][0-9]*)$/.exec(String(job?.name || ""));
    if (!match) return current;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? Math.max(current, value) : current;
  }, 0);
  return `job-${maximum + 1}`;
}
```

- [ ] **Step 4: 모델 GREEN 확인**

Run: `node frontend/tests/model-contract.test.mjs`

Expected: `model contract tests passed`.

- [ ] **Step 5: Task 1 커밋**

```bash
npm run build
git add frontend/src/model.js frontend/tests/model-contract.test.mjs index.html main.html side.html
git commit -m "feat: suggest the next job name"
```

---

### Task 2: 새 Job에 기본 이름을 한 번만 적용

**Files:**
- Modify: `frontend/src/App.jsx`
- Test: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: `nextDefaultJobName(app.jobs)`, `app.loading`, `app.error`
- Produces: 새 Job route에서 목록 로딩 후 한 번만 채워지는 수정 가능한 `name` draft

- [ ] **Step 1: 초기화 경계 실패 테스트 작성**

`frontend/tests/app-contract.test.mjs`의 source contract에 다음 조건을 추가한다.

```js
assert.match(source, /nextDefaultJobName\(app\.jobs\)/);
assert.match(source, /if \(editing \|\| app\.loading \|\| app\.error/);
assert.match(source, /defaultNameApplied\.current/);
assert.match(source, /nameEdited\.current/);
assert.match(source, /nameEdited\.current = true; setName\(value\.toLowerCase\(\)\)/);
```

- [ ] **Step 2: 실패 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: 기본 이름 초기화 source가 없어 FAIL.

- [ ] **Step 3: 최초 목록에만 이름 적용**

`frontend/src/App.jsx`에서 `nextDefaultJobName`을 import하고 `JobForm`에 두 ref를 추가한다.

```js
const defaultNameApplied = useRef(false);
const nameEdited = useRef(false);
```

route 초기화 effect에서는 두 ref를 초기화하고 이름을 비운다.

```js
defaultNameApplied.current = editing;
nameEdited.current = false;
setName("");
```

별도 effect는 새 Job 목록이 준비된 첫 시점에만 이름을 채운다.

```js
useEffect(() => {
  if (editing || app.loading || app.error || defaultNameApplied.current || nameEdited.current) return;
  setName(nextDefaultJobName(app.jobs));
  defaultNameApplied.current = true;
}, [app.error, app.jobs, app.loading, editing, params.name]);
```

Job Name 입력은 사용자가 건드렸음을 기록한 뒤 기존 소문자 정규화를 유지한다.

```jsx
onChange={(value) => {
  nameEdited.current = true;
  setName(value.toLowerCase());
}}
```

- [ ] **Step 4: 초기화 GREEN 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: App contract 전체 PASS. 기존 Edit Name `readOnly`/`disabled` assertion도 유지.

- [ ] **Step 5: Task 2 커밋**

```bash
npm run build
git add frontend/src/App.jsx frontend/tests/app-contract.test.mjs index.html main.html side.html
git commit -m "feat: initialize new job names from the job list"
```

---

### Task 3: Job Configuration 기본 접힘과 summary

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: `name`, `config.schedule.intervalMs`, `config.execution.savePolicy`
- Produces: `jobConfigurationOpen: boolean`, 읽기 전용 summary, 기존 여섯 form control

- [ ] **Step 1: disclosure 실패 테스트 작성**

`frontend/tests/app-contract.test.mjs`에 다음 source/style 계약을 추가한다.

```js
assert.match(source, /const \[jobConfigurationOpen, setJobConfigurationOpen\] = useState\(false\);/);
assert.match(source, /label="Toggle Job Configuration"[^>]*aria-expanded=\{jobConfigurationOpen\}/);
assert.match(source, /className="neo-job-configuration-summary"/);
assert.match(source, /\{name \|\| "—"\}/);
assert.match(source, /\{config\.schedule\.intervalMs\} ms/);
assert.match(source, /\{config\.execution\.savePolicy\}/);
assert.match(source, /\{jobConfigurationOpen \? <div className="neo-form-grid">/);
assert.match(source, /setJobConfigurationOpen\(false\);/);
assert.match(styles, /\.neo-job-configuration-summary/);
```

- [ ] **Step 2: 실패 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: disclosure state와 summary markup이 없어 FAIL.

- [ ] **Step 3: disclosure markup 구현**

`JobForm`에 기본 false state를 추가하고 route 초기화 때 다시 false로 만든다.

```js
const [jobConfigurationOpen, setJobConfigurationOpen] = useState(false);
```

기존 Job Configuration section을 다음 구조로 바꾼다.

```jsx
<section className="neo-panel">
  <div className="neo-panel__title neo-job-configuration-title">
    <h2>JOB CONFIGURATION</h2>
    <div className="neo-job-configuration-summary" aria-label="Job Configuration summary">
      <span>{name || "—"}</span>
      <span>{config.schedule.intervalMs} ms</span>
      <span>{config.execution.savePolicy}</span>
    </div>
    <IconButton
      icon={jobConfigurationOpen ? "expand_less" : "expand_more"}
      label="Toggle Job Configuration"
      aria-expanded={jobConfigurationOpen}
      onClick={() => setJobConfigurationOpen((open) => !open)}
    />
  </div>
  {jobConfigurationOpen ? <div className="neo-form-grid">{/* 기존 여섯 Field */}</div> : null}
</section>
```

summary에는 input/select/button을 넣지 않는다. toggle 버튼만 조작 가능하다.

- [ ] **Step 4: DESIGN 토큰만 사용해 summary 배치**

`frontend/src/styles.css`에 기존 토큰과 간격만 사용한다.

```css
.neo-job-configuration-title { align-items: center; }
.neo-job-configuration-summary {
  display: flex;
  min-width: 0;
  margin-left: auto;
  align-items: center;
  gap: 16px;
  color: var(--neo-text-secondary);
  font-size: 12px;
}
.neo-job-configuration-summary span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

작은 화면의 기존 media query 안에서는 summary가 줄바꿈되도록 `flex-wrap: wrap`을 사용한다.

- [ ] **Step 5: disclosure GREEN 확인**

Run: `node frontend/tests/app-contract.test.mjs`

Expected: App contract 전체 PASS.

- [ ] **Step 6: Frontend 전체 회귀 확인**

Run: `npm --prefix frontend test`

Expected: App, model, Data Viewer, build contract 모두 PASS. sandbox의 Vite WebSocket `EPERM` 경고는 exit code가 0이면 실패가 아니다.

- [ ] **Step 7: Task 3 커밋**

```bash
npm run build
git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/app-contract.test.mjs index.html main.html side.html
git commit -m "feat: collapse job configuration by default"
```

---

### Task 4: 제품 경계와 최종 산출물 검증

**Files:**
- Verify: `products/generic/frontend/index.jsx`
- Verify: `products/ls/frontend/index.jsx`
- Verify: `cgi-bin/product/index.js`
- Verify: `index.html`
- Verify: `main.html`
- Verify: `side.html`

**Interfaces:**
- Consumes: 공통 `JobForm`과 기본 build command
- Produces: generic Git 산출물과 generic/LS 공통 기능 검증 결과

- [ ] **Step 1: 제품 테스트 실행**

Run: `npm run test:products`

Expected: generic 자유 Job과 LS fixed Job 제품 테스트 전체 PASS.

- [ ] **Step 2: LS 빌드 확인**

Run: `npm run build -- --target=ls`

Expected: build 성공, `cgi-bin/product/index.js`의 `target`이 `ls`, `cgi-bin/provider.json.id`가 `ls`.

- [ ] **Step 3: 최종 generic 빌드로 복구**

Run: `npm run build`

Expected: build 성공, `cgi-bin/product/index.js`의 `target`이 `generic`, `cgi-bin/provider.json` 없음, `cgi-bin/interfaces.d` 비어 있음.

- [ ] **Step 4: 전체 변경 검증**

Run: `node --test cgi-bin/tests/*.test.cjs && npm --prefix frontend test && npm run test:products && git diff --check`

Expected: 모든 명령 exit 0.

- [ ] **Step 5: 최종 상태 확인**

Run: `git status --short`

Expected: 구현과 generic HTML 변경만 남고 `frontend/neo-proxy.json`은 별도 unstaged 변경으로 유지된다. Provider 전용 생성 파일은 없다.
