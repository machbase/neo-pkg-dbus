# DBus Collector Backend 설계서

## 1. 목적과 변하지 않는 계약

Backend는 Machbase Neo JSH CommonJS 환경에서 Job별 DBus 수집 service, 설정 파일, CGI API를 제공한다. 최소 Neo 버전은 `8.5.6`이고 모든 새 설정의 `schemaVersion`은 `1`이다. 패키지 구현 범위는 Side/Main용 jobs 모델이며, 기존 카운터 예제의 설정·결과·service 이름·API 계약은 호환하지 않는다.

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

Job 설정은 `schemaVersion`, `name`, `profileId`, `dbus`, `schedule`, `retry`, `execution`, `methodCalls`, `database`, `log`를 가진다. 새 Job의 기본값은 interval 1000ms, retry 5000/30000ms/multiplier 2, `savePolicy: "perMethod"`, `onMethodError: "stop"`이다. 읽을 때 이전 카운터 형식의 config를 병합하거나 고치지 않는다. schemaVersion 1에 맞지 않는 설정은 `JOB_INVALID`으로 거부한다.

## 4. Profile, Method, 입력과 출력

Built-in Profile은 수정·삭제할 수 없다. 같은 Built-in Profile ID에서는 기존 Method ID, input ID/type/order, output selector, success 조건을 호환되지 않게 바꾸지 않는다. 호환되지 않는 변경은 새 Profile ID로 제공한다.

Custom Profile과 Method는 사용자가 정의한 대로 호출한다. Backend는 읽기/쓰기를 추정하거나 Method 이름으로 막지 않는다. 단, 참조하는 Job이 `running`, `STARTING`, `STOPPING`이면 해당 Custom Profile/Method 변경을 `PROFILE_IN_USE_BY_RUNNING_JOB` 또는 `METHOD_IN_USE_BY_RUNNING_JOB`으로 거부한다. 참조가 하나라도 있으면 Profile/Method 삭제를 거부한다.

지원 DBus type은 `byte`, `uint8`, `uint16`, `uint32`, `uint64`, `int16`, `int32`, `int64`, `float32`, `float64`, `double`, `bool`, `string`, `objectpath`, `path`, `signature`이다. Backend가 모든 값에 명시적 `type:value` hint를 붙인다. `string`도 `string:`을 붙인다.

decoder는 `raw`와 `json`, shape은 `scalar`, `array`, `object`만 지원한다. path는 `data`, `payload.values`, `items[0].value`처럼 단순 path 문법만 허용한다. 임의 JavaScript decoder와 `eval`은 사용하지 않는다.

## 5. Collector와 저장

시작 흐름은 `service start → neo-collector.js → config/Profile/Method 검증 → DB stream open → DBus connection 생성 → scheduler 시작`이다. Connection은 Job service 안에서 재사용하고 호출·연결 오류 뒤 close한 다음 retry cycle에서 다시 만든다.

정상 cycle은 설정 순서대로 Method를 호출하고, 각 Method의 모든 Tag에 같은 requestTime을 사용한다. LS 응답의 `time-stamp-us`는 검증 정보일 뿐 TAG basetime이 아니다. `bm`은 `(Number(value) + bias) * multiplier`, `mb`는 `Number(value) * multiplier + bias`다. 숫자 결과가 유한하지 않으면 Method 실패고 문자열은 Transform을 적용하지 않는다.

- `perMethod`: 검증된 Method 행을 바로 append한다. 뒤 Method가 실패하면 이미 저장된 행은 유지하고 cycle 상태는 `partial`이다.
- `afterAllMethods`: 모든 행을 메모리에 모은 뒤 한 번 append를 시도한다. 하나라도 실패하거나 buffer가 `maxBufferedRowsPerCycle`을 넘으면 append하지 않는다.
- 실패한 cycle은 5초, 10초, 20초, 이후 30초 backoff로 다음 cycle을 예약한다. 성공하면 interval 1000ms 이상 정상 주기로 돌아간다. 실행 시간이 주기를 넘으면 밀린 cycle을 연달아 실행하지 않는다.

`lastRun`만 service details에 덮어쓴다. `startedAt`, `completedAt`, `status`, `profileId`, `profileVersion`, Method별 requested/completed/status/storedCount/error를 보관한다. `lastRunAt`, `lastSuccessfulRunAt`, `lastStoredAt`, `lastError`도 보관한다. 원본 body, 추출 값, Tag 값, 카운터 결과 파일은 저장하지 않는다.

## 6. lifecycle과 상태

생성은 `validate → config atomic write`이며 결과는 config-only Job이다. service 설치는 별도 install 동작이다. config-only Job은 config만 존재한다. install은 config-only Job에만 가능하고 service가 이미 있으면 `SERVICE_ALREADY_INSTALLED`다.

실행 중에는 Job update와 delete를 하지 않는다. `RUNNING`, `STARTING`, `STOPPING`이면 Job PUT/DELETE는 `JOB_RUNNING`으로 거부한다. Backend update도 stop-save-start로 우회하지 않는다. 사용자는 먼저 stop하여 `STOPPED` 또는 `FAILED`가 된 것을 확인한 뒤 수정·삭제한다.

삭제는 정지된 Job에만 허용하며 `uninstall → service details 정리 → config 삭제` 순서다. service가 없는 config-only Job은 config만 삭제한다. 설치 상태, 실행 상태, Controller 상태는 각각 계산해 API에 따로 전달한다.

## 7. CGI API 공통 계약

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
| `/db/**`, `/log/**` | DB Server/Table/DataViewer와 로그 |

`GET /job/list`의 각 항목은 `name`, `profileId`, `destination`, `methodCallCount`, `configState`, `executionState`, `controllerState`, `controllerDetail`, `lastStoredAt`를 반환한다. `GET /job`은 schemaVersion 1의 전체 config와 상태를 반환한다. Job POST는 config를 검증하고 저장한 뒤 config-only Job을 만든다. install과 start는 분리된 동작이다.

`POST /dbus/call`은 Profile/Method, Bus/Destination, raw inputs를 받아 `requestedAt`, `durationMs`, `success`, `valueCount`, `returnedCount`, `values`, `suggestedTags`, 진단용 `body`를 반환한다. body는 응답에만 있고 파일·details에는 저장하지 않는다.

주요 오류 코드는 `PROFILE_NOT_FOUND`, `PROFILE_NOT_AVAILABLE`, `PROFILE_READ_ONLY`, `PROFILE_IN_USE`, `PROFILE_IN_USE_BY_RUNNING_JOB`, `METHOD_NOT_FOUND`, `METHOD_IN_USE`, `METHOD_IN_USE_BY_RUNNING_JOB`, `JOB_NOT_FOUND`, `JOB_ALREADY_EXISTS`, `JOB_INVALID`, `JOB_RUNNING`, `SERVICE_NOT_INSTALLED`, `SERVICE_ALREADY_INSTALLED`, `DBUS_UNAVAILABLE`, `DBUS_CALL_FAILED`, `OUTPUT_DECODE_FAILED`, `OUTPUT_COUNT_MISMATCH`, `DB_APPEND_FAILED`다.

## 8. 검증과 안전

Backend는 FE 검증과 무관하게 Profile/Method 존재·호환성, input type/range/pattern, Tag 상한·index·count·이름·Transform, DB table/column, save policy/retry 범위, 실행 중 변경 금지를 다시 검사한다. Profile ID, Job name, table/column은 경로·SQL에 연결하기 전에 검증한다. DB password는 Job config에 저장하지 않고 등록 DB server 이름만 저장한다. 로그와 오류에 비밀번호나 민감한 raw config를 넣지 않는다.
