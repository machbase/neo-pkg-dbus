# DBus Collector Backend 설계서

## 1. 목적과 변하지 않는 계약

Backend는 Machbase Neo JSH CommonJS 환경에서 Job별 DBus 수집 service, 설정 파일, CGI API를 제공한다. 최소 Neo 버전은 `8.5.6`이고 모든 새 설정의 `schemaVersion`은 `1`이다. 패키지 구현 범위는 Side/Main용 jobs 모델이다. 구현 중 확정한 추가 계약은 `DBUS_SDD.md`의 **1.1**을 따르며, **1.2는 JSH 호환성 수정 설계**다. CCR-007의 `open-create-modal`과 CCR-008의 첫 Main 화면·Back 화살표·모달 배경은 Frontend 전용이므로 Backend API·CGI 동작은 바꾸지 않는다.

`settings.json.defaults.database.server` identifies the default server. The preview APIs use submitted connection values only and never persist or return passwords. Saving a server stores its Default Table mapping without metadata validation or Table creation. A missing Table is created only when a Job is saved, according to `DBUS_SDD.md` CCR-055.

generic build는 `provider:null`이며 기존 Interface/Method/Job CRUD를 모두 유지한다.
모든 target의 제품 이름은 `neo-pkg-dbus`로 같고 버전 기준은
`cgi-bin/package.json.version`이다. Provider Profile은 읽기 전용 build 파일이고
Settings 또는 사용자 데이터가 아니다.

generic과 LS Backend는 하나의 개발 브랜치와 루트 version을 공유한다. 공통 CGI,
Job lifecycle, DBus 호출, Database 저장과 Controller 코드는 기존 `cgi-bin/`에 둔다.
제품 추가 검증·정규화·Tag 재계산만 `products/generic/backend/index.js`와
`products/ls/backend/index.js`에 두며 공통 Backend는 업체 ID를 비교하지 않고 build가
선택한 고정 product module을 호출한다. 범용 plugin loader나 제품 자동 발견은
지원하지 않는다.

LS Interface의 `DeviceString` 저장값과 Neo DBus 호출값은 모두 `%`가 포함된
정규형이다. Backend는 `%`로 시작하고 숫자로 끝나며 그 사이에 문자가 하나 이상
있는지를 Interface 입력 validation으로 저장·Test Call·수집 실행 전에 동일하게
검증한다. `%`가 없는 화면 편집값을 정규형으로 만드는 일은 LS Frontend 제품
모듈이 맡으며 Backend는 누락된 `%`를 추측해 보정하지 않는다. 자세한 계약은
`DBUS_SDD.md` CCR-054·CCR-060과 `providers/DBUS_LS_PROFILE.md`를 따른다.
CCR-060의 주소 선택기는 LS Frontend 표시 기능이며 Backend 요청·Job schema·저장값과
호출값은 바뀌지 않는다. Backend는 선택기 구성값을 받거나 추측하지 않는다.

LS Job은 `ls-plc-device/get-device-data` 고정 Method Call을 하나 이상 가질 수 있다.
제품 validator는 `methodCalls`의 모든 항목에 고정 Interface, Method, Output
Selection, 입력과 Tag 규칙을 적용하며 첫 항목만 검사하지 않는다. Call 배열 순서는
공통 실행 순서이고 마지막 Call 삭제 차단은 FE 표시 규칙과 별개로 Backend의 하나
이상 규칙이 최종 보장한다.

Job 하나는 service 하나다. service 이름은 반드시 `_dbu_<jobName>`이다. 서로 다른 Job service는 같은 DBus Destination을 사용해도 동시에 실행할 수 있다. 한 Job 안의 Method Call은 config 배열 순서대로 실행한다.

DBus 호출 timeout은 지원하지 않는다. 호출, decode, validation, DB append 오류는 cycle 실패다. CGI는 응답 후 background 작업을 남기지 않고, collector service만 장기 실행한다.

## 2. 파일과 식별자

```text
cgi-bin/
├─ neo-collector.js
├─ provider.json                         (선택 읽기 전용 build Profile)
├─ interfaces.d/                         (선택 Provider build 산출물)
├─ conf.d/settings.json
├─ conf.d/jobs/<jobName>.json
├─ conf.d/interfaces/<interfaceId>.json
├─ api/
└─ src/{config,collector,dbus,output,tag,cgi,db,log}/
```

`provider.json`이 없으면 generic build다. Provider build는 읽기 전용 Interface
asset과 이를 참조하는 Profile을 별도로 공급한다. Profile loader는 Interface,
Method, Job 파일을 만들거나 바꾸지 않는다. `interfaces.d`가 없거나 비어 있어도
Backend는 빈 Interface 목록으로 정상 시작한다. 사용자 설정은
`conf.d/interfaces`에 두며, 어떤 build도 `conf.d/interfaces`와 `conf.d/jobs`를
바꾸지 않는다.

공통 build script는 `generic`, `ls` target만 허용하고 선택한 제품 Backend를 생성
`cgi-bin/product/`에 둔다. LS target은 같은 제품 폴더의 `provider.json`과
`interfaces/`도 생성 `cgi-bin/provider.json`, `cgi-bin/interfaces.d/`에 복사한다.
build는 이 생성 영역을 target마다 먼저 비우므로 generic 결과에 LS asset이 남지
않는다. `cgi-bin/src/`와 사용자 설정 `cgi-bin/conf.d/`는 수정하지 않는다. 모든
target의 manifest 이름은 `neo-pkg-dbus`이고 루트의 같은 version과
`minServerVersion`을 사용한다. Git에는 기본 generic 생성 결과만 커밋한다.

| 대상 | 규칙 |
|---|---|
| Job name | 영문 소문자·숫자·`_`·`-`, 경로 구분자 금지 |
| DBus Interface/Method ID | 소문자 kebab-case |
| Method Call ID | Job 안에서 고정되고 유일한 ID |
| service | `_dbu_${jobName}` |

## 3. 설정 모델

`settings.json`은 다음 구조를 사용한다.

```json
{
  "schemaVersion": 1,
  "limits": {
    "maxGeneratedTagsPerCall": 1000,
    "maxBufferedRowsPerCycle": 10000
  },
  "defaults": {
    "database": { "server": "localhost" }
  }
}
```

`provider.json`은 [DBUS_PROVIDER_PROFILE.md](providers/DBUS_PROVIDER_PROFILE.md)의
schemaVersion 1만 허용한다. 없음은 정상 generic mode다. 있으면 정확한 allow-list,
`jobMode:"fixed"`, Interface/Method ID, 빈 `tags`, 지원 tag generator를 검증한다.
읽기·JSON·schema 오류는 `PROVIDER_PROFILE_INVALID`이고 generic mode로 낮추지
않는다. `SettingsManager.get()`만 저장 Settings에 Profile 또는 `null`을 합쳐
반환한다. `SettingsManager.update()`는 `provider` key를 `SETTINGS_INVALID`으로
거부하고 저장 파일에는 절대 쓰지 않는다. Database 기본값은 Provider와 독립이다.

Provider가 공급한 Built-in DBus Interface와 Method는 읽기 전용이다. 출력 선택과
저장은 `DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`를 따른다. Backend는 특정 Provider
Method의 반환 수·JSON field·Tag 수를 공통 규칙으로 미리 추측하거나 생성하지
않는다. `jobMode:"fixed"`도 공통 Backend CRUD API를 제한하지 않는다.

저장 파일의 Job document는 `schemaVersion`, `name`, `schedule`, `retry`, `execution`, `methodCalls`, `database`, `log`를 가진다. 새 Method Call은 필수 `id`, `name`, `interfaceId`, `methodId`, `inputs`, `outputSelections`를 가진다. `outputSelections`의 세부 구조는 `DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`가 정한다. 새로 저장하는 Tag는 `name`, `bias`, `multiplier`만 가진다. `sourceAddress`, `calcOrder`, `outputIndex`는 예전 Job을 읽을 때만 입력으로 허용하고, 다음 저장에서 제거한다. native 기본 DBus 출력의 선택에는 `selector`, `valueType`, `elementType`을 저장하지 않는다. Job에는 `profileId`와 공통 `dbus` 필드가 없다. 새 Job의 기본값은 interval 1000ms, retry 5000/30000ms/multiplier 2, `savePolicy: "perMethod"`, `onMethodError: "stop"`이다. API의 `config` 객체는 이 document에서 `name`을 뺀 설정 본문이며 `name`을 포함할 수 없다. schemaVersion 1에 맞지 않는 설정은 `JOB_INVALID`으로 거부한다.

## 4. DBus Interface, Method, 입력과 출력

CCR-032에 따라 Interface 문서는 사용자 관리 이름 `name`도 가진다. `POST /dbus-interface`는 `name`을 필수로 받고 `id`를 받지 않는다. Backend는 생성 잠금 안에서 Name slug(불가능하면 DBus Interface 이름 slug)와 숫자 suffix로 겹치지 않는 내부 ID를 만든다. Job `interfaceId`와 파일명은 이 내부 ID를 쓴다. PUT은 기존 내부 `id`와 `name`을 함께 받는다.

CCR-033에 따라 Interface 문서는 생성 경로를 나타내는 `origin: "discovered"|"manual"`을 가진다. Discover 결과는 `discovered`이고, Direct input은 `manual`이다. discovered Interface/Method는 `/dbus-method`로 바꾸지 않는다. manual Interface의 manual Method만 Job 참조가 없을 때 바꿀 수 있다. Job이 Interface를 참조하면 PUT은 `name`만 바꿀 수 있고, 연결 정보·Interface·Method 변경과 Discover 갱신·삭제는 `DBUS_INTERFACE_IN_USE`이다. 이전 origin 없는 파일은 discovered-only Method면 discovered, manual-only 또는 혼합 Method면 manual으로 읽되 혼합 레거시는 새 구조로 저장하지 않는다.

DBus Interface 문서는 `schemaVersion`, `id`, `builtIn`, `busType`, `destination`, `objectPath`, `interface`, `methods`를 가진다. Method는 `id`, `source: "discovered"|"manual"`, `member`, `inputs`, `outputs`를 가진다. DBus Type parser·값 검증·Neo 호출 ABI의 기준은 [DBUS_TYPE_SYSTEM.md](DBUS_TYPE_SYSTEM.md)다. `GET /dbus-interface?id=`의 성공 data 전체 구조와 Parameter의 선택 검증 필드, `references[].methodIds`의 필수 규칙은 `DBUS_SDD.md` 4.1 **DBus Interface 상세 응답**을 유일한 기준으로 따른다. Backend 참조 분석은 유효한 Job에서 완전한 Method Call 구조(`id`, `name`, `interfaceId`, `methodId`, `inputs`, `tags`)를 확인한 뒤 이 Interface의 Call ID와 고유 Method ID를 만든다. 읽을 수 없거나 구조가 불완전한 Job은 `calls: []`, `methodIds: []`, `invalidConfig: true`로 반환한다. `POST /dbus-interface/discover`는 Neo DBus module의 검증된 `Connection.introspect()` 결과와 DBus signature parser로 모든 Interface, Method, 입력·출력 파라미터를 반환하지만 저장하지 않는다. Discover는 저장하지 않으며, FE는 새 등록에서 정렬된 첫 결과를 고르거나 기존 사용자의 선택을 유지한다. 참조 Job이 없는 discovered Interface의 Edit는 FE가 자동 Discover 후 저장된 Interface와 같은 결과를 고른다. manual Interface는 자동 Discover 뒤에도 `Direct input` 상태와 기존 수동 값을 유지한다. FE는 선택 결과를 현재 편집 draft에 반영하고 footer의 단일 Create/Update Interface control로 단일 object만 보낸다. 새 Interface는 `POST`, 기존 Interface 재-Discover는 `PUT /dbus-interface?discover=true`을 쓴다. `{interfaces:[...]}` 배열 wrapper와 Save All은 없다.

Introspection을 지원하지 않거나 권한이 없으면 사용자는 Interface, Method, 입력·출력 파라미터를 직접 입력한다. 다시 Discover하면 `discovered` Method만 갱신한다. `manual` Method는 자동 수정·삭제하지 않는다. 참조 Job이 하나라도 있으면 Discover 저장은 `DBUS_INTERFACE_IN_USE`로 거부한다.

Built-in Interface/Method는 수정·삭제할 수 없다. 사용자 Interface를 Job이 하나라도 참조하면 이름 외 수정, Discover, Method 변경, 삭제를 `DBUS_INTERFACE_IN_USE`로 거부한다. 참조가 없을 때 discovered Method는 직접 바꿀 수 없고 `DBUS_METHOD_READ_ONLY`이며, manual Interface의 manual Method만 추가·수정·삭제할 수 있다. `/dbus-method`는 POST body `{interfaceId, method}`, PUT body `{interfaceId, methodId, method}`, DELETE query `interfaceId`, `methodId`만 받는다. PUT의 바깥 `methodId`와 `method.id`는 모두 필수이고 같아야 하며 알 수 없는 wrapper/Method 필드는 `DBUS_METHOD_INVALID`으로 거부한다. Interface 문서·요청의 형식 오류는 HTTP 400 `DBUS_INTERFACE_INVALID`, Method 문서·요청의 형식 오류는 HTTP 400 `DBUS_METHOD_INVALID`을 사용한다. Backend는 읽기/쓰기를 추정하거나 Method 이름으로 막지 않는다.

Backend는 [DBUS_TYPE_SYSTEM.md](DBUS_TYPE_SYSTEM.md)의 전체 DBus Type을 검증한다. 공개 API·저장·화면 데이터에 앱 전용 `type:value` 문자열 힌트는 만들지 않으며, Neo DBus module 호출 직전 어댑터 안에서만 기본 Type을 그 module의 ABI로 바꾼다. 현재 module이 받지 못하는 복합 Type과 `unix-fd`는 `DBUS_ARGUMENT_UNSUPPORTED`으로 거부한다.

decoder는 `raw`와 `json`, shape은 `scalar`, `array`, `object`만 지원한다. path는 `data`, `payload.values`, `items[0].value`처럼 단순 path 문법만 허용한다. 임의 JavaScript decoder와 `eval`은 사용하지 않는다.

## 5. Collector와 저장

시작 흐름은 `service start → neo-collector.js → config/DBus Interface/Method 검증 → DB stream open → DBus connection 생성 → scheduler 시작`이다. Connection은 Job service 안에서 `(busType, destination)`별로 재사용하고 호출·연결 오류 뒤 close한 다음 retry cycle에서 다시 만든다. 각 Call은 자신의 Interface의 Object Path, Interface 이름, Method member를 사용한다.

정상 cycle은 설정 순서대로 Method를 호출하고, 각 Method의 모든 Tag에 같은 requestTime을 사용한다. 숫자 output만 `(Number(value) + bias) * multiplier` Transform을 적용하며 결과가 유한하지 않으면 Method 실패다. 문자열·JSON·object·array 등 숫자가 아닌 output은 Transform하지 않는다. 문자열 output은 그대로, object와 array output은 `JSON.stringify`한 문자열로 선택 `stringValueColumn`에 저장하고 같은 행의 숫자 value column에는 `0`을 저장한다. String Value Column이 비어 있으면 문자열·JSON·object·array 행만 append 대상에서 제외하며 오류로 만들지 않는다. 같은 Method와 cycle의 숫자 행은 계속 저장한다.

- `perMethod`: 검증된 Method 행을 바로 append한다. 뒤 Method가 실패하면 이미 저장된 행은 유지하고 cycle 상태는 `partial`이다.
- `afterAllMethods`: 모든 행을 메모리에 모은 뒤 한 번 append를 시도한다. 하나라도 실패하거나 buffer가 `maxBufferedRowsPerCycle`을 넘으면 append하지 않는다.
- 실패한 cycle은 5초, 10초, 20초, 이후 30초 backoff로 다음 cycle을 예약한다. 성공하면 interval 1000ms 이상 정상 주기로 돌아간다. 실행 시간이 주기를 넘으면 밀린 cycle을 연달아 실행하지 않는다.

`lastRun`만 service details에 덮어쓴다. `startedAt`, `completedAt`, `status`, Method별 `interfaceId`, `methodId`, requested/completed/status/storedCount/error를 보관한다. `lastRunAt`, `lastSuccessfulRunAt`, `lastStoredAt`, `lastError`도 보관한다. 원본 body, 추출 값, Tag 값은 저장하지 않는다.

CCR-069의 Job 상세 재구성은 이 저장 구조를 그대로 사용한다. `storedCount`는 마지막 cycle의 해당 Method가 실제 append한 행 수이며 누적값이 아니다. FE polling은 기존 `GET /job`과 `GET /job/last-run`을 다시 호출할 뿐 새 상태 파일이나 API 필드를 만들지 않는다.

`lastRun.status`는 모든 Method 성공이면 `success`, 일부 Method 저장 뒤 실패하면 `partial`, 저장된 Method 없이 실패하면 `failed`다. 각 Method 결과는 `id`, `name`, `requestedAt`, `completedAt`, `status`, `storedCount`, 실패 시 짧은 `error`를 가진다. 실행 이력이 없거나 service가 설치되지 않았으면 `/job/last-run`은 `{ "lastRun": null }`을 반환한다.

## 6. lifecycle과 상태

생성은 `validate → config atomic write → Controller install`을 한 mutation operation 안에서 수행하며 결과는 `installed` / `stopped` Job이다. install 또는 설치 뒤 상태 확인이 실패하면 생성한 config와 service를 정리하고 생성 실패를 반환한다. 외부에서 service만 지워진 기존 Job은 Start가 내부적으로 다시 설치한 뒤 시작한다.

생성과 복구 Start는 다음 service descriptor를 Controller에 전달한다. `enable: false`이므로 Controller 재시작 뒤 Job은 자동 시작하지 않는다.

```json
{
  "name": "_dbu_production-line",
  "enable": false,
  "working_dir": "<package>/cgi-bin",
  "executable": "<package>/cgi-bin/neo-collector.js",
  "args": ["production-line.json"]
}
```

`name`은 항상 `_dbu_<jobName>`, args의 유일한 항목은 항상 `<jobName>.json`이다. start는 실행 전에 Job/DBus Interface/Method/DB 설정을 다시 검증하며 service가 없으면 내부적으로 설치한다.

실행 중에는 Job update와 delete를 하지 않는다. `RUNNING`, `STARTING`, `STOPPING`이면 Job PUT/DELETE는 `JOB_RUNNING`으로 거부한다. Backend update도 stop-save-start로 우회하지 않는다. 사용자는 먼저 stop하여 `STOPPED` 또는 `FAILED`가 된 것을 확인한 뒤 수정·삭제한다.

삭제는 정지된 Job에만 허용하며 `uninstall → service details 정리 → config 삭제` 순서다. service가 없는 config-only Job은 config만 삭제한다. 설치 상태, 실행 상태, Controller 상태는 각각 계산해 API에 따로 전달한다.

### 6.1 Job mutation operation lock과 lease

같은 Job의 POST create/start/stop, PUT update, DELETE와 package stop/uninstall은 하나의 mutation operation이다. Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 `operation lock`을 유지한다. Package stop/uninstall은 package lifecycle fence를 먼저 잡고 대상 Job lock을 이름순으로 모두 획득한 뒤, 전체 작업이 끝날 때까지 함께 유지한다. 먼저 처리된 Job과 목록에 없던 새 이름도 그 사이 API가 바꾸거나 만들 수 없다. GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다.

Package stop은 `statusKnown === true`인 모든 configured Job에 `stopForPackage()`를 호출한다. Package start checkpoint에는 stop 전 `RUNNING`, `STARTING`, `STOPPING`인 Job만 기록한다. 따라서 STOPPED/config-only Job도 잠금 대상이지만 package start 대상이 되지는 않는다. Fence 또는 Job lock 획득이 충돌하면 이미 획득한 모든 lock을 역순으로 풀고 `PACKAGE_LIFECYCLE_FAILED`로 실패하며 `details.errors[]`의 원래 `JOB_CONFLICT`를 유지한다. API mutation은 읽기 전용 availability probe로 fence 상태를 확인하고 Job lock을 잡은 뒤 같은 probe로 다시 확인한다. Probe는 canonical fence가 없거나 lease가 지났고 owner PID가 종료됐으면 available로 판단하며 어떤 lock도 만들거나 회수하지 않는다. Fresh fence, 살아 있는 owner, PID 판단 오류는 `JOB_CONFLICT`다. 실제 stale 회수는 package lifecycle의 exclusive acquire만 수행한다. Reclaim rename 중 canonical이 잠깐 없어 첫 probe가 통과해도 안전하다. API가 Job lock을 잡은 뒤 replacement fence가 보이면 두 번째 probe가 실패하고, package가 먼저 replacement fence를 잡고 API가 가진 Job lock에 도달하면 package 쪽이 실패하므로 둘이 함께 side effect를 실행할 수 없다. Package session 해제는 성공한 Job handle만 제거하고 실패한 handle과 fence는 보존한다. 모든 Job handle이 해제된 뒤에만 fence를 풀며, 실패한 같은 `session.release()`를 재시도할 수 있다.

lock은 `owner token`과 `heartbeat` 시각을 가진다. owner는 CGI 요청이 끝날 때 heartbeat를 중지하고 자기 token의 lock만 해제한다. lease가 지났고 `owner PID`가 종료되었다고 확인된 lock만 고유 quarantine 이름으로 원자 이동한 뒤 회수한다. PID 생존 여부를 확인할 수 없으면 안전하게 회수하지 않고 `JOB_CONFLICT`를 반환한다. 이전 owner는 Controller 호출이나 설정 파일 변경 같은 side effect 직전에 token을 다시 확인하며, 소유권을 잃었으면 `JOB_CONFLICT`로 중단한다. 이전 owner는 새 owner의 lock을 갱신하거나 해제할 수 없다.

사용자 DBus Interface/Method의 POST/PUT/DELETE는 `DBUS_SDD.md` 3.1절 표의 순서, 즉 Interface mutation fence → Interface reader 확인 → 참조 Job 이름순 lock → 참조 재조회 → 검증·저장/삭제를 모두 따른다. 참조가 남은 PUT/DELETE는 각각 `DBUS_INTERFACE_IN_USE` 또는 `DBUS_METHOD_IN_USE`로 거부한다. Job create/update/start는 package lifecycle probe 뒤 Job lock을 먼저 잡고, 최신 Job config의 Interface reader lock을 잡은 뒤 Interface와 Method를 다시 검증한다. Job mutation의 lock 순서는 package lifecycle probe → Job lock → Interface reader다.

Interface ID와 Job name은 각각 ASCII 영문 소문자·숫자·`-`(Job은 `_`도 허용)만 사용하고 최대 100자다. Interface reader lock은 raw ID 대신 고정 64자의 SHA-256 Interface key를 쓴다.

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

DataViewer는 원본 OPC UA Raw Grid와 같은 `page`/`pageSize`, `boundedRange`, `cursorSide`, `cursorTime`, `cursorName`, `cursorOffset`을 사용한다. 평상시 page는 1부터 시작하고, 바로 다음·이전 page는 basetime과 Tag 이름 keyset 경계를 사용한다. `_RID`는 조회·정렬·API 응답에 쓰지 않는다. 같은 basetime·같은 Tag 이름 행의 상대 순서와 페이지 경계 안정성은 보장하지 않는다. Grid pagination은 snapshot이 아니므로 조회 사이 새 행이 append되면 다음·이전 페이지의 행 구성이 달라질 수 있다. `includeTotal=true`은 같은 범위의 total과 lastPage만 반환하며, 고정 분석에는 `to` 시간을 지정한다.

base path는 `/cgi-bin/api`다. 성공은 항상 `{ "ok": true, "data": ... }`, 실패는 항상 `{ "ok": false, "code": "...", "reason": "...", "details": { ... } }`다.

| API | 목적 |
|---|---|
| `GET/PUT /settings` | 저장 Settings 조회·수정과 읽기 전용 Provider Profile 조회 |
| `GET /dbus-interface/list`, `GET /dbus-interface?id=` | DBus Interface 목록·상세 조회 |
| `POST /dbus-interface/discover` | 저장 없는 Introspection 조회 |
| `POST/PUT/DELETE /dbus-interface` | 사용자 DBus Interface CRUD. FE POST는 단일 Interface body만 사용 |
| `POST/PUT/DELETE /dbus-method` | 부모 `interfaceId` 안의 사용자 Method CRUD |
| `GET /job/list`, `GET/POST/PUT/DELETE /job` | Job 조회·CRUD |
| `POST /job/validate` | 저장 없는 draft 검증 |
| `POST /job/start`, `POST /job/stop` | lifecycle |
| `GET /job/last-run` | 마지막 cycle 한 건 |
| `POST /dbus/call` | 저장 전 Test Call |
| `POST/GET/PUT/DELETE /db/server` | 등록 DB Server 생성·상세·수정·삭제 |
| `GET /db/server/list` | Job form과 관리 화면의 DB Server 목록 |
| `GET /db/connect?server=...` | 등록 DB Server 연결 확인 |
| `POST /db/table/create` | 선택 server에 TAG Table 생성 |
| `GET /db/table/list` | server의 table 목록 |
| `GET /db/table/columns` | table column과 TAG metadata |
| `GET /db/table/tags` | Job mapping으로 검증한 전체 Tag와 Asset hierarchy |
| `GET /db/table/data` | Raw Grid page/keyset/total UTC 데이터 |
| `GET /db/table/stat` | Tag 시간 범위의 min/max |
| `GET /db/table/chart` | Neo Web Chart용 검증 SQL query |

| `GET /log/all` | 모든 Job 로그 요약 |
| `GET /log/list?name=...` | Job 로그 파일 목록 |
| `GET /log/content?name=...&file=...&page=...&lines=...` | 선택 로그의 페이지 내용 |
| `GET /log/content/all?name=...&file=...` | 선택 로그 전체 내용 |
| `GET /log/tail?name=...&file=...&lines=...` | 선택 로그 마지막 부분 |

DataViewer의 저장값과 CGI API timestamp·`from`/`to` 범위는 UTC ISO-8601(`Z`)를 정규 표현으로 사용한다. 화면은 `neo-pkg-opcua-client` DataViewer와 같게 UTC/LOCAL/IANA timezone과 시간 표시 형식을 선택해 표시만 바꾼다. CGI가 별도 timezone query를 받을 필요는 없다. `GET /db/table/tags`는 Asset hierarchy를 함께 반환하고, `GET /db/table/data`는 Raw Grid page/keyset/total, `GET /db/table/stat`은 Tag 시간 경계, `GET /db/table/chart`는 Neo Web이 실행할 검증된 SQL query를 반환한다. 이 네 요청은 Job의 DB server/table/column mapping 일치만 검증하며 같은 table의 다른 Job Tag도 요청할 수 있다. 이전 Job Tag 제한과 단순 series Chart 계약의 변경 근거·승인은 `DBUS_SDD.md` CCR-052를 따른다.

`GET /job/list`의 각 항목은 `name`, `interfaceCount`, `destinationCount`, `methodCallCount`, `configState`, `executionState`, `controllerState`, `controllerDetail`, `statusKnown`, `lastStoredAt`를 반환한다. Controller 상태를 알 수 없으면 `configState`와 `executionState`는 `null`, `statusKnown`은 `false`다. GET/POST/PUT Job 상세 성공 data는 `name`, `config`, `revision`, `configState`, `executionState`, `statusKnown`, `controllerState`, `controllerDetail`을 항상 반환하며, `config`에는 name이 없다. Job POST와 정지된 Job PUT은 Job mutation lock 안에서 database Table 존재 여부를 항상 확인한다. 없는 Table은 최종 Output Mapping에 문자열 계열 저장이 있으면 `VALUE`와 `STR_VALUE`, 없으면 `VALUE`만 포함한 TAG Table로 만들고 config도 같은 값으로 정규화한다. 이미 있는 Table은 선택 mapping의 SQL 식별자 형식만 검증하고 Column metadata·자료형을 재검증하거나 schema를 바꾸지 않는다. 생성 실패 시 config·service는 바꾸지 않는다. `/job/validate`와 runtime Start는 Table을 만들지 않는다. Job POST는 config를 검증·저장한 뒤 service를 자동 설치하고 `installed` / `stopped` Job을 반환한다. 별도 install API는 없다.

`POST /dbus/call`은 `interfaceId`, `methodId`, raw inputs를 받아 해당 Interface의 Bus Type, Destination, Object Path, Interface와 Method member로 호출한다. 응답은 `requestedAt`, `durationMs`, `success`, `valueCount`, `values`, 진단용 `body`를 반환한다. `outputSelections`, selector·자료형·Tag 미리보기는 이 API의 입력·응답에 없다. body는 응답에만 있고 파일·details에는 저장하지 않는다.

DB Server API는 연결 정보를 등록 DB Server 저장소에만 보관한다. DB Server 생성·수정의 `name`, `host`, `port`, `user`, `password`는 모두 필수이며 password 누락·빈 값은 `DB_SERVER_INVALID`이다. 기본 `localhost`는 `defaultTable: "DEFAULT_DBUS"`와 빈 기본 Column 두 개로 초기화하되 실제 Table은 만들지 않는다. DB Server Create·Update는 Default Table이나 Column metadata를 검증하지 않고 Table을 만들지 않는다. Job은 `database.server`에 등록 이름만 저장하고 `database.table`은 항상 대문자 SQL 식별자로 정규화해 저장한다. Job POST/정지된 PUT의 database adapter는 Table 존재 여부를 항상 조회한다. 없는 Table은 최종 Output Mapping을 분석해 `{server, table, valueColumn: "VALUE", stringValueColumn: "STR_VALUE"}` 또는 `{server, table, valueColumn: "VALUE", stringValueColumn: null}`로 만든다. 저장 config의 String Value Column은 각각 `STR_VALUE` 또는 빈 문자열이다. Table 생성이 성공했고 생성 이름이 등록 서버의 `defaultTable`과 같으면 DB Server 저장소의 기본 Column도 같은 `VALUE`/선택 `STR_VALUE`로 원자 저장하며 기존 연결 정보와 비밀번호를 보존한다. 다른 Table, 기존 Table, `TABLE_ALREADY_EXISTS` 경쟁은 서버 기본값을 바꾸지 않는다. 기존 Table은 요청 mapping의 SQL 식별자 형식만 검증하며 metadata·자료형을 재검증하지 않는다. `/db/table/create`는 독립 관리 API로 `{server, table, valueColumn, stringValueColumn}`을 받고 `stringValueColumn`은 선택이며 `null`을 허용한다. Backend가 primary key·basetime 열과 자료형을 정해 TAG table을 만든다. 성공 data는 `{server, table, primaryKeyColumn, basetimeColumn, valueColumn, stringValueColumn}`이며 기존 table은 `TABLE_ALREADY_EXISTS`, 잘못된 table 또는 column 설정은 `TABLE_INVALID`이다. `/db/table/columns`는 화면 선택용 metadata를 반환한다. DataViewer의 tags/data/stat/chart은 `job`, server/table/names를 받고 Job의 Database mapping만 일치하면 같은 Table의 모든 실제 Tag를 허용한다. tags는 Asset hierarchy 메타를, data는 page/keyset/total Raw 행을, stat은 시간 경계를, chart는 Neo Web 전용 검증 SQL query를 반환한다. 이전 Job Tag 제한과 series Chart는 CCR-052로 폐기됐다.

Log API는 Job name으로 로그를 찾는다. 로그 파일은 크기 기반 rotation을 사용하며, API 응답에는 DB 비밀번호·raw config·원본 DBus body를 넣지 않는다. Live Logs를 위해 새 endpoint를 추가하지 않는다. 기존 `GET /log/list`의 필수 `name`으로 `active:true` 파일을 찾는다. 페이지 로그 `GET /log/content?name=...&file=...&page=...&lines=...`는 필수 `name`, `file`과 선택 `page`, `lines`을 받고 `{name,file,page,linesPerPage,totalLines,lines,nextPage,previousPage}`를 반환한다. 전체 본문 `GET /log/content/all?name=...&file=...`는 필수 `name`, `file`을 받고 `{name,file,size,content}`를 반환한다. Live Logs의 `GET /log/tail?name=...&file=...&lines=...`는 필수 `name`, `file`과 선택 `lines`을 받고 `{name,file,lines,totalLines}`를 반환한다. `lines`는 로그 줄 배열, `totalLines`는 해당 파일의 전체 줄 수다. SSE와 WebSocket 로그 전송은 제공하지 않는다.

### API별 입력·검증 규칙

- `GET /settings`는 저장 Settings와 `provider`를 반환한다. generic build는 정확히
  `provider:null`이고 Provider build는 검증된 Profile 객체다. `PUT /settings`는
  limits/defaults만 저장하며 `provider` key는 HTTP 400 `SETTINGS_INVALID`이다.
  저장 JSON에는 `provider`가 없다. Profile 파일이 잘못되면 GET은 HTTP 400
  `PROVIDER_PROFILE_INVALID`이다. `defaultProfileId`는 없다.
- `GET /dbus-interface/list`는 내부 `id`, 사용자 `name`, Bus Type, Destination, Object Path, Interface 이름, Built-in 여부, Method 수를 반환한다. `GET /dbus-interface?id=`는 `DBUS_SDD.md` 4.1의 완전한 상세 구조를 반환한다.
- `POST /dbus-interface/discover`는 Bus Type, Destination, Object Path를 받고 저장하지 않은 Interface·Method 목록을 반환한다. Backend는 XML 크기와 Interface·Method·파라미터 수를 제한한다.
- `POST /dbus-interface`는 새 Interface object 하나를 저장하고 `PUT /dbus-interface`는 기존 Interface object 하나를 저장한다. 다시 Discover한 discovered Method 목록은 `PUT /dbus-interface?discover=true`으로 보낸다. Backend는 manual Method를 보존하고, 참조 Job이 하나라도 있으면 Discover 저장을 `DBUS_INTERFACE_IN_USE`로 거부한다. `{interfaces:[...]}` 배열 wrapper와 Save All은 없다. `/dbus-method` 요청에는 부모 `interfaceId`를 포함하고, 수정·삭제에는 `methodId`를 포함한다. Built-in 수정·삭제는 `DBUS_INTERFACE_READ_ONLY`다. 참조 Interface의 이름 외 변경·삭제와 Method 변경은 `DBUS_INTERFACE_IN_USE`다.
- `POST /job` 요청은 정확히 `{ "name": "<jobName>", "config": { ... } }`다. `config.name`은 `JOB_INVALID`으로 거부한다. Backend는 검증된 바깥 `name`만 저장 document의 top-level name, `<jobName>.json` 파일명, `_dbu_<jobName>` service 이름에 주입한다.
- `GET /job?name=<jobName>`과 Job create/update 응답은 현재 정수 `revision`을 포함한다. `PUT /job?name=<jobName>` 본문은 `revision`과 name 없는 부분 config patch다. 본문에 name이 있으면 HTTP 409 `JOB_NAME_IMMUTABLE`, revision이 없거나 1 미만이면 HTTP 400 `JOB_REVISION_REQUIRED`로 거부한다. Backend는 **6.1 Job mutation operation lock과 lease**의 `operation lock`을 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 유지한다. 저장 직전 현재 revision과 다르면 HTTP 409 `JOB_CONFLICT`로 거부하며 모든 revision 불일치 `JOB_CONFLICT`의 `details`에 `expectedRevision`, `currentRevision`을 넣는다. 성공 저장은 revision을 1 증가시킨다. query name은 고정 식별자이고, Backend는 `defaults → existing config → request patch` 순서로 깊이 병합한다. 배열은 patch가 보낸 배열 전체로 교체하고, 병합 결과를 검증·저장한다.
- 저장 파일 `<jobName>.json`의 top-level `name`은 반드시 파일명과 같아야 한다. 읽을 때 불일치하면 `JOB_INVALID_CONFIG`으로 보고 list/detail에는 진단만 표시하며 start/stop/update/delete처럼 상태를 바꾸는 동작을 모두 차단한다.
- `POST /job/validate`는 파일과 service를 바꾸지 않는다. 유효한 draft는 HTTP 200 `{ "ok": true, "data": { "valid": true, "warnings": [{ "code": "...", "reason": "...", "path": "...", "details": {} }] } }`를 반환한다. `path`는 draft 안의 문제 위치를 가리키는 JSON Pointer다. 다른 Job과 같은 DB/table/tag name은 `TAG_NAME_USED_BY_ANOTHER_JOB` warning으로 반환하고 저장 차단 조건으로 만들지 않는다. 유효하지 않은 draft는 `JOB_INVALID` 실패 envelope를 반환한다.
- `POST /job/start`은 Interface/Method/DB 설정을 재검증한다. service가 외부에서 지워진 config-only Job이면 같은 operation lock 안에서 자동 설치한 뒤 시작한다. 같은 destination을 쓰는 다른 Job은 시작 차단 사유가 아니다. `POST /job/stop`은 실행 중 service만 정지한다.

공개 오류 코드는 `DBUS_SDD.md` 4.1의 완전 목록을 따른다. 특히
`SETTINGS_INVALID`, `PROVIDER_PROFILE_INVALID`, `DBUS_INTERFACE_INVALID`,
`DBUS_METHOD_INVALID`, `TIMEZONE_UNSUPPORTED`, `REQUEST_TOO_LARGE`,
`PACKAGE_LIFECYCLE_FAILED`도 공개 오류 코드다.

## 8. 검증과 안전

Backend는 FE 검증과 무관하게 다음을 다시 검사한다.

- Interface ID와 Method ID 유일성, Bus Type/Destination/object path 형식, interface/member name, input/output ID·type, Introspection XML 크기와 항목 수, Built-in 보호
- Interface/Method 존재, 하나 이상의 Method Call, Call ID/Name 유일성, 필수 input/range/pattern
- Tag의 count/expected count, 빈 이름, 최대 100자인 Tag name, Job 내부 중복, global/interface 상한, 유한 `bias`/`multiplier`, `bias`와 `multiplier`를 각각 한 번씩 담은 `transformOrder`, 숫자 출력의 순서형 Transform
- DB server/table/value column/string value column 호환성, save policy와 retry 범위, 실행 중 변경 금지
- DBus success condition, decoder/path 결과, shape, 반환 count/array length/Tag count, 숫자 Transform 결과

Interface ID, Job name, table/column은 경로·SQL에 연결하기 전에 검증한다. DB password는 Job config에 저장하지 않고 등록 DB server 이름만 저장한다. 로그와 오류에 비밀번호나 민감한 raw config를 넣지 않는다. Interface/Job JSON은 크기와 배열 개수 제한을 적용한다.
