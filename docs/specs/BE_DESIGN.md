# DBus Collector Backend 설계서

## 1. 목적과 변하지 않는 계약

Backend는 Machbase Neo JSH CommonJS 환경에서 Job별 DBus 수집 service, 설정 파일, CGI API를 제공한다. 최소 Neo 버전은 `8.5.6`이고 모든 새 설정의 `schemaVersion`은 `1`이다. 패키지 구현 범위는 Side/Main용 jobs 모델이며, 기존 카운터 예제의 설정·결과·service 이름·API 계약은 호환하지 않는다. 기존 `/jobs/*`, counter JSON, worker를 읽거나 변환하지 않는 이유와 운영자 전환 방법은 `DBUS_SDD.md`의 **1.1 기존 카운터 계약의 비호환 변경과 이유**를 따른다. 구현 중 확정한 추가 계약은 **1.2**를 따르며, **1.3은 JSH 호환성 수정 설계**다. CCR-007의 `open-create-modal`과 CCR-008의 첫 Main 화면·Back 화살표·모달 배경은 Frontend 전용이므로 Backend API·CGI 동작은 바꾸지 않는다.

Job 하나는 service 하나다. service 이름은 반드시 `_dbu_<jobName>`이다. 서로 다른 Job service는 같은 DBus Destination을 사용해도 동시에 실행할 수 있다. 한 Job 안의 Method Call은 config 배열 순서대로 실행한다.

DBus 호출 timeout은 지원하지 않는다. 호출, decode, validation, DB append 오류는 cycle 실패다. CGI는 응답 후 background 작업을 남기지 않고, collector service만 장기 실행한다.

## 2. 파일과 식별자

```text
cgi-bin/
├─ neo-collector.js
├─ profiles.d/ls-electric-plc.json
├─ conf.d/settings.json
├─ conf.d/jobs/<jobName>.json
├─ conf.d/profiles/<profileId>.json
├─ api/
└─ src/{config,collector,dbus,output,tag,cgi,db,log}/
```

Built-in Profile은 `profiles.d`, 사용자 설정은 `conf.d`에 둔다. 패키지 업그레이드는 `conf.d`를 덮어쓰지 않는다.

| 대상 | 규칙 |
|---|---|
| Job name | 영문 소문자·숫자·`_`·`-`, 경로 구분자 금지 |
| Profile/Method ID | 소문자 kebab-case |
| Method Call ID | Job 안에서 고정되고 유일한 ID |
| service | `_dbu_${jobName}` |

## 3. 설정 모델

`settings.json`은 다음 구조를 사용한다.

```json
{
  "schemaVersion": 1,
  "defaultProfileId": "ls-electric-plc",
  "limits": {
    "maxGeneratedTagsPerCall": 1000,
    "maxBufferedRowsPerCycle": 10000
  }
}
```

기본 Profile이 없거나 호환되지 않으면 `PROFILE_NOT_AVAILABLE`을 반환한다. `defaultProfileId`는 새 Job의 기본 선택에만 영향을 준다.

Built-in `ls-electric-plc` Profile은 `schemaVersion: 1`, `profileVersion: 1`, `builtIn: true`, `defaults.busType: "system"`, `defaults.destination: "ls.plc"`, `compatibility.minNeoVersion: "8.5.6"`을 가진다. `get-device-data` Method는 `/ls/plc/device`, `ls.plc.device`, `GetDeviceData`, `uint16 dataCount`, `string memoryAddress`를 정의한다. output은 JSON body의 `data` array를 읽고 `rtn === 1`, `data-count`, 입력 `dataCount`, `tags.length`가 모두 일치해야 성공한다.

저장 파일의 Job document는 `schemaVersion`, `name`, `profileId`, `dbus`, `schedule`, `retry`, `execution`, `methodCalls`, `database`, `log`를 가진다. 새 Job의 기본값은 interval 1000ms, retry 5000/30000ms/multiplier 2, `savePolicy: "perMethod"`, `onMethodError: "stop"`이다. API의 `config` 객체는 이 document에서 `name`을 뺀 설정 본문이며 `name`을 포함할 수 없다. 읽을 때 이전 카운터 형식의 config를 병합하거나 고치지 않는다. schemaVersion 1에 맞지 않는 설정은 `JOB_INVALID`으로 거부한다.

## 4. Profile, Method, 입력과 출력

Built-in Profile은 수정·삭제할 수 없다. 같은 Built-in Profile ID에서는 기존 Method ID, input ID/type/order, output selector, success 조건을 호환되지 않게 바꾸지 않는다. 호환되지 않는 변경은 새 Profile ID로 제공한다.

Custom Profile과 Method는 사용자가 정의한 대로 호출한다. Backend는 읽기/쓰기를 추정하거나 Method 이름으로 막지 않는다. 단, 참조하는 Job이 `running`, `STARTING`, `STOPPING`이면 해당 Custom Profile/Method 변경을 `PROFILE_IN_USE_BY_RUNNING_JOB` 또는 `METHOD_IN_USE_BY_RUNNING_JOB`으로 거부한다. Job 참조가 하나라도 있으면 Profile/Method 삭제를 거부한다. Settings의 `defaultProfileId`가 가리키는 Custom Profile은 기본값을 먼저 바꾸기 전까지 `PROFILE_DEFAULT`로 삭제를 거부한다.

지원 DBus type은 `byte`, `uint8`, `uint16`, `uint32`, `uint64`, `int16`, `int32`, `int64`, `float32`, `float64`, `double`, `bool`, `string`, `objectpath`, `path`, `signature`이다. Backend가 모든 값에 명시적 `type:value` hint를 붙인다. `string`도 `string:`을 붙인다.

decoder는 `raw`와 `json`, shape은 `scalar`, `array`, `object`만 지원한다. path는 `data`, `payload.values`, `items[0].value`처럼 단순 path 문법만 허용한다. 임의 JavaScript decoder와 `eval`은 사용하지 않는다.

## 5. Collector와 저장

시작 흐름은 `service start → neo-collector.js → config/Profile/Method 검증 → DB stream open → DBus connection 생성 → scheduler 시작`이다. Connection은 Job service 안에서 재사용하고 호출·연결 오류 뒤 close한 다음 retry cycle에서 다시 만든다.

정상 cycle은 설정 순서대로 Method를 호출하고, 각 Method의 모든 Tag에 같은 requestTime을 사용한다. LS 응답의 `time-stamp-us`는 검증 정보일 뿐 TAG basetime이 아니다. `bm`은 `(Number(value) + bias) * multiplier`, `mb`는 `Number(value) * multiplier + bias`다. 숫자 output만 Transform을 적용하며 결과가 유한하지 않으면 Method 실패다. 문자열 output은 그대로, object output은 `JSON.stringify`한 문자열로 선택 `stringValueColumn`에 저장한다. 문자열 column이 없는 Job에서 문자열 또는 object 저장을 시도하면 cycle은 `DB_APPEND_FAILED`로 실패한다. 숫자 output만 사용하는 Job은 `stringValueColumn: ""`을 허용한다.

- `perMethod`: 검증된 Method 행을 바로 append한다. 뒤 Method가 실패하면 이미 저장된 행은 유지하고 cycle 상태는 `partial`이다.
- `afterAllMethods`: 모든 행을 메모리에 모은 뒤 한 번 append를 시도한다. 하나라도 실패하거나 buffer가 `maxBufferedRowsPerCycle`을 넘으면 append하지 않는다.
- 실패한 cycle은 5초, 10초, 20초, 이후 30초 backoff로 다음 cycle을 예약한다. 성공하면 interval 1000ms 이상 정상 주기로 돌아간다. 실행 시간이 주기를 넘으면 밀린 cycle을 연달아 실행하지 않는다.

`lastRun`만 service details에 덮어쓴다. `startedAt`, `completedAt`, `status`, `profileId`, `profileVersion`, Method별 requested/completed/status/storedCount/error를 보관한다. `lastRunAt`, `lastSuccessfulRunAt`, `lastStoredAt`, `lastError`도 보관한다. 원본 body, 추출 값, Tag 값, 카운터 결과 파일은 저장하지 않는다.

`lastRun.status`는 모든 Method 성공이면 `success`, 일부 Method 저장 뒤 실패하면 `partial`, 저장된 Method 없이 실패하면 `failed`다. 각 Method 결과는 `id`, `name`, `requestedAt`, `completedAt`, `status`, `storedCount`, 실패 시 짧은 `error`를 가진다. 실행 이력이 없거나 service가 설치되지 않았으면 `/job/last-run`은 `{ "lastRun": null }`을 반환한다.

## 6. lifecycle과 상태

생성은 `validate → config atomic write`이며 결과는 config-only Job이다. service 설치는 별도 install 동작이다. config-only Job은 config만 존재한다. install은 config-only Job에만 가능하고 service가 이미 있으면 `SERVICE_ALREADY_INSTALLED`다.

install은 다음 service descriptor를 Controller에 전달한다. `enable: true`는 Controller 재시작 뒤에도 설치된 Job을 시작 대상으로 유지하는 정책이다. config-only 생성은 이 descriptor를 만들거나 service를 등록하지 않는다.

```json
{
  "name": "_dbu_production-line",
  "enable": true,
  "working_dir": "<package>/cgi-bin",
  "executable": "<package>/cgi-bin/neo-collector.js",
  "args": ["production-line.json"]
}
```

`name`은 항상 `_dbu_<jobName>`, args의 유일한 항목은 항상 `<jobName>.json`이다. start는 설치된 service에만 가능하고, 실행 전에 Job/Profile/Method/DB 설정을 다시 검증한다.

실행 중에는 Job update와 delete를 하지 않는다. `RUNNING`, `STARTING`, `STOPPING`이면 Job PUT/DELETE는 `JOB_RUNNING`으로 거부한다. Backend update도 stop-save-start로 우회하지 않는다. 사용자는 먼저 stop하여 `STOPPED` 또는 `FAILED`가 된 것을 확인한 뒤 수정·삭제한다.

삭제는 정지된 Job에만 허용하며 `uninstall → service details 정리 → config 삭제` 순서다. service가 없는 config-only Job은 config만 삭제한다. 설치 상태, 실행 상태, Controller 상태는 각각 계산해 API에 따로 전달한다.

### 6.1 Job mutation operation lock과 lease

같은 Job의 POST create/install/start/stop, PUT update, DELETE와 package stop/uninstall은 하나의 mutation operation이다. Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 `operation lock`을 유지한다. Package stop/uninstall은 package lifecycle fence를 먼저 잡고 대상 Job lock을 이름순으로 모두 획득한 뒤, 전체 작업이 끝날 때까지 함께 유지한다. 먼저 처리된 Job과 목록에 없던 새 이름도 그 사이 API가 바꾸거나 만들 수 없다. GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다.

Package stop은 `statusKnown === true`인 모든 configured Job에 `stopForPackage()`를 호출한다. Package start checkpoint에는 stop 전 `RUNNING`, `STARTING`, `STOPPING`인 Job만 기록한다. 따라서 STOPPED/config-only Job도 잠금 대상이지만 package start 대상이 되지는 않는다. Fence 또는 Job lock 획득이 충돌하면 이미 획득한 모든 lock을 역순으로 풀고 `PACKAGE_LIFECYCLE_FAILED`로 실패하며 `details.errors[]`의 원래 `JOB_CONFLICT`를 유지한다. API mutation은 읽기 전용 availability probe로 fence 상태를 확인하고 Job lock을 잡은 뒤 같은 probe로 다시 확인한다. Probe는 canonical fence가 없거나 lease가 지났고 owner PID가 종료됐으면 available로 판단하며 어떤 lock도 만들거나 회수하지 않는다. Fresh fence, 살아 있는 owner, PID 판단 오류는 `JOB_CONFLICT`다. 실제 stale 회수는 package lifecycle의 exclusive acquire만 수행한다. Reclaim rename 중 canonical이 잠깐 없어 첫 probe가 통과해도 안전하다. API가 Job lock을 잡은 뒤 replacement fence가 보이면 두 번째 probe가 실패하고, package가 먼저 replacement fence를 잡고 API가 가진 Job lock에 도달하면 package 쪽이 실패하므로 둘이 함께 side effect를 실행할 수 없다. Package session 해제는 성공한 Job handle만 제거하고 실패한 handle과 fence는 보존한다. 모든 Job handle이 해제된 뒤에만 fence를 풀며, 실패한 같은 `session.release()`를 재시도할 수 있다.

lock은 `owner token`과 `heartbeat` 시각을 가진다. owner는 CGI 요청이 끝날 때 heartbeat를 중지하고 자기 token의 lock만 해제한다. lease가 지났고 `owner PID`가 종료되었다고 확인된 lock만 고유 quarantine 이름으로 원자 이동한 뒤 회수한다. PID 생존 여부를 확인할 수 없으면 안전하게 회수하지 않고 `JOB_CONFLICT`를 반환한다. 이전 owner는 Controller 호출이나 설정 파일 변경 같은 side effect 직전에 token을 다시 확인하며, 소유권을 잃었으면 `JOB_CONFLICT`로 중단한다. 이전 owner는 새 owner의 lock을 갱신하거나 해제할 수 없다.

Custom Profile/Method의 POST/PUT는 Profile mutation fence를 먼저 잡고 참조 Job lock을 이름순으로 모두 잡은 뒤 참조와 Controller 상태를 다시 읽고 저장한다. DELETE는 Profile mutation fence와 기존 Profile reader 확인 뒤 참조를 다시 읽고, 참조 Job이 하나라도 있으면 Controller 상태나 Job lock을 확인하지 않고 거부한다. Job create/update/start는 package lifecycle probe 뒤 Job lock을 먼저 잡고, 최신 Job config의 Profile reader lock을 잡은 뒤 Profile을 다시 검증한다. 전역 순서는 package lifecycle probe → Job lock → Profile reader이며, 배타 Profile 변경은 Profile fence → reader 확인 → 정렬된 Job lock이다.

Profile ID와 Job name은 각각 ASCII 영문 소문자·숫자·`-`(Job은 `_`도 허용)만 사용하고 최대 100자다. Profile reader lock은 raw ID 대신 고정 64자의 SHA-256 Profile key를 써서 `<sha256ProfileKey>--<jobName>`으로 만들므로, 검증 전의 긴 잘못된 ID도 경로 밖 접근이나 파일 이름 초과를 만들지 않는다.

canonical Job lock owner 문서도 initial acquire와 stale replacement에서 임시 파일을 완성한 뒤 원자 publish한다. fresh empty/temp-only/malformed owner와 여러 final 또는 final+temp처럼 모호한 owner는 `JOB_CONFLICT`로 보호한다. lease가 지난 empty/temp-only/malformed canonical lock만 orphan으로 고유 quarantine 이름에 원자 이동해 회수한다.

canonical과 reclaim mutex의 공용 owner schema는 비어 있지 않은 `token`, 0보다 큰 safe integer `pid`, 유한한 `acquiredAt`/`heartbeatAt`, `heartbeatAt >= acquiredAt`을 요구한다. schema가 잘못된 owner는 PID 확인 함수에 넘기지 않고 incomplete로 취급한다. fresh이면 `JOB_CONFLICT`로 보호하고 lease가 지난 뒤에만 orphan quarantine 회수한다.

stale 회수를 직렬화하는 `reclaim mutex`도 no-clobber 원자 생성한 고유 owner 문서에 `token`, `pid`, `acquiredAt`, `heartbeatAt`을 기록한다. owner 문서는 임시 파일을 완성한 뒤 원자 publish한다. fresh mutex, 살아 있는 owner, PID 판정 오류, 여러 owner 문서처럼 모호한 mutex는 `JOB_CONFLICT`로 보호한다. owner 문서가 없거나 완성되지 않은 orphan mutex와 lease가 지나고 owner PID 종료가 확인된 mutex만 고유 quarantine 이름으로 원자 이동해 회수하며, 이전 mutex owner는 자기 token 문서만 지워 새 owner mutex를 삭제할 수 없다.

initial canonical owner publish가 실패한 요청은 canonical 경로를 무조건 지우지 않는다. 자기 token의 소유권을 원자적으로 확인할 수 없으면 fresh incomplete를 남겨 `JOB_CONFLICT`로 보호하고, lease가 지난 뒤 orphan quarantine 회수를 허용한다. reclaim mutex는 고유 pending 디렉터리에서 owner를 완성한 뒤 채워진 디렉터리 전체를 canonical 경로로 원자 publish하므로 빈 새 mutex를 노출하지 않는다. publish 중 경로를 잃거나 유효한 다른 owner가 있으면 이전 요청은 `JOB_CONFLICT`로 실패하며 새 owner를 갱신하거나 삭제하지 않는다.

이전 mutex owner가 owner 문서를 지운 직후 stale 회수자가 들어와도, 새 owner는 채워진 mutex만 publish한다. 따라서 이전 owner의 뒤늦은 `rmdir`은 새 owner가 있는 mutex를 지우지 못한다.

회귀 테스트는 이전 owner의 실제 `rmdir` wrapper에서 B의 공개 acquire를 시작한다. B가 채워진 mutex를 publish하면 B 훅은 wrapper의 continuation만 재개하고, wrapper가 저장해 둔 원본 `rmdirSync`를 정확히 한 번 호출해 발생한 `ENOTEMPTY`와 B owner 보존을 확인한다. B의 실제 mutex 해제와 handle 해제 뒤 C가 같은 Job을 다시 획득·검사·해제하는 과정도 확인한다. 또한 crash로 남은 다른 token의 `.reclaim.pending-*`가 있어도 B와 C의 실제 handle 흐름을 막지 않는지 확인한다.

| 먼저 실행된 요청 | 뒤 요청 | 결과 |
|---|---|---|
| PUT | PUT | 뒤 요청 `JOB_CONFLICT`; 앞 요청 성공 뒤 stale revision도 `JOB_CONFLICT` |
| PUT | Start/Delete | 뒤 요청 `JOB_CONFLICT` |
| Start/Stop | PUT | 뒤 요청 `JOB_CONFLICT` |
| Delete | PUT/Create | 뒤 요청 `JOB_CONFLICT`; 삭제된 설정을 다시 만들지 않음 |
| API Start | package stop/uninstall | package lifecycle 실패; aggregate에 `JOB_CONFLICT` 보존 |
| package stop | API Start | API Start `JOB_CONFLICT`; Controller start 금지 |
| package uninstall Delete | API Create/Update | 뒤 API `JOB_CONFLICT`; 성공 뒤 설정 재생성 금지 |
| package stop/uninstall | 새 이름 Create | 뒤 API `JOB_CONFLICT`; 대상 목록 밖의 설정 생성 금지 |
| lease 회수 | 이전 owner 재개 | 이전 owner `JOB_CONFLICT`; side effect 금지 |

## 7. CGI API 공통 계약

GET query string은 최대 128KiB다. 이는 비ASCII 문자를 포함해 최대 100자인 Tag name 100개와 bounded cursor를 함께 보내는 정상 DataViewer 요청을 허용하며, 128KiB를 넘으면 HTTP 413 `REQUEST_TOO_LARGE`로 거부한다.

DataViewer cursor는 FE가 내부 값을 해석하지 않는 opaque `{side, page}` token이다. Backend는 Tag마다 `page * rowsPerTag` offset으로 조회하며, 같은 `TIME` 행도 한 응답 안에서 빠지거나 겹치지 않도록 내부 `_RID`를 두 번째 정렬 기준으로 쓴다. `_RID`는 API 응답에 노출하지 않는다. Grid pagination은 snapshot이 아니므로 조회 사이 새 행이 append되면 다음·이전 페이지의 행 구성이 달라질 수 있다. 고정 분석에는 `to` 시간을 지정한다.

base path는 `/cgi-bin/api`다. 성공은 항상 `{ "ok": true, "data": ... }`, 실패는 항상 `{ "ok": false, "code": "...", "reason": "...", "details": { ... } }`다. `error`, `kind`, counter 전용 필드는 새 API 계약에 없다.

| API | 목적 |
|---|---|
| `GET/PUT /settings` | 기본 Profile과 limits 조회·수정 |
| `GET /profile/list`, `GET/POST/PUT/DELETE /profile` | Profile 조회·Custom CRUD |
| `GET /method/list`, `GET/POST/PUT/DELETE /method` | Method 조회·Custom CRUD |
| `GET /job/list`, `GET/POST/PUT/DELETE /job` | Job 조회·CRUD |
| `POST /job/validate` | 저장 없는 draft 검증 |
| `POST /job/install`, `POST /job/start`, `POST /job/stop` | lifecycle |
| `GET /job/last-run` | 마지막 cycle 한 건 |
| `POST /dbus/call` | 저장 전 Test Call |
| `POST/GET/PUT/DELETE /db/server` | 등록 DB Server 생성·상세·수정·삭제 |
| `GET /db/server/list` | Job form과 관리 화면의 DB Server 목록 |
| `GET /db/connect?server=...` | 등록 DB Server 연결 확인 |
| `POST /db/table/create` | 선택 server에 TAG Table 생성 |
| `GET /db/table/list` | server의 table 목록 |
| `GET /db/table/columns` | table column과 TAG metadata |
| `GET /db/table/tags` | table의 Tag 후보 |
| `GET /db/table/data` | Grid용 cursor/UTC 시간 범위 데이터 |
| `GET /db/table/chart` | Chart용 UTC 시간 series |

| `GET /log/all` | 모든 Job 로그 요약 |
| `GET /log/list?name=...` | Job 로그 파일 목록 |
| `GET /log/content?name=...` | 선택 로그 내용 |
| `GET /log/content/all?name=...` | 선택 로그 전체 내용 |
| `GET /log/tail?name=...` | 선택 로그 마지막 부분 |

DataViewer의 저장값, API timestamp, `from`/`to` 범위는 UTC ISO-8601(`Z`)만 사용한다. v1 API는 별도 timezone 파라미터, IANA 이름(`Asia/Seoul` 등), 고정 offset(`+09:00` 등)을 받지 않는다. 별도 timezone 파라미터가 오면 Backend는 HTTP 400 `TIMEZONE_UNSUPPORTED`로 거부한다.

`GET /job/list`의 각 항목은 `name`, `profileId`, `destination`, `methodCallCount`, `configState`, `executionState`, `controllerState`, `controllerDetail`, `statusKnown`, `lastStoredAt`를 반환한다. Controller 상태를 알 수 없으면 `configState`와 `executionState`는 `null`, `statusKnown`은 `false`다. `GET /job`은 `{ name, config, 상태 }`로 돌려주며, `config`에는 name이 없다. Job POST는 config를 검증하고 저장한 뒤 config-only Job을 만든다. install과 start는 분리된 동작이다.

`POST /dbus/call`은 Profile/Method, Bus/Destination, raw inputs를 받아 `requestedAt`, `durationMs`, `success`, `valueCount`, `returnedCount`, `values`, `suggestedTags`, 진단용 `body`를 반환한다. body는 응답에만 있고 파일·details에는 저장하지 않는다.

DB Server API는 연결 정보를 등록 DB Server 저장소에만 보관한다. Job은 `database.server`에 등록 이름만 저장한다. `/db/table/create`는 TAG table을 만들고, `/db/table/columns`는 primary key·basetime·숫자/문자열 value column을 판별할 metadata를 반환한다. `/db/table/data`는 선택 Job의 server/table/column과 선택 Tag로 Grid 행을, `/db/table/chart`는 숫자 value column Tag만의 chart series를 반환한다. DataViewer tree에는 같은 table의 다른 Job Tag를 자동으로 포함하지 않는다.

Log API는 Job name으로 로그를 찾는다. 로그 파일은 크기 기반 rotation을 사용하며, API 응답에는 DB 비밀번호·raw config·원본 DBus body를 넣지 않는다.

### API별 입력·검증 규칙

- `GET /settings`는 `defaultProfileId`와 limits를 반환한다. `PUT /settings`는 존재하고 호환되는 Profile만 기본값으로 받을 수 있다.
- `GET /profile/list`는 `id`, `displayName`, `vendor`, `builtIn`, `profileVersion`, `methodCount`, `compatible`, `default`를 반환한다. `GET /profile?id=`는 전체 Profile, compatibility reason, 참조 Job 이름과 실행 상태를 반환한다.
- `POST /profile`은 Custom Profile 전체를 저장하고 `builtIn` 입력은 무시해 `false`로 기록한다. Built-in 수정·삭제는 `PROFILE_READ_ONLY`다. 참조 Job이 있으면 Profile 삭제는 `PROFILE_IN_USE`다.
- `GET /method/list?profileId=`는 Method 요약을, `GET /method?profileId=&id=`는 전체 정의와 참조 Job/Call을 반환한다. Method POST/PUT/DELETE는 Custom Profile에서만 가능하고 변경 성공 때 해당 Profile의 `profileVersion`을 하나 올린다.
- `POST /job` 요청은 정확히 `{ "name": "<jobName>", "config": { ... } }`다. `config.name`은 `JOB_INVALID`으로 거부한다. Backend는 검증된 바깥 `name`만 저장 document의 top-level name, `<jobName>.json` 파일명, `_dbu_<jobName>` service 이름에 주입한다.
- `GET /job?name=<jobName>`과 Job create/update 응답은 현재 정수 `revision`을 포함한다. `PUT /job?name=<jobName>` 본문은 `revision`과 name 없는 부분 config patch다. 본문에 name이 있으면 HTTP 409 `JOB_NAME_IMMUTABLE`, revision이 없거나 1 미만이면 HTTP 400 `JOB_REVISION_REQUIRED`로 거부한다. Backend는 **6.1 Job mutation operation lock과 lease**의 `operation lock`을 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 유지한다. 저장 직전 현재 revision과 다르면 HTTP 409 `JOB_CONFLICT`로 거부하며 모든 revision 불일치 `JOB_CONFLICT`의 `details`에 `expectedRevision`, `currentRevision`을 넣는다. 성공 저장은 revision을 1 증가시킨다. query name은 고정 식별자이고, Backend는 `defaults → existing config → request patch` 순서로 깊이 병합한다. 배열은 patch가 보낸 배열 전체로 교체하고, 병합 결과를 검증·저장한다.
- 저장 파일 `<jobName>.json`의 top-level `name`은 반드시 파일명과 같아야 한다. 읽을 때 불일치하면 `JOB_INVALID_CONFIG`으로 보고 list/detail에는 진단만 표시하며 install/start/stop/update/delete처럼 상태를 바꾸는 동작을 모두 차단한다.
- `POST /job/validate`는 파일과 service를 바꾸지 않는다. 다른 Job과 같은 DB/table/tag name은 `TAG_NAME_USED_BY_ANOTHER_JOB` warning으로 반환하고 저장 차단 조건으로 만들지 않는다.
- `POST /job/start`은 설치 상태와 Profile/Method/DB 설정을 재검증한다. 같은 destination을 쓰는 다른 Job은 시작 차단 사유가 아니다. `POST /job/stop`은 실행 중 service만 정지한다.

주요 오류 코드는 `PROFILE_NOT_FOUND`, `PROFILE_NOT_AVAILABLE`, `PROFILE_READ_ONLY`, `PROFILE_IN_USE`, `PROFILE_IN_USE_BY_RUNNING_JOB`, `METHOD_NOT_FOUND`, `METHOD_IN_USE`, `METHOD_IN_USE_BY_RUNNING_JOB`, `JOB_NOT_FOUND`, `JOB_ALREADY_EXISTS`, `JOB_INVALID`, `JOB_INVALID_CONFIG`, `JOB_NAME_IMMUTABLE`, `JOB_REVISION_REQUIRED`, `JOB_CONFLICT`, `JOB_RUNNING`, `SERVICE_NOT_INSTALLED`, `SERVICE_ALREADY_INSTALLED`, `DBUS_UNAVAILABLE`, `DBUS_CALL_FAILED`, `OUTPUT_DECODE_FAILED`, `OUTPUT_COUNT_MISMATCH`, `DB_APPEND_FAILED`다.

## 8. 검증과 안전

Backend는 FE 검증과 무관하게 다음을 다시 검사한다.

- Profile ID와 Method ID 유일성, object path 형식, interface/method name, input ID/type, output path, decoder/shape/tagGeneration capability, Built-in 호환성
- Profile/Method 존재와 호환성, 하나 이상의 Method Call, Call ID/Name 유일성, 필수 input/range/pattern
- Tag의 count/expected count, 연속 outputIndex, 빈 이름, 최대 100자인 Tag name, Job 내부 중복, global/profile 상한, 유한 Transform과 `bm`/`mb`
- DB server/table/value column/string value column 호환성, save policy와 retry 범위, 실행 중 변경 금지
- DBus success condition, decoder/path 결과, shape, 반환 count/array length/Tag count, 숫자 Transform 결과

Profile ID, Job name, table/column은 경로·SQL에 연결하기 전에 검증한다. DB password는 Job config에 저장하지 않고 등록 DB server 이름만 저장한다. 로그와 오류에 비밀번호나 민감한 raw config를 넣지 않는다. Profile/Job JSON은 크기와 배열 개수 제한을 적용한다.
