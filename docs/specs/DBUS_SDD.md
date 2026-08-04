# DBus Collector 통합 SDD

## 1. 결정 요약과 우선순위

이 문서는 `neo-pkg-dbus` 구현의 단일 기능 기준이다. 기능이 `FE_DESIGN.md` 또는 `BE_DESIGN.md`와 다르게 읽히면 이 문서의 결정이 우선한다. 시각 규칙은 저장소 루트 `DESIGN.md`가 우선하며 이 문서는 화면의 기능과 상태만 정한다.

1. Side/Main jobs 패키지만 구현한다. single과 기존 counter 기능은 이 제품 범위에 없다.
2. 최소 Neo는 `8.5.6`, 모든 새 JSON schemaVersion은 `1`, 기본 Profile은 `ls-electric-plc`다.
3. Job service 이름은 `_dbu_<jobName>`이다.
4. 실행 중 Job은 Edit, Delete, Backend update를 할 수 없다. stop-save-start 갱신은 금지다.
5. DBus와 브라우저 API 요청에 요청 timeout을 만들지 않는다.
6. config-only, installed, running, Controller 원본 상태는 서로 다른 값으로 전송한다.
7. API envelope는 성공 `{ok,data}`, 실패 `{ok:false,code,reason,details}`다.
8. 여러 관리자의 장기 화면 잠금은 제공하지 않는다. 대신 같은 Job의 POST create/install/start/stop, PUT update, DELETE와 package stop/uninstall을 하나의 mutation operation으로 직렬화한다. Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 `operation lock`을 유지하고, 다른 mutation이 lock을 보유하면 HTTP 409 `JOB_CONFLICT`를 반환한다. GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다. Job GET 응답의 정수 `revision`은 PUT에 반드시 보내며, 저장 직전 revision이 달라져도 HTTP 409 `JOB_CONFLICT`로 거부한다. 화면은 최신 설정을 다시 읽어 사용자가 다시 수정하게 한다.
9. 기존 counter JSON, counter store, `_np_neo_pkg_dbus_` service 이름, `/jobs/*` API, legacy config 병합은 호환하지 않는다.

### 1.1 기존 카운터 계약의 비호환 변경과 이유

이 패키지는 카운터 예제를 확장하는 것이 아니라 DBus Collector로 교체한다. 따라서 아래 변경은 의도적으로 하위 호환을 제공하지 않는다. 기존 설정을 자동으로 변환하면 Profile, DBus Method, Tag, DB Server를 추측해야 하며 잘못된 설비 호출이나 저장을 만들 수 있다. 사용자는 새 Job을 명시적으로 만들고 검증·설치·시작해야 한다.

| 기존 계약 | 새 계약 | 변경 이유 |
|---|---|---|
| `POST /jobs/create`, `POST /jobs/update`, `/jobs/list`, `/jobs/start`, `/jobs/stop`, `/jobs/delete` | REST 형태의 `/job`, `/job/list`, `/job/install`, `/job/start`, `/job/stop`, `/job/validate`, `/job/last-run` | 카운터 설정만 다루던 API를 Profile·Method·DBus·DB·실행 상태까지 검증하는 API로 교체한다. |
| 생성 요청 `{name, config:{intervalMs}}`가 service를 바로 등록 | `POST /job`은 config-only JSON만 원자 저장하고, `POST /job/install`과 `POST /job/start`을 별도로 호출 | 설정 저장, service 등록, 실제 실행을 분리해 사용자가 위험한 실행 전 검증할 수 있게 한다. |
| `_np_neo_pkg_dbus_<name>` service와 `worker.js` | `_dbu_<jobName>` service와 `neo-collector.js` | Job별 DBus collector를 식별하고 counter worker와 혼동하지 않게 한다. |
| `counter.json`의 count·시각 | typed DBus 결과를 TAG table에 append하고 service details에는 마지막 cycle 요약만 저장 | 실제 설비 값을 저장하며 원본 body·Tag 값·민감한 결과를 service details에 남기지 않는다. |
| 이름과 `intervalMs` 정도의 schema 없는 config | `schemaVersion: 1`, Profile/Method, DBus, retry, 저장 정책, Tag, DB mapping을 가진 Job document | 재현 가능한 수집 설정과 Backend 최종 검증을 제공한다. |
| `error`, `kind` 중심 오류와 Controller 상태의 단순 표시 | `{ok:false,code,reason,details}`와 config/execution/controller 분리 상태 | FE가 오류를 안전하게 표시하고 `UNKNOWN`일 때 수정·삭제를 막기 위해서다. |
| 카운터 화면과 legacy `/jobs/*` 호출 | Side/Main의 Job, Profile/Method, DataViewer, Log 화면과 새 `/job/*` 호출 | 구현 범위를 승인된 DBus Collector 화면으로 한정한다. |

이 비호환 정책은 데이터 migration을 제공하지 않는다는 뜻이다. legacy JSON과 counter 결과 파일은 새 Collector가 읽거나 병합하지 않는다. 필요한 경우 운영자는 기존 파일을 별도로 보관한 뒤 새 Job을 만들어야 한다.

### 1.2 구현 중 확정한 계약 보완 기록

아래 항목은 구현·검토 중 발견해 **현재 계약으로 확정한 변경**이다. 각 항목은 이전 약속, 새 약속, 바꾼 이유와 확인 근거를 함께 남긴다. 앞으로 계약을 바꿀 때도 이 형식으로 승인 상태와 근거를 기록한다.

| ID | 이전 계약 | 확정한 새 계약 | 이유와 확인 근거 | 승인 상태 |
|---|---|---|---|---|
| CCR-001 | 장기 화면 잠금이 없다는 원칙만 있었고, 같은 Job의 Start·수정·삭제 요청이 겹칠 때의 순서가 충분히 정해지지 않았다. | 장기 화면 잠금은 계속 제공하지 않는다. 대신 짧은 서버 `operation lock`과 `revision`으로 같은 Job의 mutation을 직렬화하고, 충돌은 `409 JOB_CONFLICT`로 돌려준다. | 요청이 겹치면 Controller side effect와 설정 저장의 순서가 뒤섞일 수 있었다. 사용자는 최신 설정을 다시 읽어 다시 수정한다. 자세한 순서는 3.1이다. | 기존 확정 |
| CCR-002 | 실행 중 참조만 막는 규칙이어서, Profile/Method 저장과 Job의 Profile 검증이 동시에 일어날 때의 경계가 분명하지 않았다. | Profile mutation fence, Job의 Profile reader, 정렬된 Job lock 순서로 참조와 Controller 상태를 다시 확인한다. | Job이 오래된 Profile/Method를 보고 시작하거나, 참조 중인 Method가 바뀌는 경합을 막기 위해서다. 자세한 순서는 3.2다. | 기존 확정 |
| CCR-003 | DataViewer가 `NAME`, `TIME`이라는 열 이름을 기본으로 가정할 수 있었다. | TAG metadata FLAG의 유일한 primary key와 basetime 열을 찾아 쓴다. 역할 열이 없거나 둘 이상이면 실패한다. | 정상 TAG table도 실제 열 이름이 다를 수 있다. 잘못된 열을 조용히 읽는 것보다 안전하게 오류를 내는 편이 맞다. | 기존 확정 |
| CCR-004 | 페이지를 넘겨도 행이 중복·누락되지 않는다고만 읽힐 수 있었다. | 한 응답 안에서는 basetime과 내부 `_RID` 정렬로 중복·누락을 막는다. 하지만 pagination은 snapshot이 아니므로 수집 중 새 행이 append되면 다음·이전 페이지의 구성은 달라질 수 있다. | 계속 수집되는 table에서는 offset 기준 행이 밀리는 것이 정상이다. 사용자가 이를 알맞은 동작으로 승인했으며, 고정 분석은 `to` 시간으로 범위를 고정한다. | 기존 확정 |
| CCR-005 | Job/Profile ID 길이와 lock 파일 키의 상한이 충분히 정해지지 않았다. | Job name과 Profile ID는 최대 100자이며, Profile reader lock에는 raw ID 대신 고정 64자 SHA-256 key를 쓴다. | 검증 전의 긴 입력도 경로 이탈이나 파일 이름 길이 초과를 만들지 않게 한다. | 기존 확정 |
| CCR-006 | DataViewer의 기본 시간대와 IANA 지역 시간대 지원 범위가 확정되지 않았다. | DB 저장값, API timestamp, DataViewer의 기본 표시와 `from`/`to` 조회 범위는 모두 UTC(`Z`)다. v1은 timezone 선택기와 지역 시간대 변환을 제공하지 않는다. | 수집 데이터의 기준 시간은 지역이 아닌 UTC여야 한다. 서울 고정 `+09:00`은 문제를 해결하지 못하며, IANA 처리에는 최소 JSH에 없는 `Intl`이 필요하다. 영향은 timezone 파라미터·입력칸 삭제와 UTC `Z` 범위 검증이다. | 승인됨 — 사용자 “승인 구현 시작” |

### 1.3 JSH 호환성 검토와 수정 설계

이 절은 공개 API나 시간 모델을 바꾸는 계약이 아니라, 최소 Neo 지원 약속을 지키기 위한 구현 검토 기록이다. 아래 수정은 JSH 통합 검증이 끝나기 전까지 완료로 선언하지 않는다.

- Neo `8.5.6`부터 확인한 `8.5.9`까지의 JSH에서 전역 `process`와 `Intl`, `fs.utimesSync`, `stat.mtimeMs`가 없었다. `require('process')`, `stat.mtime.unixMilli()`는 사용할 수 있었다.
- `6e8ec9d`의 Job operation lock은 전역 `process`, `fs.utimesSync`, `stat.mtimeMs`를 사용해 최소 JSH에서 실행 오류가 날 수 있다. 이것은 계약 변경이 아니라 수정해야 할 호환성 버그다.
- 수정 설계: 모든 process 접근은 `require('process')`로 통일한다. PID 확인 함수가 `false`를 반환하거나 반환·예외의 `code`가 `ESRCH`일 때만 종료로 보고 stale lock을 회수한다. `EPERM`과 알 수 없는 오류는 생존 여부를 확정할 수 없으므로 `JOB_CONFLICT`로 보호한다. 정상 Job lock은 owner JSON과 owner token별 heartbeat 파일로 만료를 판단해, 이전 owner가 새 owner의 lease를 갱신하지 못하게 한다. crash로 owner 문서가 완성되지 않은 경우에만 JSH의 `stat.mtime.unixMilli()`를 fallback으로 쓴다. 따라서 `utimesSync`와 `mtimeMs` 의존성을 제거한다.
- 검증: Node 단위 테스트와 최소 Neo 8.5.6 JSH smoke test에서 전역 `process`, `Intl`, `fs.utimesSync`, `mtimeMs` 없이 lock 획득·heartbeat·stale reclaim을 확인한다.
- JSH 통합 검증 전 상태는 계속 “실제 Neo/설비 통합 미검증”으로 표시한다.

## 2. 공통 모델

### 2.1 Settings

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

### 2.2 Profile과 Method

Profile은 `schemaVersion`, `id`, `profileVersion`, `displayName`, `vendor`, `builtIn`, `compatibility`, `defaults`, `methods`를 가진다. Built-in Profile은 `ls-electric-plc` 하나로 시작한다. compatibility의 최소 Neo는 `8.5.6`이다.

Method는 `id`, `displayName`, `objectPath`, `interface`, `methodName`, `inputs`, `output`, 선택 `tagGeneration`을 가진다. LS Method ID는 `get-device-data`, 이름은 `GetDeviceData`다. 입력은 `dataCount:uint16`, `memoryAddress:string`이고 output JSON의 `rtn === 1`, `data-count`, data array, Tag count가 일치해야 한다.

### 2.3 저장 Job document

```json
{
  "schemaVersion": 1,
  "name": "production-line",
  "revision": 1,
  "profileId": "ls-electric-plc",
  "dbus": { "busType": "system", "destination": "ls.plc" },
  "schedule": { "intervalMs": 1000 },
  "retry": { "initialDelayMs": 5000, "maximumDelayMs": 30000, "multiplier": 2 },
  "execution": { "savePolicy": "perMethod", "onMethodError": "stop" },
  "methodCalls": [
    {
      "id": "read-plc-data-1",
      "name": "Read PLC Data - Call 1",
      "methodId": "get-device-data",
      "inputs": { "dataCount": 1, "memoryAddress": "%MB3" },
      "tags": [
        {
          "outputIndex": 0,
          "sourceAddress": "%MB3",
          "name": "%MB3",
          "bias": 0,
          "multiplier": 1,
          "calcOrder": "bm"
        }
      ]
    }
  ],
  "database": { "server": "localhost", "table": "TAG", "valueColumn": "VALUE", "stringValueColumn": "STR_VALUE" },
  "log": { "level": "info", "maxFiles": 10 }
}
```

위 예시는 `conf.d/jobs/production-line.json`에 저장되는 document다. document top-level `name`은 파일명 `production-line`과 반드시 같아야 한다. `methodCalls`는 한 개 이상이다. 각 Call은 고정 ID, 표시 이름, methodId, raw inputs, outputIndex가 연속된 tags를 가진다. Tag는 `outputIndex`, `sourceAddress`, `name`, `bias`, `multiplier`, `calcOrder`를 가진다. Tag name은 TAG table의 `NAME VARCHAR(100)`에 맞춰 최대 100자다. `calcOrder`는 `bm` 또는 `mb`만 가능하다.

`database.valueColumn`은 필수 숫자 column이고 `database.stringValueColumn`은 선택 문자열 column이다. 문자열 column을 쓰지 않을 때는 `""`로 저장한다. 숫자 output만 bias/multiplier Transform을 적용해 `valueColumn`에 저장한다. 문자열 output은 Transform 없이 그대로 `stringValueColumn`에 저장한다. object output도 Transform하지 않고 `JSON.stringify` 결과를 `stringValueColumn`에 저장한다. 문자열 column이 없는 Job에서 문자열 또는 object output을 저장하려 하면 cycle은 `DB_APPEND_FAILED`로 실패한다. DataViewer Chart는 숫자 column만 사용하고 Grid는 선택 문자열 column이 있을 때 문자열 값을 함께 보여 준다.

API create/patch의 `config`은 저장 document에서 top-level `name`과 `revision`을 뺀 객체다. Backend만 검증된 바깥 Job 이름을 document, 파일명, service name에 넣는다. `revision`은 Backend가 생성·증가시키는 정수이며 config 안에는 넣지 않는다.

### 2.4 상태 응답

```json
{
  "name": "production-line",
  "revision": 3,
  "configState": "installed",
  "executionState": "running",
  "controllerState": "RUNNING",
  "controllerDetail": null
}
```

- `configState`: Controller 상태를 알면 `config-only` 또는 `installed`, 알 수 없으면 `null`
- `executionState`: Controller 상태를 알면 `running` 또는 `stopped`, 알 수 없으면 `null`
- `statusKnown`: 두 요약 상태를 신뢰할 수 있으면 `true`, Controller 조회 실패 또는 `UNKNOWN`이면 `false`
- `controllerState`: `RUNNING`, `STARTING`, `STOPPING`, `STOPPED`, `FAILED`, `UNKNOWN`, `NOT_INSTALLED`
- `controllerDetail`: Controller가 제공한 설명 또는 `null`
- `revision`: GET/POST/PUT Job 상세 응답의 현재 설정 revision. Job 수정 PUT은 이 값을 보낸다.

## 3. 상태 전이와 동작 권한

```text
POST /job                 → config-only + stopped + NOT_INSTALLED
POST /job/install         → installed + stopped + STOPPED
POST /job/start           → installed + running + STARTING/RUNNING
POST /job/stop            → installed + stopped + STOPPING/STOPPED
DELETE /job (정지 상태만)  → 설정과 service 제거
```

| 현재 상태 | install | start | stop | edit | delete |
|---|---:|---:|---:|---:|---:|
| config-only | 가능 | 불가 | 불가 | 가능 | 가능 |
| installed + stopped/failed | 불가 | 가능 | 불가 | 가능 | 가능 |
| installed + running/starting/stopping | 불가 | 불가 | 가능 또는 전환 대기 | 불가 | 불가 |
| UNKNOWN | 불가 | 불가 | 불가 | 불가 | 불가 |

start는 이미 설치된 Job만 허용한다. `STARTING`과 `STOPPING`은 완료될 때까지 새 lifecycle 요청을 받지 않는다. update/delete가 실행 중이면 HTTP 409과 `JOB_RUNNING`을 반환한다. Custom Profile/Method update도 running 참조 Job이 있으면 HTTP 409이다.

### 3.1 Job mutation operation lock과 lease

같은 Job의 POST create/install/start/stop, PUT update, DELETE와 package stop/uninstall은 하나의 mutation operation이다. Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 `operation lock`을 유지한다. Package stop/uninstall은 package lifecycle fence를 먼저 잡고, 그 안에서 목록을 읽은 뒤 대상 Job lock을 이름순으로 모두 잡은 채 전체 작업을 끝낸다. 그래서 먼저 처리된 Job도 마지막 Job이 끝나기 전에는 API가 다시 바꾸지 못하고, 대상 목록에 없던 새 이름의 Create도 `JOB_CONFLICT`로 막힌다. GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다.

Package stop은 목록에서 상태를 아는 모든 configured Job을 `stopForPackage()`로 검사한다. 단, package start checkpoint에는 stop 직전 `RUNNING`, `STARTING`, `STOPPING`이었던 Job만 저장한다. Package lifecycle은 Job lock 일부만 잡다가 충돌해도 이미 잡은 lock과 fence를 모두 풀고 실패한다. 이 실패는 `PACKAGE_LIFECYCLE_FAILED`이며 원래 `JOB_CONFLICT`를 `details.errors[]`에 보존하므로 호출자가 안전하게 재시도할 수 있다. API mutation은 읽기 전용 availability probe로 fence 상태를 확인하고 Job lock을 잡은 뒤 같은 probe로 다시 확인한다. Probe는 canonical fence가 없거나 lease가 지났고 owner PID가 종료됐으면 available로 판단하며 어떤 lock도 만들거나 회수하지 않는다. Fresh fence, 살아 있는 owner, PID 판단 오류는 `JOB_CONFLICT`다. 실제 stale 회수는 package lifecycle의 exclusive acquire만 수행한다. Reclaim rename 중 canonical이 잠깐 없어 첫 probe가 통과해도 안전하다. API가 Job lock을 잡은 뒤 replacement fence가 보이면 두 번째 probe가 실패하고, package가 먼저 replacement fence를 잡고 API가 가진 Job lock에 도달하면 package 쪽이 실패하므로 둘이 함께 side effect를 실행할 수 없다. Package session 해제는 성공한 Job handle만 제거하고 실패한 handle과 fence는 보존한다. 모든 Job handle이 해제된 뒤에만 fence를 풀며, 실패한 같은 `session.release()`를 재시도할 수 있다.

lock은 `owner token`과 `heartbeat` 시각을 가진다. owner는 CGI 요청이 끝날 때 heartbeat를 중지하고 자기 token의 lock만 해제한다. lease가 지났고 `owner PID`가 종료되었다고 확인된 lock만 고유 quarantine 이름으로 원자 이동한 뒤 회수한다. PID 생존 여부를 확인할 수 없으면 안전하게 회수하지 않고 `JOB_CONFLICT`를 반환한다. 이전 owner는 Controller 호출이나 설정 파일 변경 같은 side effect 직전에 token을 다시 확인하며, 소유권을 잃었으면 `JOB_CONFLICT`로 중단한다. 이전 owner는 새 owner의 lock을 갱신하거나 해제할 수 없다.

Custom Profile/Method의 POST/PUT는 Profile mutation fence를 먼저 잡고 참조 Job lock을 이름순으로 모두 잡은 뒤 참조와 Controller 상태를 다시 읽고 저장한다. DELETE는 Profile mutation fence와 기존 Profile reader 확인 뒤 참조를 다시 읽고, 참조 Job이 하나라도 있으면 Controller 상태나 Job lock을 확인하지 않고 거부한다. Job create/update/start는 package lifecycle probe 뒤 Job lock을 먼저 잡고, 최신 Job config의 Profile reader lock을 잡은 뒤 Profile을 다시 검증한다. 전역 순서는 package lifecycle probe → Job lock → Profile reader이며, 배타 Profile 변경은 Profile fence → reader 확인 → 정렬된 Job lock이다.

Profile ID와 Job name은 각각 ASCII 영문 소문자·숫자·`-`(Job은 `_`도 허용)만 사용하고 최대 100자다. Profile reader lock은 raw ID 대신 고정 64자의 SHA-256 Profile key를 써서 `<sha256ProfileKey>--<jobName>`으로 만들므로, 검증 전의 긴 잘못된 ID도 경로 밖 접근이나 파일 이름 초과를 만들지 않는다.

canonical Job lock owner 문서도 initial acquire와 stale replacement에서 임시 파일을 완성한 뒤 원자 publish한다. fresh empty/temp-only/malformed owner와 여러 final 또는 final+temp처럼 모호한 owner는 `JOB_CONFLICT`로 보호한다. lease가 지난 empty/temp-only/malformed canonical lock만 orphan으로 고유 quarantine 이름에 원자 이동해 회수한다.

canonical과 reclaim mutex의 공용 owner schema는 비어 있지 않은 `token`, 0보다 큰 safe integer `pid`, 유한한 `acquiredAt`/`heartbeatAt`, `heartbeatAt >= acquiredAt`을 요구한다. schema가 잘못된 owner는 PID 확인 함수에 넘기지 않고 incomplete로 취급한다. fresh이면 `JOB_CONFLICT`로 보호하고 lease가 지난 뒤에만 orphan quarantine 회수한다.

stale 회수를 직렬화하는 `reclaim mutex`도 no-clobber 원자 생성한 고유 owner 문서에 `token`, `pid`, `acquiredAt`, `heartbeatAt`을 기록한다. owner 문서는 임시 파일을 완성한 뒤 원자 publish한다. fresh mutex, 살아 있는 owner, PID 판정 오류, 여러 owner 문서처럼 모호한 mutex는 `JOB_CONFLICT`로 보호한다. owner 문서가 없거나 완성되지 않은 orphan mutex와 lease가 지나고 owner PID 종료가 확인된 mutex만 고유 quarantine 이름으로 원자 이동해 회수하며, 이전 mutex owner는 자기 token 문서만 지워 새 owner mutex를 삭제할 수 없다.

initial canonical owner publish가 실패한 요청은 canonical 경로를 무조건 지우지 않는다. 자기 token의 소유권을 원자적으로 확인할 수 없으면 fresh incomplete를 남겨 `JOB_CONFLICT`로 보호하고, lease가 지난 뒤 orphan quarantine 회수를 허용한다. reclaim mutex는 고유 pending 디렉터리에서 owner를 완성한 뒤 채워진 디렉터리 전체를 canonical 경로로 원자 publish하므로 빈 새 mutex를 노출하지 않는다. publish 중 경로를 잃거나 유효한 다른 owner가 있으면 이전 요청은 `JOB_CONFLICT`로 실패하며 새 owner를 갱신하거나 삭제하지 않는다.

이전 mutex owner가 owner 문서를 지운 직후 stale 회수자가 들어와도, 새 owner는 채워진 mutex만 publish한다. 따라서 이전 owner의 뒤늦은 `rmdir`은 새 owner가 있는 mutex를 지우지 못한다.

회귀 테스트는 이전 owner의 실제 `rmdir` wrapper에서 B의 공개 acquire를 시작한다. B가 채워진 mutex를 publish하면 B 훅은 wrapper의 continuation만 재개하고, wrapper가 저장해 둔 원본 `rmdirSync`를 정확히 한 번 호출해 발생한 `ENOTEMPTY`와 B owner 보존을 확인한다. B의 실제 mutex 해제와 handle 해제 뒤 C가 같은 Job을 다시 획득·검사·해제하는 과정도 확인한다. 또한 crash로 남은 다른 token의 `.reclaim.pending-*`가 있어도 B와 C의 실제 handle 흐름을 막지 않는지 확인한다.

| 먼저 실행된 작업 | 뒤 작업 | 결과 |
|---|---|---|
| API Start | package stop/uninstall | package lifecycle 실패; aggregate에 `JOB_CONFLICT` 보존 |
| package stop | API Start | API Start `JOB_CONFLICT`; Controller start 금지 |
| package uninstall Delete | API Create/Update | 뒤 API `JOB_CONFLICT`; uninstall 성공 뒤 설정 재생성 금지 |
| package stop/uninstall | 새 이름 Create | 뒤 API `JOB_CONFLICT`; 대상 목록 밖의 설정 생성 금지 |

파일명과 document top-level name이 다르면 `JOB_INVALID_CONFIG`이다. 목록과 상세는 진단 목적으로 오류를 보여 줄 수 있지만 install/start/stop/update/delete는 모두 막는다. 이 상태를 자동으로 고치거나 이름을 추측하지 않는다.

FE의 Side switch는 install control이 아니다. config-only Job 행에서는 switch를 숨기거나 disabled 상태로만 보이고, Main 상세의 전용 Install 버튼이 `POST /job/install`을 호출한다. switch는 installed Job의 Start/Stop만 호출한다.

install은 config-only Job의 JSON을 그대로 사용해 아래 descriptor를 Controller에 등록한다. `enable: true`는 Controller 재시작 뒤 설치 Job을 시작 대상으로 유지한다. create는 descriptor를 만들거나 등록하지 않는다.

```json
{
  "name": "_dbu_production-line",
  "enable": true,
  "working_dir": "<package>/cgi-bin",
  "executable": "<package>/cgi-bin/neo-collector.js",
  "args": ["production-line.json"]
}
```

## 4. API 목록과 envelope

모든 경로는 `/cgi-bin/api` 아래다.

| Method | 경로 | 입력 | 성공 data |
|---|---|---|---|
| GET | `/settings` | 없음 | Settings |
| PUT | `/settings` | defaultProfileId, limits | Settings |
| GET | `/profile/list` | 없음 | Profile 요약 배열 |
| GET | `/profile?id=` | profile ID | Profile와 호환·참조 정보 |
| POST/PUT/DELETE | `/profile` | Profile body 또는 id | Custom Profile 결과 |
| GET | `/method/list?profileId=` | Profile ID | Method 요약 배열 |
| GET/POST/PUT/DELETE | `/method` | profileId, id, Method | Method 결과 |
| GET | `/job/list` | 없음 | Job 요약 배열 |
| GET | `/job?name=` | Job 이름 | `{name, config, 상태}` |
| POST | `/job` | `{name, config}`; `config.name` 금지 | 생성된 config-only Job |
| PUT | `/job?name=` | name 없는 부분 config patch | 수정된 Job |
| DELETE | `/job?name=` | 없음 | 삭제 Job 이름 |
| POST | `/job/validate` | Job draft | valid와 warnings |
| POST | `/job/install?name=` | 없음 | 설치 상태 |
| POST | `/job/start?name=` | 없음 | 시작 상태 |
| POST | `/job/stop?name=` | 없음 | 정지 상태 |
| GET | `/job/last-run?name=` | Job 이름 | `{lastRun}` |
| POST | `/dbus/call` | Profile, Method, DBus, inputs | Test Call 결과 |
| POST/GET/PUT/DELETE | `/db/server` | DB Server CRUD | 등록 DB Server |
| GET | `/db/server/list` | 없음 | DB Server 목록 |
| GET | `/db/connect?server=` | 등록 이름 | 연결 확인 결과 |
| POST | `/db/table/create` | server와 table 정의 | 생성된 TAG table |
| GET | `/db/table/list` | server | table 목록 |
| GET | `/db/table/columns` | server, table | column과 TAG metadata |
| GET | `/db/table/tags` | server, table | Tag 후보 |
| GET | `/db/table/data` | Job DB 설정, Tag, cursor, UTC 시간 범위 | Grid 행과 다음/이전 cursor |
| GET | `/db/table/chart` | Job DB 설정, 숫자 Tag, UTC 시간 범위 | 차트 series |

| GET | `/log/all` | 없음 | 전체 Job 로그 요약 |
| GET | `/log/list?name=` | Job 이름 | 로그 파일 목록 |
| GET | `/log/content?name=` | Job 이름과 파일 | 로그 내용 |
| GET | `/log/content/all?name=` | Job 이름과 파일 | 로그 전체 내용 |
| GET | `/log/tail?name=` | Job 이름과 파일 | 로그 마지막 부분 |

DataViewer의 시간 계약은 UTC다. 저장·API timestamp·화면 표시·`from`/`to` 시간 범위는 모두 `Z`가 붙은 UTC ISO-8601 값으로 처리한다. v1 API는 별도 timezone 파라미터와 IANA 이름(`Asia/Seoul` 등), 고정 offset(`+09:00` 등)을 지원하지 않으며, timezone 파라미터가 오면 HTTP 400 `TIMEZONE_UNSUPPORTED`로 거부한다.

GET query string은 최대 128KiB로 제한한다. 비ASCII 문자를 포함해 최대 100자인 Tag name 100개와 bounded cursor를 함께 보내는 정상 DataViewer 요청은 이 범위 안에서 처리하고, 초과 요청은 HTTP 413 `REQUEST_TOO_LARGE`로 거부한다.

DataViewer cursor는 FE가 내용을 해석하지 않는 opaque `{side, page}` token이다. Backend는 각 Tag를 `page * rowsPerTag` offset으로 조회하고 basetime column 다음에 내부 `_RID`를 같은 방향으로 정렬한다. 한 응답 안에서는 같은 시간의 행도 빠지거나 겹치지 않으며, `_RID`는 API 응답에 노출하지 않는다. Grid pagination은 snapshot이 아니다. 조회 사이 새 행이 append되면 다음·이전 페이지의 행 구성은 달라질 수 있다. 고정된 분석 범위가 필요하면 `to` 시간을 지정한다.

DataViewer의 `/db/table/tags`, `/db/table/data`, `/db/table/chart`는 `/db/table/columns`와 같은 TAG metadata FLAG에서 `primaryKey === true`와 `basetime === true`인 실제 column 이름을 자동으로 사용한다. FE는 `primaryColumn`과 `timeColumn`을 보내지 않는다. 관리 도구가 두 값을 명시해 보낼 때도 Backend는 metadata의 같은 역할 column인지 검증하고, `NAME`·`TIME`이라는 이름을 기본값으로 가정하지 않는다.

성공 예시:

```json
{ "ok": true, "data": { "name": "production-line" } }
```

실패 예시:

```json
{
  "ok": false,
  "code": "JOB_RUNNING",
  "reason": "running job cannot be updated or deleted",
  "details": { "name": "production-line", "controllerState": "RUNNING" }
}
```

FE는 `reason`을 표시하고 `code`로 비활성화 이유를 안내한다. 요청은 사용자 취소만 AbortSignal으로 처리하며 timeout으로 취소하지 않는다.

Job API 이름 규칙은 다음과 같다.

- POST body의 바깥 `name`은 새 Job의 유일한 식별자다. `config`에 `name`이 있으면 HTTP 400 `JOB_INVALID`이다.
- PUT은 query의 `name`을 고정 식별자로 사용한다. body는 부분 config patch이고 `name`을 포함하면 HTTP 409 `JOB_NAME_IMMUTABLE`이다.
- PUT body는 `revision`과 name 없는 부분 config patch다. `revision`이 없으면 `JOB_REVISION_REQUIRED`, 저장 직전 현재 revision과 다르면 HTTP 409 `JOB_CONFLICT`다. 성공 저장 때 revision은 1 증가한다. 병합 순서는 `defaults → existing config → request patch`다. 객체는 깊이 병합하고 배열은 request 배열 전체로 교체한다.
- Backend는 바깥 또는 query name을 저장 document top-level name, `<jobName>.json`, `_dbu_<jobName>`에만 쓴다. 저장 name과 파일명이 다르면 `JOB_INVALID_CONFIG`이고 모든 위험 동작을 차단한다.
- Job mutation은 `operation lock`을 획득한 뒤 상태를 조회하고, Controller side effect와 설정 파일 변경이 끝날 때까지 유지한다. lock의 `owner token`과 `heartbeat` lease 회수 규칙은 **3.1 Job mutation operation lock과 lease**를 따르며, 다른 mutation이나 소유권을 잃은 이전 owner는 HTTP 409 `JOB_CONFLICT`다.

DB Server 관리 화면은 등록 목록을 읽고, Create/Edit/Delete와 Test Connection을 제공한다. Job form은 등록 server를 고른 뒤 table 목록·column metadata를 읽어 DB mapping을 구성한다. 비밀번호는 등록 DB Server 저장소 밖으로 복사하지 않으며 Job config, 목록, 로그, 오류에 나타나지 않는다. DataViewer는 Job → Method Call → Tag tree만 기본으로 만들고, DB table 전체 Tag를 자동 노출하지 않는다.

## 5. 구현 순서

### 단계 1: 기존 예제 경계 제거와 공통 기반

1. 기존 CounterStore, counter 결과 파일, worker 카운터 동작, `_np_neo_pkg_dbus_` 접두사와 `/jobs/*` API를 제거한다.
2. 공통 HTTP helper를 새 envelope와 HTTP 400/404/409/503 매핑으로 바꾼다.
3. 설정·Profile·Job schemaVersion 1 loader, validator, atomic writer를 만든다.
4. 새 service name helper `_dbu_<jobName>`와 Controller 상태 adapter를 만든다.

완료 기준: 제품 소스와 테스트에서 CounterStore·counter 결과·`_np_neo_pkg_dbus_`가 사라지고, 새 envelope 단위 테스트가 통과한다.

### 단계 2: Profile·Job·lifecycle API

1. Built-in LS Profile asset과 Custom Profile 저장소를 만든다.
2. Profile/Method validation, 참조 분석, 실행 중 변경 차단을 만든다.
3. Job CRUD, config-only install, installed start/stop, 정지 상태 delete를 만든다.
4. 목록·상세에 분리된 상태 모델과 Controller 원본 상태를 넣는다.

완료 기준: 실행 중 PUT/DELETE가 `JOB_RUNNING`, running 참조 Profile/Method 변경이 409, config-only/installed/running의 분리가 API 테스트로 확인된다.

### 단계 3: Collector와 DBus 실행

1. typed argument builder, simple path decoder, LS Tag generator, Transform을 구현한다.
2. Job별 `neo-collector.js`와 scheduler/backoff, connection 재사용, shutdown 정리를 구현한다.
3. perMethod/afterAllMethods row 저장과 lastRun service details를 구현한다.
4. Test Call과 DBus/DB/Controller 실제 JSH 연결을 확인한다.

완료 기준: LS 응답 count 불일치는 저장 없이 실패하고, 정상 cycle은 Tag 값과 lastRun을 남기며, timeout 관련 구현이 없다.

### 단계 4: Side/Main 프런트엔드

1. API client에서 timeout AbortController와 legacy `/jobs/*` 호출을 제거하고 새 envelope를 해석한다.
2. Side 목록과 Main 상세가 분리 상태·전환 상태·차단 사유를 표시하게 만든다.
3. Job/Profile/Method forms, Tag 생성·일괄 편집·Test Call을 구현한다.
4. Job → Method Call → Tag DataViewer와 로그 화면을 연결한다.

완료 기준: `DESIGN.md` 토큰만 사용하고, Side/Main이 같은 선택 상태를 공유하며, 실행 중 Edit/Delete가 UI와 API에서 모두 차단된다.

### 단계 5: 통합 검증과 문서

1. Node 단위 테스트와 JSH 통합 테스트를 실행한다.
2. Neo 8.5.6 환경에서 System Bus, LS PLC, service lifecycle, TAG append, DataViewer를 점검한다.
3. README와 API 예시를 새 DBus 모델로 교체한다.

완료 기준: 아래 완료 게이트가 모두 충족된다.

## 6. 테스트와 완료 게이트

Node 단위 테스트는 schema validation, path decoder, typed args, LS address/tag generator, Transform, retry delay, save policy buffering, API envelope, lifecycle 권한을 검증한다. API 테스트는 다음을 반드시 포함한다.

- config-only 생성 후 install, start, stop, delete 전이
- running/starting/stopping Job의 update/delete 거부
- running 참조 Custom Profile/Method update/delete 거부
- `GetDeviceData` 성공·`rtn` 실패·JSON 실패·count 불일치
- perMethod partial 저장과 afterAllMethods 무저장
- `UNKNOWN` Controller 상태의 위험 동작 차단
- 모든 실패 응답의 `ok/code/reason/details` 구조

JSH 통합 테스트는 `require("dbus")`, System Bus 연결, `ls.plc` owner와 `GetDeviceData`, Job별 service install/start/stop/uninstall, shutdown close, service details lastRun, Machbase TAG append, DataViewer query를 확인한다.

완료 게이트:

1. 최소 Neo `8.5.6`에서 Side/Main 기능이 동작한다.
2. 새 설정·Profile·Job은 모두 schemaVersion `1`이고 defaultProfileId는 `ls-electric-plc`다.
3. service는 `_dbu_<jobName>`만 사용한다.
4. running Job과 running 참조 Custom 설정은 변경·삭제되지 않는다.
5. config-only/installed/running/Controller 상태가 API와 화면에서 분리된다.
6. API는 새 envelope만 사용하고 timeout 로직이 없다.
7. counter 호환 코드와 legacy `/jobs/*` 계약이 없다.
8. `DESIGN.md`를 바꾸지 않고 지정된 디자인 토큰과 접근성 규칙을 지킨다.
