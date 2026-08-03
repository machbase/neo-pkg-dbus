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
8. 여러 관리자가 동시에 수정하지 못하게 하는 잠금은 제공하지 않는다. 서버 validation과 최신 재조회로 충돌을 알린다.
9. 기존 counter JSON, counter store, `_np_neo_pkg_dbus_` service 이름, `/jobs/*` API, legacy config 병합은 호환하지 않는다.

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

### 2.3 Job

```json
{
  "schemaVersion": 1,
  "name": "production-line",
  "profileId": "ls-electric-plc",
  "dbus": { "busType": "system", "destination": "ls.plc" },
  "schedule": { "intervalMs": 1000 },
  "retry": { "initialDelayMs": 5000, "maximumDelayMs": 30000, "multiplier": 2 },
  "execution": { "savePolicy": "perMethod", "onMethodError": "stop" },
  "methodCalls": [],
  "database": { "server": "localhost", "table": "TAG", "valueColumn": "VALUE", "stringValueColumn": "STR_VALUE" },
  "log": { "level": "info", "maxFiles": 10 }
}
```

`methodCalls`는 한 개 이상이다. 각 Call은 고정 ID, 표시 이름, methodId, raw inputs, outputIndex가 연속된 tags를 가진다. Tag는 `outputIndex`, `sourceAddress`, `name`, `bias`, `multiplier`, `calcOrder`를 가진다. `calcOrder`는 `bm` 또는 `mb`만 가능하다.

### 2.4 상태 응답

```json
{
  "name": "production-line",
  "configState": "installed",
  "executionState": "running",
  "controllerState": "RUNNING",
  "controllerDetail": null
}
```

- `configState`: `config-only` 또는 `installed`
- `executionState`: `running` 또는 `stopped`
- `controllerState`: `RUNNING`, `STARTING`, `STOPPING`, `STOPPED`, `FAILED`, `UNKNOWN`, `NOT_INSTALLED`
- `controllerDetail`: Controller가 제공한 설명 또는 `null`

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
| GET | `/job?name=` | Job 이름 | config와 상태 |
| POST | `/job` | `{name, config}` | 생성된 config-only Job |
| PUT | `/job?name=` | 전체 Job config | 수정된 Job |
| DELETE | `/job?name=` | 없음 | 삭제 Job 이름 |
| POST | `/job/validate` | Job draft | valid와 warnings |
| POST | `/job/install?name=` | 없음 | 설치 상태 |
| POST | `/job/start?name=` | 없음 | 시작 상태 |
| POST | `/job/stop?name=` | 없음 | 정지 상태 |
| GET | `/job/last-run?name=` | Job 이름 | `{lastRun}` |
| POST | `/dbus/call` | Profile, Method, DBus, inputs | Test Call 결과 |
| GET/POST/PUT/DELETE | `/db/**`, `/log/**` | DataViewer/로그 요청 | 각 기능 결과 |

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
