# DBus Collector Frontend 설계서

## 1. 목적과 고정 범위

이 문서는 `neo-pkg-dbus`의 화면과 사용자 동작을 정의한다. 구현 범위는 **Side**와 **Main**이다. 시각 규칙은 저장소 루트 `DESIGN.md`를 유일한 기준으로 사용하며, 이 문서는 색·글꼴·간격·모서리 값을 새로 정하지 않는다.

수집 대상은 Linux System Bus의 LS ELECTRIC PLC다. 기본 Profile은 `ls-electric-plc`이고 기본 Method는 `GetDeviceData`다. 사용자는 Custom Profile과 Custom Method도 만들 수 있다. 패키지 최소 Neo 버전은 `8.5.6`이다.

화면은 다음을 제공한다.

- Job 생성, 조회, 정지된 Job 수정, 삭제, 설치, 시작, 정지
- Built-in Profile 조회와 Custom Profile/Method 관리
- Method Call을 순서대로 구성하고 입력값에 따라 Tag를 자동 생성·일괄 편집
- Test Call, 직전 cycle 결과, Job 기준 DataViewer, 로그 조회

Write 전용 화면과 Built-in Write Method는 제공하지 않는다. Custom Method가 외부 상태를 바꿀 수 있는지는 사용자가 확인한다.

## 2. 화면 구조와 디자인 규칙

```text
DBus Collector
├─ Side: Job 목록, 선택, 시작/정지, 새 Job
└─ Main: Job 상세·편집, Profile 관리, DataViewer, Log Viewer
```

- Side는 `DESIGN.md`의 256px Side panel, 40px 헤더, 22px 목록 헤더, 28px Job 행을 사용한다.
- 통합 화면은 Side와 Main을 두 열로 유지한다. 600px 이하에서도 Side를 아래로 쌓지 않는다.
- Main의 상세·생성 헤더, 카드, 입력, 상태 메시지, 버튼, 포커스, 접근성은 `DESIGN.md`의 공용 컴포넌트 규칙을 그대로 따른다.
- Side에서는 switch만 시작/정지를 담당한다. Side가 있는 Main 상세에는 Start/Stop 버튼을 중복해 표시하지 않는다.
- 긴 이름은 말줄임표 또는 `overflow-wrap: anywhere`를 사용하고 모든 grid 자식에는 `min-width: 0`을 둔다.

## 3. 공통 상태 모델

화면은 하나의 `status` 문자열로 모든 사실을 합치지 않는다. 목록과 상세가 받는 Job 상태는 다음 네 값을 함께 보존한다.

| 값 | 종류 | 뜻 |
|---|---|---|
| `configState` | 설정 | `config-only` 또는 `installed` |
| `executionState` | 실행 | `running` 또는 `stopped` |
| `controllerState` | Controller 원본 | `RUNNING`, `STARTING`, `STOPPING`, `STOPPED`, `FAILED`, `UNKNOWN`, `NOT_INSTALLED` |
| `controllerDetail` | Controller 진단 | 원본 오류 요약 또는 `null` |

- `config-only`는 Job JSON은 있으나 service가 설치되지 않은 상태다.
- `installed`는 service가 설치된 상태다. `installed`와 `stopped`는 서로 다른 축이다.
- `running`은 설치된 service가 실행 중인 상태다.
- `STARTING`과 `STOPPING`은 전환 상태다. 시작·정지·설치·삭제·저장 control을 모두 비활성화한다.
- Controller를 읽지 못하면 `controllerState: "UNKNOWN"`으로 표시하고 추측으로 실행 중이라고 표시하지 않는다.

Job 목록의 허용 동작은 아래와 같다.

| 상태 | Side switch | Main Edit/Delete |
|---|---|---|
| config-only | Install | 가능 |
| installed + stopped/failed | Start | 가능 |
| installed + running/starting/stopping | Stop 또는 전환 대기 | 불가 |
| Controller UNKNOWN | 불가 | 불가 |

`running`, `STARTING`, `STOPPING`인 Job은 Job Edit와 Delete를 차단한다. 이 규칙은 화면 편의가 아니라 Backend 규칙을 반영한다. 다른 관리자가 동시에 수정하는 잠금 기능은 제공하지 않으므로, 저장 충돌은 최신 서버 응답을 다시 읽어 사용자에게 보여 준다.

## 4. Job 목록과 상세

목록에는 Job Name, Profile, DBus Destination, Method Call 수, `configState`, `executionState`, Controller 상태, 마지막 저장 시각을 표시한다. 같은 Destination을 쓰는 여러 Job은 동시에 실행할 수 있으며, 순서 보장은 한 Job의 Method Call 안에서만 적용된다.

상세에는 Job 이름, Profile, 실행 상태, Run Interval, Retry Backoff, Method Call 수, DB server/table/column mapping, 직전 실행 결과, Edit/Delete/DataViewer/Log 동작을 표시한다. DBus 호출 timeout은 제공하지 않으므로 입력·표시·API 옵션에 넣지 않는다.

직전 실행 결과는 누적 이력이 아니다. 마지막 cycle 한 건과 그 안의 Method별 결과만 표시한다. 실행 전에는 `No run result yet`를 표시한다. 원본 DBus body와 추출된 값은 이 화면에서 보관하지 않는다.

## 5. Job 생성과 수정

### 기본 정보

| 필드 | 필수 | 규칙 |
|---|---|---|
| Job Name | 예 | 영문 소문자·숫자·`_`·`-`; 생성 뒤 변경 불가 |
| PLC Profile | 예 | 새 Job의 기본값은 settings의 `defaultProfileId` |
| Bus Type | 예 | Profile 기본값을 시작값으로 사용 |
| Service Name | 표시 전용 | `_dbu_<jobName>`으로 Backend가 결정 |

기본 Profile 변경은 새 Job의 초기 선택만 바꾸며 기존 Job은 바꾸지 않는다. 실행 중 Job은 편집 화면으로 들어갈 수 없고 API도 변경을 거부한다.

### 실행·저장·DB 설정

- 기본 Run Interval은 1,000ms다.
- 실패 시 다음 cycle은 5초, 10초, 20초, 이후 30초 간격으로 재시도한다. 같은 cycle에서 Method를 반복하지 않는다.
- `perMethod`는 성공한 Method마다 저장한다. `afterAllMethods`는 모든 Method 성공 뒤 한 번 저장을 시도한다. 둘 다 DB 트랜잭션 원자성을 약속하지 않는다.
- 등록 DB Server, TAG Table, 숫자 Value Column, 선택 String Value Column을 고른다. primary key와 basetime column의 이름은 고정하지 않는다.

### Method Call과 Tag

Job에는 Method Call이 하나 이상 필요하고 화면 순서가 실행 순서다. drag-and-drop과 키보드로 쓸 수 있는 위/아래 이동 버튼을 모두 제공한다. 각 Call은 이름, Method, 입력 요약, Tag 수, 수정·삭제 동작을 표시한다.

입력 editor는 `inputs[].editor` 또는 `dbusType`으로 고른다. FE는 `type:value` 문자열을 만들지 않고 원시값만 전송한다. Backend가 Method 정의 순서에 맞춰 type hint를 만든다.

LS `GetDeviceData`에서 `dataCount: 3`, `memoryAddress: "%MB3"`이면 `%MB3`, `%MB4`, `%MB5` Tag를 준비한다. `incrementTrailingNumber` 전략만 1차 지원한다. 알 수 없는 전략은 Profile 비호환으로 표시하고 저장·시작을 막는다.

자동 생성 Tag에서 이름이나 Transform을 사용자가 바꾼 경우 입력 변경으로 덮어쓰지 않는다. `Add Missing Only`, `Regenerate All`, `Cancel`을 제공하고, 수가 줄어 삭제될 행은 확인한다. 저장 전에는 빈 이름, Job 안의 중복 이름, Tag 최대 길이, 유한하지 않은 bias/multiplier, 기대 반환 수 불일치를 검사한다.

Transform은 다음 두 가지뿐이다.

```text
bm: (value + bias) × multiplier
mb: value × multiplier + bias
```

일괄 편집은 선택 행의 prefix/suffix, 찾기/바꾸기, 줄 단위 이름 붙여넣기, bias, multiplier, 계산 순서, Transform 초기화를 preview와 함께 제공한다. 다른 Job과 같은 DB/Table에 같은 Tag 이름이 있으면 경고하지만 저장을 막지 않는다.

## 6. Profile과 Method 관리

Profile 목록은 display name, vendor, Built-in/Custom, profileVersion, 최소 Neo 버전, Method 수, 호환 상태, 기본 여부를 표시한다.

- Built-in Profile은 읽기 전용이다. 수정·삭제 버튼을 표시하지 않는다.
- Custom Profile은 생성·수정·삭제할 수 있다.
- Custom Profile 또는 Method를 참조하는 Job이 `running`, `STARTING`, `STOPPING`이면 수정·삭제를 차단한다.
- Custom Profile을 참조하는 Job이 하나라도 있으면 Profile 삭제를 차단한다. Method도 참조 중이면 삭제를 차단한다.
- Custom Method 화면은 반복 호출 안전성을 사용자가 확인해야 한다는 안내만 보이며, method 이름으로 호출을 차단하지 않는다.

## 7. Test Call, DataViewer, 접근성

Test Call은 저장되지 않은 현재 Profile/Method, Bus/Destination, 원시 Inputs로 호출한다. 결과에는 호출 시각, 소요 시간, 성공 여부, 추출 값 수, 반환 count, Tag preview를 표시한다. 원본 body는 접을 수 있는 진단 영역에서만 보여 주고 저장하지 않는다.

DataViewer는 Job → Method Call → Tag tree를 사용한다. 현재 Job 설정의 Tag만 기본으로 보이며, 같은 table의 다른 Job Tag나 이름 변경 전 과거 Tag를 자동으로 넣지 않는다. Grid는 문자열 값도 보여 주고 Chart는 숫자 Value Column Tag만 선택할 수 있다. Raw/Grid, Chart, 시간 범위, timezone, cursor pagination, rows per tag, 앞/뒤 이동을 제공한다.

icon button에는 `aria-label`과 title을 둔다. 상태는 색과 텍스트를 함께 표시하고 오류는 `role="alert"`, 경고는 `role="status"`, 첫 로딩은 `aria-live="polite"`를 사용한다. 대량 Tag 변경은 변경 건수와 preview를 먼저 보여 준다.

## 8. API 사용 원칙

API base path는 `/cgi-bin/api`다. 모든 성공 응답은 `{ "ok": true, "data": ... }`, 실패 응답은 `{ "ok": false, "code", "reason", "details" }`다. FE는 `reason`을 사람에게 보여 주고 `code`로 control과 화면 위치를 고른다.

브라우저 요청에는 인위적인 timeout을 두지 않는다. 사용자가 취소하거나 화면이 닫힐 때만 AbortSignal을 전달한다. `Request timed out` UI와 timeout 상수는 없다.

사용 API는 settings, profile, method, job, job/validate, job/install, job/start, job/stop, job/last-run, dbus/call, db/**, log/**이며, 각 요청·응답 필드는 `BE_DESIGN.md`와 `DBUS_SDD.md`를 따른다.
