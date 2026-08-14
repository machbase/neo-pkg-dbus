# DBus Collector 계약 정합성 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**목표:** 현재 Profile 중심 구현을 `DBUS_SDD.md`, `FE_DESIGN.md`, `BE_DESIGN.md`의 DBus Interface 중심 계약에 맞춘다.

**구조:** Backend는 DBus Interface/Method 저장소와 API를 먼저 만들고, Job·Collector·Test Call을 Call별 Interface 참조 방식으로 전환한다. 이후 lifecycle, DataViewer, Frontend, 선택 LS 빌드와 테스트를 같은 공개 계약으로 맞춘다.

**기술:** Machbase Neo JSH CommonJS CGI, Node 단위 테스트, React/Vite, ECharts

## 전역 제약

- 계약 문서가 구현보다 항상 우선한다.
- 최소 Machbase Neo 버전은 `8.5.6`이다.
- 새 공개 API는 성공 시 `{ "ok": true, "data": ... }`, 실패 시 `{ "ok": false, "code", "reason", "details" }` envelope를 쓴다.
- 새 공개 흐름은 Profile을 노출하거나 참조하지 않는다. 레거시 Profile 파일의 물리 삭제는 별도 범위로 결정한다.
- DB 비밀번호, 원본 DBus body, raw config는 목록·로그·오류에 넣지 않는다.
- Frontend 시각 값은 `DESIGN.md`만 사용한다.

---

## 체크리스트

### 1. 공통 HTTP와 Settings 전환

**수정 대상:** `cgi-bin/src/cgi/`, `cgi-bin/src/config/`, `frontend/src/api.js`, Settings 화면과 테스트

- [x] 공통 HTTP helper가 성공·실패 envelope와 HTTP 400/404/409/503 매핑을 일관되게 반환하게 한다.
- [x] Settings schema, API, validator, frontend에서 `defaultProfileId`를 제거한다.
- [x] Settings는 `limits`만 읽고 저장하도록 바꾼다.
- [x] 설정 파일이 없는 깨끗한 설치는 limits-only 기본값으로 읽고, `PUT` 때만 원자적으로 파일을 만든다.
- [x] FE 요청은 인위적인 timeout을 두지 않고, 사용자 취소 또는 화면 닫힘 때만 `AbortSignal`을 전달한다.

**완료 기준:**

- [x] `GET/PUT /settings`는 limits만 다룬다.
- [x] `defaultProfileId`가 새 Settings 응답·요청·테스트에 없다.
- [x] 모든 새 CGI API 테스트가 공통 envelope를 검사한다.

### 2. DBus Interface·Method 저장소와 API

**수정 대상:** 새 `cgi-bin/src/interfaces/`, `cgi-bin/api/dbus-interface*`, `cgi-bin/api/dbus-method*`, 관련 테스트

- [x] Built-in Interface는 `cgi-bin/interfaces.d/`, 사용자 Interface는 `cgi-bin/conf.d/interfaces/`에 둔다.
- [x] Interface validator는 `id`, bus type, destination, object path, interface, methods를 검사한다.
- [x] Method validator는 `id`, `source`, member, inputs, outputs를 검사한다.
- [x] `GET /dbus-interface/list`, `GET/POST/PUT/DELETE /dbus-interface`, `POST /dbus-interface/discover`, `POST/PUT/DELETE /dbus-method`를 추가한다.
- [x] Discover는 저장하지 않고, Save All에서만 원자 저장한다.
- [x] 재-Discover는 `discovered` Method만 갱신하고 `manual` Method는 보존한다.
- [x] 참조 중 discovered Method의 변경·삭제 후보는 저장하지 않고 `review-required`로 반환한다.
- [x] Built-in 수정·삭제와 참조 중 수정·삭제를 각각 계약 오류 코드로 거부한다.
- [x] XML 크기, Interface·Method·파라미터 수 제한을 적용한다.

**완료 기준:**

- [x] 모든 Interface/Method API가 계약 경로·envelope·오류 코드를 사용한다.
- [x] Discover, Save All, manual 보존, review-required, 참조 차단이 API 테스트로 확인된다.

### 3. Job 모델·revision·lifecycle 전환

**수정 대상:** `cgi-bin/src/jobs/`, Job CGI, Job 테스트

- [x] Job 최상위의 `profileId`, 공통 `dbus`를 제거한다.
- [x] 각 Method Call에 `interfaceId`, `methodId`, `inputs`, `tags`를 저장한다.
- [x] Job validator가 Interface/Method 존재와 `review-required` 상태를 검사한다.
- [x] POST는 `{name, config}`만 받고 `config.name`을 거부한다.
- [x] PUT은 `{revision, 부분 config}`만 받고, 객체는 깊이 병합하며 배열은 전체 교체한다.
- [x] revision 불일치는 `JOB_CONFLICT`와 `expectedRevision`, `currentRevision`을 반환한다.
- [x] config-only 생성 → install → start → stop → 정지 상태 delete 전이를 구현한다.
- [x] service 이름은 항상 `_dbu_<jobName>`으로 만든다.
- [x] RUNNING, STARTING, STOPPING Job의 PUT/DELETE는 `JOB_RUNNING`으로 거부한다.

**완료 기준:**

- [x] 계약 예시 Job JSON을 생성·조회·수정·설치·시작·정지·삭제할 수 있다.
- [x] Job 상세 성공 data가 `name`, `config`, `revision`, `configState`, `executionState`, `statusKnown`, `controllerState`, `controllerDetail`을 항상 포함한다.
- [x] 상태 전이, revision 충돌, 실행 중 변경 거부가 API 테스트로 확인된다.

### 4. Collector·Test Call·lastRun 전환

**수정 대상:** `cgi-bin/src/collector/`, `cgi-bin/src/dbus/test-call.js`, 관련 테스트

- [x] Test Call은 `{interfaceId, methodId, inputs}`로 Interface의 bus, destination, object path, member를 찾아 호출한다.
- [x] Collector는 Method Call마다 해당 Interface를 읽어 호출한다.
- [x] Connection은 `(busType, destination)`별로 재사용하고 호출·연결 오류 뒤 close 후 다음 retry cycle에서 다시 만든다.
- [x] `perMethod`, `afterAllMethods`, 문자열·object 저장, Transform, retry backoff를 계약대로 적용한다.
- [x] lastRun은 시간, 상태, Method별 `interfaceId`·`methodId`·결과만 저장한다.
- [x] 원본 body, 추출 값, Tag 값은 lastRun에 저장하지 않는다.

**완료 기준:**

- [x] 한 Job에서 서로 다른 Interface의 Method를 순서대로 호출할 수 있다.
- [x] success, partial, failed lastRun과 Method별 결과가 계약 형식으로 확인된다.
- [x] LS 성공·rtn 실패·JSON 실패·count 불일치 테스트가 통과한다.

### 5. Lock과 package lifecycle

**수정 대상:** Job lock, 새 Interface lock 모듈, `scripts/lifecycle.js`, 동시성 테스트

- [x] 모든 Job mutation(create/install/start/stop/update/delete)은 `package lifecycle probe → Job lock → Interface reader` 순서를 쓴다.
- [x] Interface/Method POST·PUT·DELETE는 `Interface mutation fence → Interface reader 확인 → 참조 Job 이름순 lock → 참조 재조회 → 검증·저장/삭제` 순서를 쓴다.
- [x] Interface reader lock key는 Interface ID의 SHA-256 값으로 만든다.
- [x] lock 충돌 때 획득한 handle을 역순으로 해제하고 `JOB_CONFLICT`를 반환한다.
- [x] package stop/uninstall 실패는 stdout에 `PACKAGE_LIFECYCLE_FAILED` 오류 envelope를 출력하고 non-zero 종료한다.

**완료 기준:**

- [x] Job mutation 경합, Interface 변경 경합, stale lock 회수 테스트가 통과한다.
- [x] package lifecycle 오류의 `details.errors[]`에서 원래 `JOB_CONFLICT`를 읽을 수 있다.

### 6. DB Server·TAG table·DataViewer

**수정 대상:** `cgi-bin/src/db/`, DB CGI, DataViewer 테스트

- [x] DB Server POST·PUT는 `name`, `host`, `port`, `user`, `password`를 모두 요구한다.
- [x] 누락·빈 password는 `DB_SERVER_INVALID`으로 거부한다.
- [x] TAG table 생성은 `server`, `table`, `valueColumn`을 요구하고 `stringValueColumn`은 생략 또는 `null`을 허용한다.
- [x] Backend가 primary key·basetime 열·자료형을 정하고 실제 metadata를 응답한다.
- [x] 기존 table은 `TABLE_ALREADY_EXISTS`, 잘못된 정의는 `TABLE_INVALID`으로 처리한다.
- [x] DataViewer data/chart는 `job`, `server`, `table`, `names`를 모두 요구한다.
- [x] 요청 source와 Job database·현재 Tag가 다르면 `JOB_DATA_SOURCE_MISMATCH`로 거부한다.
- [x] Grid는 `{rows, cursor:{next, previous}}`를 반환한다.
- [x] UTC만 받고 timezone은 `TIMEZONE_UNSUPPORTED`, 128KiB 초과 query는 `REQUEST_TOO_LARGE`로 거부한다.
- [x] metadata basetime 열만 정렬하고 cursor 내부 값은 공개하지 않는다.

**완료 기준:**

- [x] password 없는 생성·수정, 잘못된 DataViewer source, timezone query, 과대 query가 지정 오류 코드로 실패한다.
- [x] string value column 없는 TAG table 생성과 DataViewer cursor가 테스트된다.

### 7. Frontend 전환

**수정 대상:** `frontend/src/`, `frontend/tests/`

- [x] Profile route, Profile modal, `profile` BroadcastChannel 메시지를 새 공개 흐름에서 제거한다.
- [x] DBus Interface 목록·상세·Discover·Save All·수동 Method 입력 화면을 만든다.
- [x] Discover 결과 전체 표시, `org.freedesktop.*` Standard 뱃지, 참조 Job 안내, review-required 표시를 제공한다.
- [x] Side의 New 동작은 현재 route를 바꾸지 않고 `dbus-interface` 생성 modal을 연다.
- [x] Job form의 Call 편집기는 `interfaceId`와 `methodId`를 함께 저장한다.
- [x] 기본 빌드는 빈 Interface 목록으로 시작하며 Interface 선택 전 Call 추가를 막는다.
- [x] Job 상세의 8개 필드와 UNKNOWN 상태 차단 사유를 표시한다.
- [x] validate warning의 `reason`과 JSON Pointer `path`를 해당 입력 근처에 표시한다.
- [x] DataViewer는 `job`, `server`, `table`, `names`를 보내고 `JOB_DATA_SOURCE_MISMATCH` 때 Job 상세 재조회·선택 초기화를 수행한다.
- [x] DB Server Create/Edit는 5개 필수 입력을 검사하고 빈 password면 저장 control을 비활성화한다.
- [x] TAG table form은 valueColumn과 선택 stringValueColumn을 보낸다.

**완료 기준:**

- [x] Interface 관리, Job 편집, Test Call, DataViewer, DB Server 화면이 새 API만 사용한다.
- [x] 경고는 저장을 막지 않지만 위치와 이유가 보인다.
- [x] `DESIGN.md` 토큰과 접근성 규칙을 지키는 frontend 테스트가 통과한다.

### 8. 선택 LS Interface 빌드·통합 검증

**수정 대상:** `build-assets/interfaces/`, build script, `frontend/package.json`, README, 통합 테스트

- [x] LS 원본을 `build-assets/interfaces/ls-plc-device.json`에 둔다.
- [x] 기본 빌드는 `cgi-bin/interfaces.d/`에 LS asset을 넣지 않는다.
- [x] `npm run build:root -- --with-ls-interface`만 LS asset을 복사한다.
- [x] build는 `conf.d/interfaces`, `conf.d/jobs`를 바꾸지 않는다.
- [x] Backend·Frontend contract 테스트를 Profile fixture 대신 Interface fixture로 교체한다.
- [x] README와 API 예시를 새 DBus 모델로 갱신한다.

**완료 기준:**

- [x] 기본 빌드는 빈 built-in Interface 목록, 옵션 빌드는 읽기 전용 LS Interface를 제공한다.
- [x] 최소 Neo `8.5.6` 이상인 `v8.5.7-snapshot`에서 System Bus, LS PLC, service lifecycle, TAG append, DataViewer를 통합 확인한다.
- [x] 계약 문서와 구현의 재리뷰에서 P1/P2가 없다. 실제 Neo 통합 환경에서 재확인했다.

## 실행 순서

1. 1~2단계로 새 저장소·공통 API·Job schema를 만든다.
2. 3~5단계로 실행·동시성·데이터 계약을 맞춘다.
3. 6~7단계로 화면과 빌드·테스트·README를 전환한다.
