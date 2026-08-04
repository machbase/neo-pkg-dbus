# Job Mutation Serialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 Job의 Update, API lifecycle/Delete, package stop/uninstall 요청을 안전하게 직렬화하고, 오래된 revision이나 잠금 소유권 상실이 실행 중 설정 변경·삭제 후 파일 복구를 만들지 못하게 한다.

**Architecture:** Job별 operation lock directory를 원자적으로 생성하고 owner token과 heartbeat로 소유권을 확인한다. Create, Install, Start, Stop, Update, Delete는 상태 확인부터 Controller 호출과 파일 변경이 끝날 때까지 같은 Job lock을 사용한다. Package stop/uninstall은 lifecycle fence와 대상 Job lock 전체를 작업 끝까지 유지한다. API mutation은 lock을 만들거나 회수하지 않는 availability probe로 fence 상태를 두 번 확인해 package 시작과 Job lock 획득 사이의 시간차를 막고, 서로 다른 Job API는 병렬로 진행한다. Stale fence의 실제 회수는 package exclusive acquire만 수행한다. `revision`은 사용자 draft의 낙관적 동시성 제어를 계속 맡고 lock은 CGI 및 package lifecycle 요청끼리의 실제 경쟁을 막는다.

**Tech Stack:** Machbase Neo JSH CommonJS, Node-compatible `fs`/`path`/`process`, JSON CGI API, React 19, Node test runner, Vite single-file build

## Global Constraints

- 최소 Neo 버전은 `8.5.6`, Job `schemaVersion`은 `1`이다.
- 서비스 이름은 `_dbu_<jobName>`이고 같은 Job의 이름은 생성 후 바꾸지 않는다.
- 실행 중이거나 전환 중인 Job은 수정·삭제할 수 없다.
- CGI는 요청 하나를 처리한 뒤 모든 heartbeat timer를 정리하고 종료한다.
- 성공 응답은 `{ok:true,data}`, 실패 응답은 `{ok:false,code,reason,details}`다.
- Job GET/create/update 응답은 정수 `revision`을 포함하고 PUT은 GET에서 받은 revision을 보낸다.
- `JOB_REVISION_REQUIRED`는 HTTP 400, `JOB_CONFLICT`는 HTTP 409다.
- DB 비밀번호, 원본 설정, DBus 원본 body를 lock 파일·로그·오류 응답에 기록하지 않는다.
- `DESIGN.md`는 수정하지 않으며 UI 스타일 값도 추가하지 않는다.
- 커밋 author/committer는 `max-kim <max.kim@machbase.com>`을 사용한다.

---

### Task 1: 동시 작업 계약 확정

**Files:**
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/BE_DESIGN.md`
- Modify: `docs/specs/FE_DESIGN.md`

**Interfaces:**
- Consumes: 현재 `revision`, `JOB_REVISION_REQUIRED`, `JOB_CONFLICT`, 실행 중 변경 금지 계약
- Produces: Task 2~4가 구현·검증할 Job mutation serialization과 lock lease 계약

- [ ] **Step 1: 통합 SDD에 operation lock 범위를 명시한다**

  `DBUS_SDD.md`의 동시 수정 결정과 Job API 규칙을 아래 의미로 교체한다.

  ```text
  같은 Job의 POST create/install/start/stop, PUT update, DELETE는 하나의 mutation operation이다.
  Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 operation lock을 유지한다.
  다른 mutation이 lock을 보유하면 HTTP 409 JOB_CONFLICT를 반환한다.
  GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다.
  ```

- [ ] **Step 2: lock 소유권과 회수 규칙을 명시한다**

  세 문서에 다음 계약을 같은 의미로 기록한다.

  ```text
  lock은 owner token과 heartbeat 시각을 가진다.
  owner는 CGI 요청이 끝날 때 heartbeat를 중지하고 자기 token의 lock만 해제한다.
  lease가 지났고 owner PID가 종료되었다고 확인된 lock만 고유 quarantine 이름으로 원자 이동한 뒤 회수한다.
  PID 생존 여부를 확인할 수 없으면 안전하게 회수하지 않고 JOB_CONFLICT를 반환한다.
  이전 owner는 side effect 직전 token을 다시 확인하며, 소유권을 잃었으면 JOB_CONFLICT로 중단한다.
  이전 owner는 새 owner의 lock을 갱신하거나 해제할 수 없다.
  ```

- [ ] **Step 3: 경쟁 상태별 결과를 표로 확정한다**

  `BE_DESIGN.md`에 아래 결과를 추가한다.

  | 먼저 실행된 요청 | 뒤 요청 | 결과 |
  |---|---|---|
  | PUT | PUT | 뒤 요청 `JOB_CONFLICT`; 앞 요청 성공 뒤 stale revision도 `JOB_CONFLICT` |
  | PUT | Start/Delete | 뒤 요청 `JOB_CONFLICT` |
  | Start/Stop | PUT | 뒤 요청 `JOB_CONFLICT` |
  | Delete | PUT/Create | 뒤 요청 `JOB_CONFLICT`; 삭제된 설정을 다시 만들지 않음 |
  | lease 회수 | 이전 owner 재개 | 이전 owner `JOB_CONFLICT`; side effect 금지 |

- [ ] **Step 4: 문서 일관성을 검사한다**

  Run:

  ```bash
  rg -n "operation lock|owner token|heartbeat|owner PID|JOB_CONFLICT|revision" docs/specs
  git diff --check
  ```

  Expected: 세 문서가 장기 UI 잠금이 아닌 요청 단위 operation lock을 설명하고, 단순히 “30초가 지나면 무조건 삭제”한다는 문구가 없다.

- [ ] **Step 5: 계약 문서를 커밋한다**

  ```bash
  GIT_CONFIG_GLOBAL=/dev/null git add docs/specs/DBUS_SDD.md docs/specs/BE_DESIGN.md docs/specs/FE_DESIGN.md
  GIT_CONFIG_GLOBAL=/dev/null git -c user.name='max-kim' -c user.email='max.kim@machbase.com' commit -m "docs: define job mutation serialization"
  ```

---

### Task 2: 소유권이 있는 Job operation lock 구현

**Files:**
- Create: `cgi-bin/src/jobs/operation-lock.js`
- Create: `cgi-bin/tests/job-operation-lock.test.cjs`

**Interfaces:**
- Consumes: 안전한 Job name, `cgiRoot`, Node-compatible filesystem
- Produces: `createJobOperationLock(options)`, `acquire(name)`, handle의 `assertOwned()`, `release()`, `token`

- [ ] **Step 1: lock 획득·충돌·자기 lock 해제 실패 테스트를 작성한다**

  `job-operation-lock.test.cjs`에 실제 임시 디렉터리를 사용해 다음 동작을 작성한다.

  ```js
  const locks = createJobOperationLock({
    directory,
    leaseMs: 30000,
    heartbeatMs: 5000,
    now: () => clock,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    isProcessAlive: (pid) => alivePids.has(pid),
    randomToken: () => tokens.shift(),
  });
  const first = locks.acquire('alpha');
  assert.throws(() => locks.acquire('alpha'), errorCode('JOB_CONFLICT'));
  assert.doesNotThrow(() => first.assertOwned());
  first.release();
  const second = locks.acquire('alpha');
  assert.equal(second.token, 'owner-b');
  second.release();
  ```

  별도 사례에서 owner A의 lock을 회수하고 owner B가 획득한 뒤 `A.release()`를 호출해도 B의 lock directory와 owner token이 유지되는지 검사한다.

- [ ] **Step 2: 테스트가 기대한 이유로 실패하는지 확인한다**

  Run:

  ```bash
  cd cgi-bin
  node --test tests/job-operation-lock.test.cjs
  ```

  Expected: FAIL with `Cannot find module '../src/jobs/operation-lock.js'`.

- [ ] **Step 3: lock directory와 owner token 저장을 구현한다**

  `operation-lock.js`는 아래 공개 형태를 구현한다.

  ```js
  function createJobOperationLock(options) {
    return {
      acquire(name) {
        // mkdirSync(<lockRoot>/<name>.lock)으로 원자 획득
        // owner.json에는 { token, pid, acquiredAt, heartbeatAt }만 기록
        // 비밀번호, Job config, 요청 body는 기록하지 않음
        return {
          token,
          assertOwned() {},
          release() {},
        };
      },
    };
  }
  ```

  lock root는 `cgi-bin/conf.d/.job-operation-locks`로 한다. `assertOwned()`는 현재 lock directory의 `owner.json` token이 handle token과 다르거나 파일이 없으면 `JOB_CONFLICT`를 던진다. `release()`는 timer를 먼저 멈추고 현재 token이 자기 token일 때만 `owner.json`과 lock directory를 제거한다.

- [ ] **Step 4: heartbeat와 안전한 stale 회수를 테스트로 추가한다**

  fake clock을 `30001ms` 이동해도 `isProcessAlive(ownerPid) === true`이면 회수하지 않고 `JOB_CONFLICT`인지 먼저 검사한다. 이후 `isProcessAlive(ownerPid) === false`로 바꾸면 stale lock directory를 `alpha.lock.reclaimed-<new-token>`으로 rename하여 회수하는지 검사한다. 회수 뒤 owner A의 heartbeat callback을 실행해도 owner B의 `owner.json`과 mtime이 바뀌지 않아야 하며, `A.assertOwned()`는 `JOB_CONFLICT`여야 한다. PID 생존 확인 adapter가 오류를 내는 경우도 회수하지 않아야 한다.

- [ ] **Step 5: heartbeat와 quarantine 회수를 최소 구현한다**

  heartbeat callback은 먼저 `assertOwned()`를 실행하고 자기 lock directory의 mtime만 갱신한다. stale 판정은 lock directory mtime 기준 `now() - mtimeMs >= leaseMs`지만, stale만으로는 회수하지 않는다. `isProcessAlive(pid)`가 명확히 `false`일 때만 아래 순서를 사용한다. 기본 adapter는 `process.kill(pid, 0)`을 사용하고 `ESRCH`만 종료로 판단하며, 권한 오류·미지원·그 밖의 오류는 살아 있거나 확인 불가로 처리한다.

  ```js
  fs.renameSync(lockDirectory, `${lockDirectory}.reclaimed-${token}`);
  fs.mkdirSync(lockDirectory);
  writeOwner(lockDirectory, owner);
  cleanupQuarantine(reclaimedDirectory);
  ```

  rename이 `ENOENT`로 실패하면 다른 요청이 먼저 회수한 것이므로 다시 획득을 시도한다. 새 lock을 얻지 못하면 `JOB_CONFLICT`다. owner가 살아 있는 동안은 lease 시간이 지나도 회수되지 않으므로, `assertOwned()` 직후 다른 CGI가 lock을 가져가는 시간 기반 경쟁을 만들지 않는다.

- [ ] **Step 6: lock 단위 테스트를 통과시킨다**

  Run:

  ```bash
  cd cgi-bin
  node --test tests/job-operation-lock.test.cjs
  ```

  Expected: PASS, timer와 임시 lock/quarantine directory가 테스트 종료 후 남지 않는다.

- [ ] **Step 7: lock 모듈을 커밋한다**

  ```bash
  GIT_CONFIG_GLOBAL=/dev/null git add cgi-bin/src/jobs/operation-lock.js cgi-bin/tests/job-operation-lock.test.cjs
  GIT_CONFIG_GLOBAL=/dev/null git -c user.name='max-kim' -c user.email='max.kim@machbase.com' commit -m "feat: add owned job operation lock"
  ```

---

### Task 3: 모든 Job mutation을 같은 lock으로 직렬화

**Files:**
- Modify: `cgi-bin/src/jobs/manager.js`
- Modify: `cgi-bin/src/jobs/repository.js`
- Modify: `cgi-bin/tests/job-manager.test.cjs`
- Modify: `cgi-bin/tests/job-validator-repository.test.cjs`

**Interfaces:**
- Consumes: `createJobOperationLock({directory}).acquire(name)`과 handle `assertOwned()/release()`
- Produces: 같은 Job의 `create`, `install`, `start`, `stop`, `stopForPackage`, `update`, `delete` 요청과 package lifecycle 직렬화

- [ ] **Step 1: PUT과 Start 경쟁 실패 테스트를 작성한다**

  `job-manager.test.cjs`의 fake database가 validation callback을 보관하도록 만들고 다음 순서를 검사한다.

  ```js
  const update = call(managerA, 'update', 'alpha', {
    revision: detail.revision,
    schedule: { intervalMs: 2000 },
  });
  await database.waitUntilValidationStarted();
  await rejectsCode(call(managerB, 'start', 'alpha'), 'JOB_CONFLICT');
  database.finishValidation();
  await update;
  ```

  Controller의 `start` 호출이 한 번도 실행되지 않았고 저장된 interval은 `2000`인지 확인한다.

- [ ] **Step 2: PUT과 Delete/Create 경쟁 실패 테스트를 작성한다**

  Update가 DB validation에서 멈춘 동안 다른 manager의 Delete와 Create가 `JOB_CONFLICT`인지 검사한다. Update 완료 뒤 파일이 정확히 하나 존재하고 revision이 2인지 확인한다. 별도 사례로 Delete가 Controller uninstall callback에서 멈춘 동안 PUT/Create가 충돌하고, Delete 완료 뒤 설정 파일이 다시 생기지 않는지 검사한다.

- [ ] **Step 3: 경쟁 테스트가 현재 구현에서 실패하는지 확인한다**

  Run:

  ```bash
  cd cgi-bin
  node --test tests/job-manager.test.cjs
  ```

  Expected: FAIL because Start/Delete/Create can enter while Update or Delete is pending.

- [ ] **Step 4: manager에 요청 단위 lock helper를 추가한다**

  constructor에서 같은 `cgiRoot`를 쓰는 manager들이 같은 lock root를 사용하게 한다.

  ```js
  this.operationLock = settings.operationLock || createJobOperationLock({
    directory: path.join(this.cgiRoot, 'conf.d', '.job-operation-locks'),
  });
  ```

  아래 helper로 callback이 성공·실패·동기 예외 중 어느 경로로 끝나도 한 번만 release한다.

  ```js
  withMutation(name, callback, operation) {
    let handle;
    try { handle = this.operationLock.acquire(name); }
    catch (failure) { callback(failure); return; }
    let finished = false;
    const done = (failure, value) => {
      if (finished) return;
      finished = true;
      handle.release();
      callback(failure, value);
    };
    try { operation(handle, done); } catch (failure) { done(failure); }
  }
  ```

- [ ] **Step 5: mutation public method 전체를 lock 범위에 넣는다**

  `create`, `install`, `start`, `stop`, `update`, `delete`의 첫 validation 이후 상태 조회 전에 `withMutation()`을 호출한다. `validate`, `get`, `list`, `lastRun`, `diagnostic`은 read-only이므로 lock을 잡지 않는다. 각 `repository.create/save/remove`와 Controller `install/start/stop/uninstall` 호출 직전에 `handle.assertOwned()`를 호출한다.

- [ ] **Step 6: repository의 개별 save lock을 제거한다**

  `repository.js`에서 `.save-lock`, `SAVE_LOCK_STALE_MS`, `acquireSaveLock()`을 제거한다. `save(name, document, expectedRevision)`은 operation lock 안에서 현재 document revision을 다시 읽고 비교한 뒤 `writeJsonAtomic()`만 수행한다. revision 불일치는 계속 아래 details를 가진다.

  ```json
  {
    "name": "alpha",
    "expectedRevision": 1,
    "currentRevision": 2
  }
  ```

- [ ] **Step 7: manager와 repository 테스트를 통과시킨다**

  Run:

  ```bash
  cd cgi-bin
  node --test tests/job-operation-lock.test.cjs tests/job-manager.test.cjs tests/job-validator-repository.test.cjs
  ```

  Expected: PASS; lock conflict 중 Controller와 repository mutation 호출 횟수는 0이다.

- [ ] **Step 8: mutation 직렬화를 커밋한다**

  ```bash
  GIT_CONFIG_GLOBAL=/dev/null git add cgi-bin/src/jobs/manager.js cgi-bin/src/jobs/repository.js cgi-bin/tests/job-manager.test.cjs cgi-bin/tests/job-validator-repository.test.cjs
  GIT_CONFIG_GLOBAL=/dev/null git -c user.name='max-kim' -c user.email='max.kim@machbase.com' commit -m "fix: serialize job mutation operations"
  ```

- [ ] **Step 9: package lifecycle 범위를 같은 lock으로 확장한다**

  API Start와 `stopForPackage()`의 양방향 경쟁을 실제 두 manager로 검증한다. `stopForPackage()`는 상태 조회부터 마지막 inspect까지 `withMutation()`을 유지하고 Controller stop 직전에 `assertOwned()`를 호출한다.

  Package stop은 stop 전 실행/전환 중인 `restartNames`와 상태가 알려진 전체 `targetNames`를 분리한다. Checkpoint에는 `restartNames`만 저장하고 모든 `targetNames`를 `stopForPackage()`로 검사한다.

  리뷰에서 발견된 전체 작업 사이 경쟁을 막기 위해 package stop/uninstall은 별도 lifecycle fence를 먼저 획득하고 대상 Job lock을 이름순으로 모두 잡는다. 첫 Job 처리 뒤에도 마지막 Job이 끝날 때까지 모든 lock을 유지한다. API mutation은 `read-only fence probe → Job lock 획득 → read-only fence probe` 순서를 사용해 TOCTOU를 막는다. Probe는 canonical 부재 또는 stale+dead owner를 available로 읽기만 하고, fresh/alive/PID 판정 오류는 충돌로 본다. Stale 회수는 package exclusive acquire만 수행한다. Reclaim rename의 canonical 부재 race에서도 replacement fence가 API의 두 번째 probe를 막거나, API Job lock이 package를 막으므로 안전하다. 일부 Job lock 획득이 실패하면 이미 잡은 lock과 fence를 모두 풀고, `PACKAGE_LIFECYCLE_FAILED.details.errors[]` 안에 `JOB_CONFLICT`를 보존한다. Session release 실패 때는 성공한 handle만 제거하고 실패 handle/fence를 보존해 같은 release를 재시도한다. 이 계약과 FE의 동일한 충돌 안내를 세 설계 문서에 기록한다.

---

### Task 4: 실제 CGI와 FE 충돌 계약 검증

**Files:**
- Modify: `cgi-bin/tests/job-api.test.cjs`
- Modify: `frontend/tests/api-channel-contract.test.mjs`
- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `frontend/src/App.jsx` only if the tests expose missing behavior
- Rebuild: `index.html`
- Rebuild: `main.html`

**Interfaces:**
- Consumes: Job detail `revision`, HTTP 400/409 envelope, FE `ApiError.code`
- Produces: CGI boundary와 화면 재조회 동작의 회귀 테스트

- [ ] **Step 1: 정지 Job PUT의 CGI 응답 테스트를 작성한다**

  `job-api.test.cjs`에서 Job 생성 직후 다음 세 요청을 순서대로 검증한다.

  ```js
  // revision 없는 PUT
  assertEnvelope(response, 400, false);
  assert.equal(response.payload.code, 'JOB_REVISION_REQUIRED');

  // GET revision으로 성공 PUT
  assertEnvelope(response, 200, true);
  assert.equal(response.payload.data.revision, 2);

  // 이전 revision으로 stale PUT
  assertEnvelope(response, 409, false);
  assert.equal(response.payload.code, 'JOB_CONFLICT');
  assert.deepEqual(response.payload.details, {
    name: 'alpha', expectedRevision: 1, currentRevision: 2,
  });
  ```

- [ ] **Step 2: CGI 테스트가 기존 빈틈을 잡는지 확인한다**

  Run:

  ```bash
  cd cgi-bin
  node --test tests/job-api.test.cjs
  ```

  Expected: current unmodified test suite does not contain these assertions; new assertions must pass only when the CGI boundary and manager integration are complete.

- [ ] **Step 3: FE의 conflict 재조회 테스트를 작성한다**

  `app-contract.test.mjs`에서 첫 GET이 `revision:1`, PUT이 `JOB_CONFLICT`, 다음 GET이 `revision:2`와 다른 `schedule.intervalMs`를 반환하도록 fetch fixture를 구성한다. Save 클릭 뒤 아래를 검사한다.

  ```js
  assert.match(renderedText(), /latest setting was reloaded/i);
  assert.equal(runIntervalInput().props.value, 3000);
  assert.equal(lastPutBody().revision, 1);
  ```

  사용자가 다시 Save하면 두 번째 PUT body가 `revision:2`를 보내는지도 확인한다.

- [ ] **Step 4: FE 테스트를 실패·성공 순서로 실행한다**

  Run before implementation change:

  ```bash
  cd frontend
  node tests/app-contract.test.mjs
  ```

  Expected when behavior is missing: FAIL because latest GET config/revision is not reflected.

  필요한 경우 `App.jsx`의 `JOB_CONFLICT` 분기에서 `loaded.reload()` 완료 결과가 form state에 반영되도록 고친 뒤 다시 실행한다.

  Run after implementation:

  ```bash
  npm test
  ```

  Expected: PASS.

- [ ] **Step 5: HTML 세 entry를 다시 빌드한다**

  Run:

  ```bash
  cd frontend
  npm run build:root
  ```

  Expected: `index.html`, `main.html`, `side.html` build 성공. Side source가 바뀌지 않았다면 `side.html` diff가 없어도 정상이다.

- [ ] **Step 6: CGI·FE 계약 테스트를 커밋한다**

  ```bash
  GIT_CONFIG_GLOBAL=/dev/null git add cgi-bin/tests/job-api.test.cjs frontend/tests/api-channel-contract.test.mjs frontend/tests/app-contract.test.mjs frontend/src/App.jsx index.html main.html side.html
  GIT_CONFIG_GLOBAL=/dev/null git -c user.name='max-kim' -c user.email='max.kim@machbase.com' commit -m "test: cover concurrent job mutation contracts"
  ```

---

### Task 5: 전체 회귀 검증과 리뷰

**Files:**
- Verify: `cgi-bin/tests/*.test.cjs`
- Verify: `frontend/tests/*.test.mjs`
- Verify: `docs/specs/DBUS_SDD.md`
- Verify: `docs/specs/BE_DESIGN.md`
- Verify: `docs/specs/FE_DESIGN.md`

**Interfaces:**
- Consumes: Task 1~4의 문서, lock, manager, CGI, FE 결과
- Produces: 병합 가능한 검증 결과와 남은 실제 Neo 통합 제한 보고

- [ ] **Step 1: Backend 전체 테스트를 실행한다**

  ```bash
  cd cgi-bin
  node --test tests/*.test.cjs
  ```

  Expected: 모든 suite PASS, failure 0.

- [ ] **Step 2: Frontend 전체 테스트와 빌드를 실행한다**

  ```bash
  cd frontend
  npm test
  npm run build:root
  ```

  Expected: 모든 test PASS, `index.html`, `main.html`, `side.html` build 성공.

- [ ] **Step 3: 문서와 diff를 검사한다**

  ```bash
  rg -n "operation lock|owner token|heartbeat|JOB_CONFLICT|revision" docs/specs
  rg -n "TB[D]|TO[D]O|implement[ ]later|시간만으로.*잠금.*회수" docs/specs docs/superpowers/plans
  git diff --check
  GIT_CONFIG_GLOBAL=/dev/null git status --short
  ```

  Expected: placeholder와 단순 시간 기반 무조건 삭제 계약이 없고, 의도한 소스·테스트·문서·빌드 파일만 변경된다.

- [ ] **Step 4: 독립 코드 리뷰를 요청한다**

  Reviewer에게 아래를 전달한다.

  ```text
  같은 Job의 Create/Install/Start/Stop/Update/Delete 직렬화,
  owner token/heartbeat/quarantine 회수,
  이전 owner의 side effect 차단,
  HTTP 400/409 envelope,
  FE conflict 최신 revision 재조회,
  SDD/BE/FE 계약 일치를 P0/P1/P2 기준으로 검토한다.
  ```

- [ ] **Step 5: 검증 결과를 기록한다**

  실제 Machbase Neo 실행 파일과 System Bus/PLC가 없는 환경에서는 다음 문구를 완료 보고에 유지한다.

  ```text
  Node 단위·CGI·Frontend·빌드 검증 완료. 실제 Neo/System Bus/PLC 통합은 미검증.
  ```
