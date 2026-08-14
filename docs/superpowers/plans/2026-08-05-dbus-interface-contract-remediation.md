# DBus Interface 계약 보완 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job 참조 판정, Method 변경 제한, Built-in 상세, 공개 오류 목록과 화면 동작을 승인된 계약과 같게 만든다.

**Architecture:** 목록 API는 요약만 읽는다. 상세 API가 Job Method Call 전체 구조를 검사해 참조와 안전 차단 정보를 계산한다. 화면은 Edit/Delete를 누를 때만 상세를 읽고, Built-in은 같은 상세를 읽기 전용으로 모두 보여 준다.

**Tech Stack:** Node.js CommonJS CGI, React, CSS, Node 내장 테스트.

## Global Constraints

- `docs/specs/DBUS_SDD.md`, `docs/specs/FE_DESIGN.md`, `docs/specs/BE_DESIGN.md`의 공개 계약을 같은 내용으로 갱신한다.
- Job Method Call의 필수 필드는 `id`, `name`, `interfaceId`, `methodId`, `inputs`, `tags`다.
- 목록 선택은 상세 API를 호출하지 않는다. Edit/Delete 동작만 상세 API를 호출해 참조 여부를 확인한다.
- Built-in Interface는 조회만 가능하며 Interface/Method의 모든 변경과 삭제는 막는다.
- 화면 CSS는 `DESIGN.md`에 정의된 값만 사용한다.
- `GET /dbus-interface?id=`의 `data`에는 `reviewRequiredState: "available"|"unavailable"`을 넣는다. `unavailable`이면 FE는 모든 Method 변경을 막는다.

---

### Task 1: 백엔드 참조 판정과 Method 보호

**Files:**
- Modify: `cgi-bin/src/interfaces/references.js`, `cgi-bin/src/interfaces/manager.js`, `cgi-bin/src/interfaces/store.js`
- Test: `cgi-bin/tests/interfaces-api.test.cjs`, `cgi-bin/tests/jsh-process-compat.test.cjs`

- [x] `validCall()`이 Job validator와 같은 여섯 필드를 확인하도록 실패 테스트를 추가한다. `name`은 비어 있지 않은 문자열, `inputs`는 객체, `tags`는 배열이어야 한다.
- [x] 누락·잘못된 필드가 있는 Job은 해당 Interface의 `invalidConfig: true` 참조로 반환한다.
- [x] 참조 Job이 Method A만 사용할 때 Method B 생성은 허용하고, `invalidConfig` 참조가 있으면 생성도 막도록 테스트와 코드를 추가한다.
- [x] review-required 파일이 없을 때만 빈 목록으로 처리한다. 읽기·JSON 오류는 안전하게 `reviewRequired: true`로 표시하고 저장 변경은 실패하도록 테스트한다.
- [x] 관련 Node 테스트를 실행하고 커밋한다.

### Task 2: Built-in 상세와 지연 참조 확인 화면

**Files:**
- Modify: `frontend/src/App.jsx`, `frontend/src/styles.css`
- Test: `frontend/src/App.test.jsx` 또는 현재 DBus Interface 화면 테스트 파일

- [x] Built-in의 View DBus Interface가 `methods[]`의 member, ID, source, inputs, outputs, required/validation, 참조 Job을 모두 읽기 전용으로 보여 주는 실패 테스트를 추가한다.
- [x] `DbusInterfaceFormModal`에 상세 `references`를 전달하고 Built-in에서 읽기 전용 Method 상세를 렌더링한다.
- [x] User Interface는 목록에서 참조 상태를 표시하거나 미리 조회하지 않는다. Edit/Delete 클릭 후 상세 응답의 `references[]`로만 차단하고 이유를 보여 준다.
- [x] CSS를 `DESIGN.md`의 값과 일치시킨다. 640px 반응형 기준과 2px focus outline은 문서의 명시 규칙을 유지하고, 새 gap·font-weight는 토큰 값만 쓴다.
- [x] 프론트엔드 테스트와 build를 실행하고 커밋한다.

### Task 3: 승인 계약과 공개 오류 목록

**Files:**
- Modify: `docs/specs/DBUS_SDD.md`, `docs/specs/FE_DESIGN.md`, `docs/specs/BE_DESIGN.md`

- [x] SDD 변경 기록에 이전 계약, 새 계약, 이유, 근거, 사용자 승인 상태를 적는다.
- [x] SDD의 목록 참조 상태 문구를 제거하고, Edit/Delete 후 상세 조회로 차단하는 규칙을 적는다.
- [x] 공개 오류 코드에 `DBUS_INTERFACE_INVALID`, `DBUS_METHOD_INVALID`을 추가하고 BE/FE 설계가 같은 목록을 참조하도록 맞춘다.
- [x] 상세 응답·Method 보호·review-required 안전 처리 설명을 실제 구현과 맞추고 커밋한다.

### Task 4: 전체 재리뷰와 배포 검증

**Files:**
- Test: `cgi-bin/tests/interfaces-api.test.cjs`, `cgi-bin/tests/interfaces-cgi-api.test.cjs`, `cgi-bin/tests/jsh-process-compat.test.cjs`, frontend build

- [ ] 별도 서브 에이전트가 계약·구현·테스트 차이를 검토한다.
- [ ] 발견 항목을 수정하고 범위 재리뷰를 통과한다.
- [ ] 변경된 CGI와 프론트엔드 build를 Neo 서버에 배포하고 cache-busting 상세 조회로 확인한다.

### Task 5: review-required 상태 가용성 계약

**Files:**
- Modify: `cgi-bin/src/interfaces/manager.js`, `cgi-bin/tests/interfaces-api.test.cjs`, `frontend/src/App.jsx`, `frontend/tests/app-contract.test.mjs`, `docs/specs/DBUS_SDD.md`, `docs/specs/FE_DESIGN.md`, `docs/specs/BE_DESIGN.md`

- [x] `GET /dbus-interface?id=` 상세 `data`의 최상위에 `reviewRequiredState: "available"|"unavailable"`을 추가한다. 상태 파일이 없으면 `available`, 읽기·해석 오류면 `unavailable`이다.
- [x] Backend는 상태 오류일 때에도 읽기 전용 상세를 반환하되 모든 Method의 `reviewRequired: true`와 `reviewRequiredState: "unavailable"`을 함께 반환하도록 테스트한다.
- [x] FE는 `available`일 때 `reviewRequired`가 true인 해당 Method만 잠그고, `unavailable`이면 새 Method·수정·삭제를 모두 막고 이유를 보여 준다.
- [x] SDD의 유일한 상세 응답 구조와 FE/BE 계약에 이전·새 내용·이유·사용자 승인 상태를 기록한다.
- [x] Backend·Frontend 테스트와 build, 독립 재리뷰를 통과하고 커밋한다.
