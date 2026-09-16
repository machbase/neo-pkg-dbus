# DBus Collector Frontend 설계서

## 1. 목적과 고정 범위

이 문서는 `neo-pkg-dbus`의 화면과 사용자 동작을 정의한다. 구현 범위는 **Side**와 **Main**이다. 시각 규칙은 저장소 루트 `DESIGN.md`를 유일한 기준으로 사용하며, 이 문서는 색·글꼴·간격·모서리 값을 새로 정하지 않는다. 구현 중 확정한 추가 계약은 `DBUS_SDD.md`의 **1.1**을 따르며, **1.2는 JSH 호환성 수정 설계**다.

Database Servers shows the selected default with a `Default` badge. The server form can load tables and columns with its unsaved connection values and save a default Database mapping. New Jobs copy that mapping only; their DBus Method UI stays unchanged.

수집 대상은 Linux System Bus의 DBus Interface와 Method다. generic build는 `GET /settings`에서 `provider:null`을 받고 기존 Interface/Method/Job 관리 화면을 모두 제공한다. Provider build는 검증된 읽기 전용 Profile이 명시한 화면 표시와 새 Job 초기값만 바꾼다. 패키지 최소 Neo 버전은 `8.5.8`이다. DataViewer는 `DBUS_SDD.md` CCR-052의 승인에 따라 `neo-pkg-opcua-client`의 화면 구조와 상호작용을 공통으로 사용한다.

화면은 다음을 제공한다.

- Job 생성, 조회, 정지된 Job 수정, 삭제, 설치, 시작, 정지
- Built-in DBus Interface 조회와 사용자 DBus Interface/Method 관리
- Method Call을 순서대로 구성하고 입력값에 따라 Tag를 자동 생성·일괄 편집
- Test Call, 직전 cycle 결과, Job 기준 DataViewer, 로그 조회

Write 전용 화면과 Built-in Write Method는 제공하지 않는다. Custom Method가 외부 상태를 바꿀 수 있는지는 사용자가 확인한다.

### Provider Profile

FE는 시작할 때 `GET /settings.data.provider`를 읽는다. `null`이면 generic mode이고,
객체이면 [DBUS_PROVIDER_PROFILE.md](providers/DBUS_PROVIDER_PROFILE.md)의 Provider
mode다. `jobMode: "fixed"`는 화면 표시와 새 Job draft의 Interface, Method, Output,
Tag 생성 초기값에만 쓰며, 공통 Backend CRUD API가 없어졌다고 해석하지 않는다.
별도로 승인된 Provider 화면 계약이 없는 기능은 generic 화면 동작을 유지한다.

FE는 `provider`를 `PUT /settings`로 보내지 않으며 브라우저 저장소에도 build
정체성의 원본으로 복사하지 않는다. Database Server 기본값은 Provider와 무관하게
모든 build에서 같은 Settings 값을 사용한다. 모든 target의 화면 제품명은 고정
`neo-pkg-dbus`이고 버전은 `cgi-bin/package.json.version`을 기준으로 한다.

### 제품 모듈과 build 경계

generic과 LS Frontend는 별도 브랜치가 아니라 한 브랜치에서 관리한다. 공통 화면,
Database, Job lifecycle, DataViewer와 Side/Main 통신은 기존 `frontend/`에 두고,
제품별 Job Method 영역·초기 Method Call·Interface 관리 진입점 차이만
`products/generic/frontend/index.jsx`와 `products/ls/frontend/index.jsx`에 둔다.
공통 Frontend는 업체 ID 조건문 대신 build가 선택한 제품 모듈을 호출한다.

LS 제품의 새 Job `DeviceString` 바깥 control은 고정 `%` 접두사와 현재 주소 본문을
읽기 전용으로 표시한다. 오른쪽 화살표는 같은 너비의 절대 배치 팝오버를 열고 Memory
Area, Data Type, Address를 조합한다. Address는 `number` control의 위·아래 화살표로
조절할 수 있고, 팝오버 아래 완성 주소 입력에서는 `%MB3` 같은 정규형을 직접 입력할
수 있다. Memory Area는 `A/F/I/Q/M/K/R/W`, Data Type은 `X/B/W/D/L`만 후보로
제공한다. Address 기본값은 `0`이고 DataCount 최소값은 `1`이며 두 control은 같은
디자인의 위·아래 아이콘을 사용한다. Memory Area, Data Type, Address는 팝오버의 남는 공간을 같은 비율로 쓰며,
Memory Area와 Data Type은 입력 본문 또는 화살표에 포커스가 있어도 바깥 control 전체에 하나의 active border를 표시한다.
후보 목록은 하나만 연다. 팝오버가 열려도 Method Calls와 Tags의 높이·위치는 바뀌지
않는다. 제품 모듈은 화면값과 저장값 `%MB3`을 양방향 변환하고, 화면의 Tag 미리보기는
저장값과 같은 정규형으로 계산한다. generic 입력 화면에는 이 접두사·변환·팝오버를
적용하지 않는다. 상세 규칙은 `DBUS_SDD.md` CCR-054·CCR-060과
`providers/DBUS_LS_PROFILE.md`를 따른다.

새 LS Call의 초기 DeviceString은 `MB0`으로 보이고 저장값은 `%MB0`이며, 초기
DataCount `1`에 맞춰 자동 Tag `MB0` 한 개를 즉시 표시한다. 사용자는
화살표뿐 아니라 읽기 전용 DeviceString 입력 본문을 눌러도 같은 팝오버를 열 수 있다.
팝오버의 `Apply`는 링크가 아니라 공통 Primary 버튼을 사용하며, 유효한 완성 주소가
없을 때는 비활성화한다.

LS DataCount의 화면 상한은 X/B 4,096, W 2,048, D 1,024, L 512다. 이 제한은
DeviceString의 data type으로 결정하며, type 변경으로 현재 DataCount가 상한을 넘으면
상한으로 줄이고 마지막 address와 Tag 목록을 다시 계산한다. Backend의 uint16 상한은
바꾸지 않는다.

데스크톱 LS Method Call 목록의 최대 높이는 고정 행 개수가 아니라 오른쪽 선택 Call
상세의 실제 높이를 따른다. Call 행이 그 높이를 넘을 때만 목록 내부 세로 스크롤로
탐색한다. Test Call 결과가 나타나거나 지워져 오른쪽 높이가 변하면 왼쪽 목록 영역도
같이 변한다. 새로 추가하거나 선택한 Call은 보이는 범위로 자동 이동한다.
Tag Transform의 Bias와 Multiplier는 Address·DataCount와 같은 공통 숫자
Stepper를 사용하되 Bias 음수와 기존 계산 범위는 유지한다.

인자 없는 `npm run build`와 `--target=generic`은 같은 generic Frontend를 연결하고,
`--target=ls`는 LS Frontend를 연결해 루트 `index.html`, `main.html`, `side.html`을
완성한다. 이 HTML은 생성 산출물이며 `frontend/src` 원본은 수정하지 않는다. Git에는
항상 기본 generic HTML만 커밋한다. 제품 모듈은 정해진 위치와 export를 사용하며
`product.json`, 제품별 build script, `build:all` 또는 자동 탐색 체계는 두지 않는다.
상세 구조는 `DBUS_SDD.md` CCR-053과 승인 설계 문서를 따른다.

## 2. 화면 구조와 디자인 규칙

```text
DBus Collector
├─ Side: Job 목록, 선택, 시작/정지, 새 Job
└─ Main: Job 상세·편집, DBus Interface 관리, DataViewer, Log Viewer
```

- Side는 `DESIGN.md`의 256px Side panel, 40px 헤더, 22px 목록 헤더, 28px Job 행을 사용한다.
- 통합 화면은 Side와 Main을 두 열로 유지한다. 600px 이하에서도 Side를 아래로 쌓지 않는다.
- Main의 상세·생성 헤더, 카드, 입력, 상태 메시지, 버튼, 포커스, 접근성은 `DESIGN.md`의 공용 컴포넌트 규칙을 그대로 따른다.
- Side에서는 switch만 시작/정지를 담당한다. Side가 있는 Main 상세에는 Start/Stop 버튼을 중복해 표시하지 않는다.
- 긴 이름은 말줄임표 또는 `overflow-wrap: anywhere`를 사용하고 모든 grid 자식에는 `min-width: 0`을 둔다.
- Side 헤더의 New DBus Interface와 New Database Server는 현재 route를 바꾸지 않는다. Side는 각각 `{type:"open-create-modal",target:"dbus-interface"}` 또는 `{type:"open-create-modal",target:"db-server"}`를 BroadcastChannel로 보낸다. New DBus Interface는 목록 모달을 열고, 목록에서 Interface와 그 Method를 추가·수정·삭제한다. `db-server`는 먼저 `Database Servers` 목록 모달을 열고, `Add Server`와 Edit는 입력 모달을 연다. Main은 현재 화면 위에서만 모달을 열며, 취소·닫기·바깥 영역 클릭·Esc 뒤에도 원래 화면을 유지한다. 이 변경의 이전 계약·이유·승인 기록은 `DBUS_SDD.md`의 CCR-007을 따른다.
- Main의 첫 `/` 화면은 Job을 자동으로 열지 않고 제목·상단 메뉴·카드 없이 중앙 안내만 표시한다. Job이 없으면 `inbox`, `No jobs yet`, `Click "New" to get started`를, Job이 있으면 `inbox`, `Select a job from the sidebar`를 표시한다. Job 생성·수정 헤더는 이전 화면으로 가는 32px Back 화살표를 제공한다. 생성 모달의 dim 배경은 검정 50% overlay로 뒤 화면을 보이게 하면서도 어둡게 구분한다. 이전 계약·이유·승인은 `DBUS_SDD.md`의 CCR-008을 따른다.

## 3. 공통 상태 모델

화면은 하나의 `status` 문자열로 모든 사실을 합치지 않는다. 목록과 상세가 받는 Job 상태는 다음 네 값을 함께 보존한다.

| 값 | 종류 | 뜻 |
|---|---|---|
| `configState` | 설정 | Controller 상태를 알면 `config-only` 또는 `installed`, 알 수 없으면 `null` |
| `executionState` | 실행 | Controller 상태를 알면 `running` 또는 `stopped`, 알 수 없으면 `null` |
| `statusKnown` | 상태 신뢰 여부 | Controller 상태를 신뢰할 수 있으면 `true`, 조회 실패 또는 `UNKNOWN`이면 `false` |
| `controllerState` | Controller 원본 | `RUNNING`, `STARTING`, `STOPPING`, `STOPPED`, `FAILED`, `UNKNOWN`, `NOT_INSTALLED` |
| `controllerDetail` | Controller 진단 | 원본 오류 요약 또는 `null` |

- Job 생성 성공은 항상 `installed`다. `config-only`는 외부에서 service가 지워진 복구 대상일 뿐 생성 화면이 만드는 정상 상태가 아니다.
- `installed`는 service가 설치된 상태다. `installed`와 `stopped`는 서로 다른 축이다.
- `running`은 설치된 service가 실행 중인 상태다.
- `STARTING`과 `STOPPING`은 전환 상태다. `STARTING`은 `STARTING — Preparing tags…`와 작은 spinner를 표시하고 Start·Edit·Delete·Save를 비활성화하되 Stop은 준비 취소를 위해 허용한다. `STOPPING`은 모든 lifecycle control을 비활성화한다. 전환 Job이 있으면 목록을 1초마다 다시 읽고 전환 종료 뒤 polling을 멈춘다.
- Controller를 읽지 못하면 `controllerState: "UNKNOWN"`, `configState: null`, `executionState: null`, `statusKnown: false`로 표시하고 추측으로 설치 또는 실행 상태를 표시하지 않는다.
- 저장 파일 이름과 document top-level name이 다르면 `JOB_INVALID_CONFIG`으로 표시한다. 이 경우 목록·상세는 진단만 보여 주고 Start, Stop, Edit 저장, Delete를 모두 비활성화한다.

Job 목록의 허용 동작은 아래와 같다.

| 상태 | Side switch | Main 동작 |
|---|---|---|
| config-only (외부 service 삭제) | Start (내부 자동 설치 후 시작) | Edit, Delete |
| installed + stopped/failed | Start | Edit, Delete |
| installed + running | Stop | Edit/Delete 불가 |
| installed + starting | Stop (준비 취소) | Edit/Delete 불가 |
| installed + stopping | 전환 대기 | Edit/Delete 불가 |
| Controller UNKNOWN | 비활성화 | 모든 변경 불가 |

`running`, `STARTING`, `STOPPING`인 Job은 Job Edit와 Delete를 차단한다. 이 규칙은 화면 편의가 아니라 Backend 규칙을 반영한다. 예외로 LS build의 Job 상세 Log Level은 CCR-074의 전용 mutation을 사용한다. 화면은 호환을 위해 Job 상세 GET의 `revision`을 수정 PUT에 함께 보내지만 Backend는 이 값을 사용자 충돌 조건으로 쓰지 않는다. 같은 Job mutation이나 package lifecycle이 실제로 진행 중이면 lock의 `JOB_CONFLICT`를 표시하고 사용자가 다시 시도하게 한다. 장기 화면 잠금은 제공하지 않는다.

### 3.1 Job mutation 충돌 안내

같은 Job의 create/start/stop/update/delete는 짧은 Backend mutation operation으로 직렬화된다. FE는 lock이나 package lifecycle fence를 직접 보유하지 않는다. 다른 요청 또는 package lifecycle과 충돌하면 Backend는 HTTP 409 `JOB_CONFLICT`를 반환하며, FE는 진행 중인 요청을 끝난 것으로 표시하지 않고 최신 목록 또는 상세를 다시 읽은 뒤 사용자가 다시 시도하게 안내한다.

Package stop/uninstall은 CGI API가 아닌 package lifecycle script의 동작이다. 이 작업의 lock·lease·stale 회수·회귀 테스트의 유일한 기준은 `DBUS_SDD.md` 3.1절과 `BE_DESIGN.md` 6.1절이다.

## 4. Job 목록과 상세

목록에는 Job Name, 사용 DBus Interface 수, Destination 수, Method Call 수, `configState`, `executionState`, Controller 상태, 마지막 저장 시각을 표시한다. 같은 Destination을 쓰는 여러 Job은 동시에 실행할 수 있으며, 순서 보장은 한 Job의 Method Call 안에서만 적용된다.

상세 상단은 같은 너비의 `JOB`, `METHOD CALLS`, `DATABASE` 세 카드다. 별도 `CONFIG` 지표는 표시하지 않는다. Job 카드는 실행/Controller 상태, Run Interval, Save Policy를 합쳐 표시하고, Method Calls 카드는 Call 수를 강조하며, Database 카드는 Server·Table·Value Column·String Column을 표시한다. 별도 Install 버튼은 없다. Side switch는 Start/Stop에 쓰며, 외부에서 service가 지워진 `config-only` Job은 Start 시 내부적으로 다시 설치한다. Start/Stop 성공 뒤에는 해당 Job 행을 즉시 응답 값으로 바꾸고 Main 상세는 갱신 신호를 받아 다시 읽는다. 이미 목록이 있으면 Refresh 중 `Loading jobs…`를 표시하지 않는다. DBus 호출 timeout은 제공하지 않으므로 입력·표시·API 옵션에 넣지 않는다.

직전 실행 결과는 누적 이력이 아니다. `LATEST RUN`에는 최신 상태, 마지막 성공 시각, 마지막 실제 저장 시각, busy reader 때문에 skip된 누적 `SKIPPED CYCLES`와 마지막 `LAST SKIPPED` 시각, 마지막 cycle 안의 Method별 상태·`Rows saved`·오류를 표시한다. `overrunCount > 0`이면 두 skip metric은 warning 색과 1px warning border로 표시한다. skip 값은 logical Job Start와 daemon 재시작 때 0/빈 값으로 초기화된다. `Rows saved`는 해당 Method가 마지막 cycle에서 실제 append한 행 수다. 실행 전에는 `No run result yet`를 표시한다. 실행 중인 Job 상세는 5초마다 Job과 lastRun을 다시 읽고 화면을 벗어나거나 정지하면 polling을 끝낸다. 원본 DBus body와 추출된 값은 이 화면에서 보관하지 않는다.

### 4.1 Logging Controls와 Live Logs

Job 상세 상단 동작 버튼은 `terminal` 아이콘의 `Live Logs`, `query_stats` 아이콘의 Primary outline `Data Viewer`, `edit` 아이콘의 `Edit`, danger `delete` 아이콘의 `Delete` 순서다. 기존 상단 `Logs` 버튼은 없다. `LATEST RUN` 아래의 Logging Controls 카드는 `terminal` 아이콘·제목, `LOG LEVEL`, 현재 threshold에서 실제 기록되는 level 목록, `ROTATION`과 전역 `settings.logging.maxFileBytes × maxFiles`, `description` 아이콘의 Primary outline `View Logs`를 표시한다. rotation 값은 active 파일 하나와 유지할 회전 파일 수를 뜻한다. LS build에서는 Log Level select와 `Apply`를 제공하며 선택값이 현재 저장값과 다를 때만 활성화한다. Apply 중에는 select와 button을 잠그고, 성공하면 revision을 포함한 최신 Job 응답으로 상세를 다시 읽는다. 이 조작은 Job 재시작 없이 적용된다는 문구를 함께 표시한다. generic build는 현재 level badge와 LS hot-apply 미지원 문구만 보인다. `View Logs`는 기존 `/logs/:name` 저장 로그 화면으로 이동한다.

`Live Logs`는 화면 오른쪽 아래에서 열리는 부유 패널이다. 최초 크기는 460×360px, 최소 크기는 320×220px이며 viewport 밖으로 나가지 않는다. 제목 영역 drag, 오른쪽·아래·오른쪽 아래 resize handle을 제공한다. 패널은 `CONNECTED` 또는 `DISCONNECTED`와 현재 표시 줄 수를 보이고 `Pause/Resume`, `Clear`, `Close`를 제공한다. 먼저 `GET /log/list?name=<job>`에서 `active:true` 파일을 고르고, 파일이 있으면 1초마다 `GET /log/tail?name=<job>&file=<file>&lines=<lines>`을 호출한다. `name`, `file`은 필수이고 `lines`는 선택이다. 응답은 `{name,file,lines,totalLines}`이며 `lines`의 마지막 100줄만 snapshot으로 표시하고 `[TRACE]`, `[DEBUG]`, `[INFO]`, `[WARN]`, `[ERROR]`는 level 색을 사용한다. 위로 스크롤한 사용자의 위치는 유지하고, 아래를 보던 경우에만 새 줄 뒤로 붙인다.

Pause 중에는 요청 결과를 화면에 반영하지 않고 Resume 즉시 다시 읽는다. Clear는 서버 파일을 바꾸지 않으며 Clear 시점 `totalLines` 뒤에 추가된 줄만 표시한다. rotation 또는 truncation으로 `totalLines`가 줄면 새 파일로 보고 기준을 초기화한다. 목록·tail 실패 시 기존 줄을 유지하고 `DISCONNECTED`를 표시하며 다음 1초 주기에 다시 시도한다. active 파일이 없으면 빈 연결 대기 상태만 보이고 오류 alert를 반복하지 않는다. route 이동, Job 변경, unmount 또는 Close는 요청을 abort하고 timer를 제거한다. 동시에 하나의 Live Logs 연결만 유지하며 SSE를 사용하지 않는다.

## 5. Job 생성과 수정

### 기본 정보

| 필드 | 필수 | 규칙 |
|---|---|---|
| Job Name | 예 | 영문 소문자·숫자·`_`·`-`; 생성 뒤 변경 불가 |

Job은 공통 Profile이나 공통 DBus 주소를 고르지 않는다. Method Call마다 DBus Interface와 Method를 고르고, 실제 입력값을 넣는다. 실행 중 Job은 편집 화면으로 들어갈 수 없고 API도 변경을 거부한다.

Save/Create를 제출하면 Main과 Side는 메모리에만 존재하는 15초 save lease를 공유한다. Save 버튼은 요청 중 비활성화하고, 그동안 Side에서 다른 Job을 누르면 즉시 화면을 바꾸지 않고 마지막 선택 한 건만 보관했다가 저장 성공·실패 종료 뒤 연다. 저장 요청은 편집 route 변경이나 form unmount로 abort하지 않으며, 이미 다른 화면으로 이동한 경우 늦은 응답의 화면 반영만 무시한다. 정상·오류 응답은 `finally`에서 lease를 해제한다. 응답이 15초를 넘으면 UI를 자동으로 풀고 Job 목록을 다시 읽으며, 이후 도착한 응답은 현재 화면을 강제로 바꾸지 않는다. 이 상태는 파일이나 브라우저 저장소에 기록하지 않는다. Side/Main 동기화와 Backend 중단 안전성은 `DBUS_SDD.md` CCR-086을 따른다.

새 Job Name은 현재 화면이 이미 읽은 Job 목록에서 정규식 `^job-([1-9][0-9]*)$`와 일치하는 이름의 가장 큰 `N` 다음 번호로 한 번 제안한다. 그런 이름이 없으면 `job-1`이다. 다른 형식의 이름과 비어 있는 중간 번호는 계산에 영향을 주지 않으며 별도 목록 요청이나 Backend last counter는 만들지 않는다. 목록 refresh는 사용자가 수정한 이름을 덮어쓰지 않고 동시 생성 충돌은 기존 `JOB_ALREADY_EXISTS`로 처리한다.

New/Edit Job의 Job Configuration은 항상 `JOB CONFIGURATION`, Job Name, Run Interval, Save Policy를 레이블이 있는 읽기 전용 summary 카드로 표시한다. 연필 버튼은 기존 Job Name, Run Interval, Retry Initial, Retry Maximum, Retry Multiplier, Save Policy control을 가진 `Edit Job Configuration` 모달을 연다. 새 Job Name만 수정할 수 있고 Edit Job Name은 계속 변경할 수 없다. 모달은 별도 draft를 사용하며 `Apply`만 Job draft에 반영하고 `Cancel`, 닫기, 바깥 영역 클릭, Esc는 변경을 버린다. 이 표시 상태는 payload에 저장하지 않는다. 이전 접힘 계약은 `DBUS_SDD.md` CCR-056, 대체 계약은 CCR-058을 따른다.

New/Edit Job의 Database도 항상 `DATABASE`, Database Server, Table을 레이블이 있는 읽기 전용 summary 카드로 표시하며 빈 값은 `—`로 표시한다. 연필 버튼은 기존 Database Server, Table, Value Column, String Value Column control과 Table 자동 생성 안내를 가진 `Edit Database` 모달을 연다. 모달은 별도 draft를 사용하며 `Apply`만 Job draft에 반영하고 `Cancel`, 닫기, 바깥 영역 클릭, Esc는 변경을 버린다. 이 표시 상태와 요약은 Job payload에 저장하지 않는다. 이전 접힘 계약은 `DBUS_SDD.md` CCR-057, 대체 계약은 CCR-058을 따른다.

### 실행·저장·DB 설정

- 기본 Run Interval은 1,000ms다.
- 실패 시 다음 cycle은 5초, 10초, 20초, 이후 30초 간격으로 재시도한다. 같은 cycle에서 Method를 반복하지 않는다.
- `perMethod`는 성공한 Method마다 저장한다. `afterAllMethods`는 모든 Method 성공 뒤 한 번 저장을 시도한다. 둘 다 DB 트랜잭션 원자성을 약속하지 않는다.
- 등록 DB Server를 고르고, `+`로 Database Servers 관리 모달을 열 수 있다. Server를 고르기 전에는 Table과 두 Column control을 비활성화한다. Table은 직접 입력하거나 발견된 후보를 고르는 콤보 박스이며, 입력·선택한 이름은 즉시 대문자로 표시한다. 기존 Table을 고르면 숫자 Value Column·선택 String Value Column은 `GET /db/table/columns`의 후보만 고르는 콤보 박스다. 서버 목록에 없는 Table 이름을 입력하면 `Table not found. It will be created automatically when the job is saved.`를 표시하고 두 Column control을 비활성화한다. Job 저장 시 숫자 출력만 있으면 `VALUE`만, 문자열·JSON·object·array 저장이 하나라도 있으면 `VALUE`와 `STR_VALUE`를 가진 새 TAG Table을 만든다. 기존 Table mapping은 Job 저장 전 metadata와 자료형을 검사한다. 설정 column이 없거나 type이 다르면 안내 toast를 표시하고 해당 Database Server 편집 모달을 연다. String Value Column이 비어 있으면 문자열 계열 출력만 저장하지 않고 숫자 출력은 계속 저장한다. primary key와 basetime column의 이름은 고정하지 않는다. 이 규칙의 변경 근거와 승인 기록은 `DBUS_SDD.md` CCR-055·CCR-078을 따른다.

### DB Server 관리 흐름

Main의 DB Server 관리 화면은 등록 DB Server를 목록으로 보여 주고 Create, Edit, Delete, Test Connection을 제공한다. Create/Edit에서는 `name`, `host`, `port`, `user`, `password`를 모두 필수로 입력하고 `POST` 또는 `PUT /db/server`로 저장한다. 비밀번호가 비어 있으면 저장 control을 비활성화하고, Backend의 `DB_SERVER_INVALID` 오류도 해당 입력에 표시한다. 비밀번호는 입력·전송에만 쓰며 Job config나 목록·오류·로그에 다시 보여 주지 않는다. 기본 `localhost`의 Default Table 이름은 `DEFAULT_DBUS`, 기본 Value Column은 `VALUE`, 선택 String Value Column은 빈 문자열이다. Database Server 저장은 Default Table을 만들지 않는다. `Connect and Load Tables` 뒤 기존 Table을 선택한 경우에만 두 Column control을 활성화한다. 목록에 없는 Table 이름만 입력해도 저장 시 Value Column은 `VALUE`로 보완한다.

Job form은 먼저 `GET /db/server/list`로 등록 서버를 고른다. 선택 후 `GET /db/table/list?server=...` 후보에서 Table을 고르거나 직접 입력한다. 목록에 없는 Table은 별도 `POST /db/table/create` 요청을 보내지 않고 Job Create/Save 요청에서 Output Mapping에 맞춰 자동 생성한다. 숫자 출력만 있으면 `VALUE`, 문자열 계열 저장이 있으면 `VALUE`와 `STR_VALUE`를 쓴다. 생성한 이름이 서버의 Default Table과 같으면 Backend가 서버 기본 Column도 생성 schema와 같은 값으로 저장하므로, 이후 새 Job은 `GET /db/server/list` 응답에서 해당 Column을 바로 복사한다. 이후 기존 Table만 `GET /db/table/columns?server=...&table=...`로 value/string value column 후보를 받아 두 Column 콤보박스에 보여 준다. FE는 기존 Table의 Column 이름을 직접 입력하게 하지 않으며, 새 Table의 Column control도 열지 않는다. Backend가 TAG primary key와 basetime column을 판별하므로 FE는 컬럼 이름을 가정하지 않는다.

### Method Call과 Tag

Job에는 Method Call이 하나 이상 필요하고 화면 순서가 실행 순서다. 각 Call draft는 `interfaceId`, `methodId`, raw `inputs`, Tag 목록을 가진다. 화면은 DBus Interface별로 접고 펼치는 구조로 Call을 묶되, 호출 순서는 전체 Job 순서다. drag-and-drop은 각 Call 좌측 상단의 drag 아이콘에서만 시작하며, 키보드로 쓸 수 있는 위/아래 이동 버튼도 제공한다. 각 Call은 Interface, Method, 입력 요약, Tag 수, 수정·삭제 동작을 표시한다.

LS 제품은 [LS Provider Profile](providers/DBUS_LS_PROFILE.md)과 CCR-059가 이 일반
화면보다 우선한다. LS Method Calls는 같은 고정 Method를 하나 이상 추가하는
master-detail 카드다. 목록에는 DeviceString과 DataCount를 표시하고 선택 상세에는
고정 Method 식별자, 같은 너비의 DeviceString·DataCount 입력, 기본 접힘 Tags를
표시한다. Tags의 바깥 좌우 경계는 입력 행과 같아야 한다. 마지막 Call은 삭제할 수
없고 선택·Tags 접힘 상태는 payload에 넣지 않는다. DeviceString의 주소 선택기는
입력 너비를 그대로 따르는 overlay이므로 상세 카드의 높이를 늘리지 않는다. 목록
hover는 handle과 선택 본문을 포함한 전체 행에 적용하고 Add Call·Test Call은 다른
화면과 같은 공통 button을 사용한다.
선택된 LS Method Call의 Tags 헤더 오른쪽에는 `Import CSV` 버튼을 둔다. 선택한
UTF-8 CSV 파일은 별도 미리보기 없이 현재 Call의 Tag 배열에 즉시 적용한다. 헤더는
`name,bias,multiplier,order`이고, 첫 데이터 행부터 위쪽 Tag에 대응한다. 부족한 행은
뒤쪽 Tag를 유지하고 DataCount를 넘는 행은 무시한다. 적용 대상 행의 이름·숫자·순서
검증이 하나라도 실패하면 draft를 전혀 바꾸지 않고 오류를 표시한다. CSV import는
적용한 이름을 수동 이름으로 표시하고 Tag 수와 DataCount를 변경하지 않으며 generic
Method Call 화면에는 표시하지 않는다.
선택된 LS Call의 Tag 배열은 DataCount 전체를 Job draft에 유지하되 화면에는 한 페이지당
50개만 렌더링한다. pager는 Tag 수와 무관하게 항상 표시하고 First, Previous, 직접
페이지 입력, Next, Last를 제공한다. 직접 입력은 Enter 또는 blur에서 적용하며 1보다
작으면 첫 페이지, 마지막 페이지보다 크면 마지막 페이지로 보정한다. 화면의 행 번호와
수정 인덱스는 전체 배열 기준이고, DataCount 감소로 현재 페이지가 사라지면 새 마지막
페이지로 보정한다. 다른 Call을 선택하면 첫 페이지로 돌아가며 Tags를 접었다 다시 열면
현재 Call의 페이지를 유지한다. CSV Import, 저장과 validation은 현재 페이지가 아니라
항상 전체 Tag 배열에 적용하고, Import 뒤 현재 페이지를 새 배열에서 다시 표시한다.
페이지 번호와 페이지 크기는 payload에 저장하지 않으며 generic 화면은 바꾸지 않는다.
LS Test Call 결과는 가장 최근 실행한 Call ID와 함께 화면 상태로 보관한다. 선택된
Call의 ID가 같을 때만 Tags 아래에 성공 여부, 소요 시간과 반환값을
표시한다. 다른 Call을 선택하면 숨기고 원래 Call로 돌아오면 다시 표시한다. 다른
Call의 Test Call은 직전 결과를 교체하며 `Clear`는 결과만 지우고 Job draft는 바꾸지
않는다. generic 제품의 기존 Test Call 결과 위치는 유지한다.

입력 editor와 Job/Test Call 값 편집기는 [DBUS_TYPE_SYSTEM.md](DBUS_TYPE_SYSTEM.md)의 Parameter Type 표현으로 고른다. FE는 앱 전용 `type:value` 문자열을 만들지 않으며, Backend도 그런 hint를 만들지 않는다.

출력 선택 화면의 임시 기준은 `DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`다. 기본은 Introspection Type 그대로이며, `string` 출력에서만 `parse as JSON`을 고를 수 있다. JSON 해석으로 새로 전환하면 FE는 Value type으로 `numeric`을 먼저 제안한다. 사용자는 Test Call 없이 RFC 6901 `selector`를 직접 입력하고 `Value type`을 numeric/string/json/array 중에서 고른다. array는 원소 자료형도 고른다. Test Call은 원본 반환 body를 확인하는 선택 기능일 뿐 selector·자료형·Tag 미리보기를 만들거나 selector 작성의 필수 단계가 되지 않는다. 특정 Provider Method의 입력값으로 Tag 수나 주소를 공통 화면이 자동 생성하지 않는다.

Method Call 카드는 Output Mapping을 Output 단위 행 목록으로 표시한다. `Add Output`은 새 Output 하나만 작성하는 모달을 열고, 목록의 Output 이름 또는 Edit는 해당 Output 하나를 수정하는 모달을 연다. Tag는 Output 안에 속하므로 목록의 행 단위가 아니다. 이 화면 분리는 표시 방식만 바꾸며 `outputSelections`의 저장 형식·검증·실행 규칙은 `DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`를 그대로 따른다.

각 출력 선택의 Tag 이름과 Transform은 사용자가 바꿀 수 있다. 새로 저장하는 Tag는 `name`, `bias`, `multiplier`, `transformOrder`를 가진다. `transformOrder`는 `bias`와 `multiplier`를 각각 한 번씩 가진 두 칸 배열이며 Transform 묶음을 끌어 순서를 바꿀 수 있다. `sourceAddress`, `calcOrder`, `outputIndex`는 예전 Job을 읽을 때만 받아 다음 저장에서 제거한다. Tag name은 최대 100자다. 저장 전에는 빈 이름, Job 안의 중복 이름, 100자 초과, 유한하지 않은 bias/multiplier와 잘못된 transformOrder를 검사한다. 배열 원소 수와 Tag 수 일치는 실행 결과로 검사한다.

Transform은 숫자 출력에만 적용한다. 기본 순서는 다음과 같고, 두 Transform 묶음을 바꾸면 적용 순서도 함께 바뀐다.

```text
(value + bias) × multiplier
```

반대 순서는 `(value × multiplier) + bias`다.

array 출력의 Tag 목록 헤더에는 `Generate from Array` 버튼이 보인다. 이 버튼이 여는 `Generate Tags` 모달은 Prefix와 Count를 받아 `PREFIX1`부터 순서대로 만든다. 단일값에는 이 버튼을 보이지 않고 Tag 하나의 이름만 직접 수정한다. 일괄 편집은 선택 행의 prefix/suffix, 찾기/바꾸기, 줄 단위 이름 붙여넣기, bias, multiplier, Transform 초기화를 preview와 함께 제공한다. 문자열·JSON·복합 출력에는 Transform control을 보이지 않으며 값을 바꾸지 않는다. 다른 Job과 같은 DB/Table에 같은 Tag 이름이 있으면 경고하지만 저장을 막지 않는다.

## 6. DBus Interface와 Method 관리

DBus Interface 목록은 Bus Type, Destination, Object Path, Interface 이름, Built-in/User, Method 수를 표시한다. 목록에서는 참조 상태를 표시하지 않는다. 생성 모달은 Bus Type, Destination, Object Path를 받고 **Discover**를 제공한다. Discover 결과는 Interface 선택 목록으로 제공하고, 장비 Interface를 먼저 정렬하며 `org.freedesktop.*`에는 `Standard` 표기를 붙인다. 목록의 마지막 항목은 항상 `Direct input`이다. 사용자가 실제 Interface를 고르면 그 Interface의 Method와 입력·출력 파라미터를 현재 편집 draft에 자동 반영하고, 모달 안에 Method와 입력·출력을 읽기 전용으로 표시한다. `Direct input`을 고르면 Interface 이름 수동 입력을 보인다. 새 Interface의 ID는 이미 입력한 값을 유지하며 비어 있을 때만 발견 ID를 제안한다. 기존 Interface의 ID는 수정할 수 없다.

CCR-032가 이 규칙을 대체한다. 목록과 상세는 사용자 관리 이름 `name`을 첫 줄에, 실제 DBus Interface 이름을 함께 표시한다. 생성·수정 모달은 Name 입력만 제공하며 내부 ID 입력은 제공하지 않는다. 새 Interface의 내부 `id`는 서버가 Name 기반으로 겹치지 않게 만들고, Job의 `interfaceId`는 계속 그 내부 ID를 쓴다.

CCR-033에 따라 Discover 전에는 Discovered Interface 선택 상자를 보이지 않는다. Destination과 Object Path는 같은 행에 놓고, Discover 성공 뒤 선택 상자를 보인다. `Direct input`을 고르면 그 바로 아래에 Interface 입력을 보인다. Method는 목록 아래에 표시하지 않고 별도 모달에서 내부 스크롤로 표시한다. 자동 발견 Method는 읽기 전용이며, Direct input의 manual Method만 참조 Job이 없을 때 관리할 수 있다. 참조 Job이 있으면 Name 외 Interface 입력과 Discover, Method 관리를 비활성으로 표시한다.

generic build는 DBus Interface 목록이 비어 있을 수 있다. 이 경우 목록의 빈 상태와 New DBus Interface 동작을 표시하며, Job 화면은 Interface 선택 전 Method Call 추가를 허용하지 않는다. Provider build가 Built-in Interface를 공급하면 목록과 읽기 전용 상세에 표시하되, Profile에 없는 Interface/Method 관리 동작을 임의로 숨기지 않는다.

- Discover는 저장하지 않는다. 결과는 선택 목록으로 제공한다. 실제 발견 Interface 뒤 마지막 항목은 `Direct input`이다. 성공하면 정렬된 첫 Interface를 기본 선택하고, 사용자가 이미 고른 Interface가 결과에 남아 있으면 그 선택을 유지한다. 참조 Job이 없는 discovered Interface의 Edit는 모달을 열 때 Discover를 자동 실행해 현재 Interface를 선택한다. manual Interface는 자동 Discover 뒤에도 `Direct input`과 기존 수동 값을 유지한다. 사용자가 실제 Interface를 고르면 그 Interface와 Method 목록이 현재 편집 폼에 반영되고, `Direct input`을 고르면 Interface 이름을 직접 입력한다. footer의 단일 저장 control은 새 Interface에서 `Create Interface`, 기존 Interface에서 `Update Interface`다. 새 Interface는 `POST /dbus-interface`, 기존 Interface의 다시 Discover 결과는 `PUT /dbus-interface?discover=true`로 저장한다. 화면에는 Save All과 Discover 카드별 저장 control이 없다.
- Introspection을 지원하지 않거나 권한이 없으면 사용자는 Interface 이름, Method 이름, 모든 입력·출력 파라미터 이름과 [DBUS_TYPE_SYSTEM.md](DBUS_TYPE_SYSTEM.md)의 DBus Type 표현을 직접 입력한다. 입력 화면과 Job/Test Call 값 편집은 같은 Type 구조를 사용한다.
- Provider가 공급한 Built-in Interface와 그 Method는 읽기 전용이다.
- 목록 행을 선택해도 상세 API 요청은 보내지 않는다. Edit 또는 Delete를 누를 때만 `GET /dbus-interface?id=`로 최신 상세를 읽고, 그 결과로 열기 또는 차단을 결정한다. Built-in Interface의 활성 Edit는 `View DBus Interface` 읽기 전용 상세를 연다. 이 상세는 Interface와 모든 Method의 입력·출력, 참조 정보를 빠짐없이 보이며, Interface 입력, Discover, Create/Update Interface control, Method 입력과 추가·수정·삭제를 모두 비활성으로 표시하고 Delete도 계속 비활성으로 둔다.
- Interface 상세의 `references[]`는 `DBUS_SDD.md` 4.1 **DBus Interface 상세 응답**을 그대로 사용한다. `references[]`가 하나라도 있으면 이름 외 Interface 수정, Discover, Method 추가·수정·삭제와 Interface 삭제를 모두 막고 참조 Job을 안내한다. 참조가 없을 때 discovered Method는 계속 읽기 전용이며, manual Interface의 manual Method만 추가·수정·삭제할 수 있다. `/dbus-method` 요청 wrapper와 PUT ID 일치 규칙은 `DBUS_SDD.md` 4.1 **DBus Interface·Method 변경 요청**을 따른다.
- Method 상세과 참조 Job 정보는 내부 Method `id`를 표시하지 않고 DBus Member와 Job Call 이름만 표시한다. Method 출처는 `Discovered` 또는 `Manual` 영어 뱃지로 표시한다. 입력·출력 Parameter는 `required`가 생략되었거나 `true`이면 `Required`, 명시적으로 `false`이면 `Optional` 영어 뱃지로 표시한다.
- Method 모달은 화면 높이에서 80px을 뺀 값과 기본 행 높이 28px의 24배 중 작은 값을 최대 높이로 사용한다. 일반적인 Method 카드 최대 4개를 보이고, 초과 내용은 고정 header 아래 본문 하나의 얇은 어두운 스크롤바로 읽는다.

## 7. Test Call, DataViewer, 접근성

Test Call은 저장되지 않은 현재 DBus Interface/Method와 원시 Inputs로 호출한다. 결과에는 호출 시각, 소요 시간, 성공 여부와 원본 반환 인자 목록을 표시한다. 응답의 `body`는 `values`와 같은 값이므로 별도 Raw body 진단 영역을 표시하지 않으며 저장하지 않는다. 출력 selector와 자료형은 Test Call 결과가 아니라 사용자가 직접 정한다.

DataViewer는 `neo-pkg-opcua-client` 원본과 같은 화면과 상호작용을 사용한다. Job은 Database Server/Table/Column mapping을 고르는 기준일 뿐이고, Tag 목록은 같은 Table의 전체 실제 Tag를 탐색·검색·다중 선택한다. Tags/Asset/Derived 탭, hierarchy folder 접기, Raw Grid 가상 스크롤, 시간 범위 모달과 quick range, first/previous/next/last page, Forward/Backward scan, Chart와 split chart, zoom/pan, 시간 format·UTC/LOCAL/IANA 표시 선택, Neo Web Tag Analyzer 연결을 제공한다. `/db/table/tags`, `/db/table/data`, `/db/table/stat`, `/db/table/chart`에는 모두 현재 Job name과 server/table/names를 보낸다. Chart SQL은 CGI가 검증해 만들고 Neo Web `/web/api/query`만 실행한다. CGI 시간은 UTC `Z`지만 화면 timezone은 표시만 바꾼다. 상세 규칙은 `DBUS_SDD.md` CCR-052와 4.1을 따른다.

Log Viewer는 `GET /log/list?name=...`으로 Job 로그 파일을 고른다. 선택 파일의 페이지 내용은 필수 `name`, `file`과 선택 `page`, `lines`를 넣은 `GET /log/content?name=...&file=...&page=...&lines=...`으로 읽으며 응답은 `{name,file,page,linesPerPage,totalLines,lines,nextPage,previousPage}`다. 전체 본문은 필수 `name`, `file`을 넣은 `GET /log/content/all?name=...&file=...`으로 읽으며 응답은 `{name,file,size,content}`다. 마지막 부분은 필수 `name`, `file`과 선택 `lines`를 넣은 `GET /log/tail?name=...&file=...&lines=...`으로 갱신하며 응답은 `{name,file,lines,totalLines}`다. 전체 Job 로그 보기에는 `GET /log/all`을 쓴다.

icon button에는 `aria-label`과 title을 둔다. 상태는 색과 텍스트를 함께 표시하고 오류는 `role="alert"`, 경고는 `role="status"`, 첫 로딩은 `aria-live="polite"`를 사용한다. 대량 Tag 변경은 변경 건수와 preview를 먼저 보여 준다.

## 8. API 사용 원칙

API base path는 `/cgi-bin/api`다. 모든 성공 응답은 `{ "ok": true, "data": ... }`, 실패 응답은 `{ "ok": false, "code", "reason", "details" }`다. FE는 `reason`을 사람에게 보여 주고 `code`로 control과 화면 위치를 고른다.

`GET /settings` 성공 data에는 `provider`가 항상 있고 generic mode에서는
`null`이다. 파일이 잘못된 Provider build의 HTTP 400
`PROVIDER_PROFILE_INVALID`은 generic mode로 대신 표시하지 않고 설정 오류로
알린다. `PUT /settings` body에는 `provider`를 넣지 않으며, 잘못 넣었을 때의 HTTP
400 `SETTINGS_INVALID`을 일반 Settings 오류로 표시한다.

Discover는 Interface 선택 뒤 현재 편집 draft를 바꿀 뿐 저장하지 않는다. FE는 footer의 단일 `Create Interface` 또는 `Update Interface`로 현재 draft 하나만 보낸다. 새 Interface는 `POST`, 기존 Interface의 다시 Discover 결과는 `PUT /dbus-interface?discover=true`를 사용한다. `{interfaces:[...]}` 배열 wrapper, Save All, Discover 카드별 저장 control은 제공하지 않는다.

Job 생성 form은 `POST /job`에 `{ name, config }`만 보낸다. `name`은 form의 Job Name이고 `config`에는 `name` 키를 넣지 않는다. Job 수정 form은 호환을 위해 상세 GET으로 받은 `revision`과 config patch를 `PUT /job?name=<현재 이름>`에 보낸다. 수정 body에는 `name`을 넣지 않고 Job Name 입력은 읽기 전용이다. Backend가 `defaults → existing config → patch`를 깊이 병합하며, Method Call·Tag 같은 배열은 FE가 보낸 배열 전체로 교체된다. client revision이 낮거나 없어도 server가 Job lock 안에서 읽은 최신 revision을 기준으로 저장한다.

Save/Create 버튼은 form이 열려 있을 때 항상 활성화하고, 요청을 시작한 즉시부터 종료될 때까지만 비활성화한다. 렌더 전 연속 클릭은 동기 guard로 무시하며, 요청이 실패하면 버튼을 다시 활성화한다. PUT 성공 응답의 revision을 즉시 보관한다.

FE의 monitoring과 Data Viewer 진입은 `GET /job/status?name=`의 `{job,lastRun}`을 사용하며, 5초 polling마다 full Tag 설정을 다시 받지 않는다. Edit 진입만 `GET /job`의 canonical 전체 config를 사용한다. Job detail의 `name`, `config`, `revision`, `configState`, `executionState`, `statusKnown`, `controllerState`, `controllerDetail`을 모두 사용하고, `statusKnown: false`이면 `configState`·`executionState`가 `null`인 것을 정상으로 처리하며 모든 변경 control을 비활성화한다. LS Log Level Apply는 `PUT /job/log?name=<name>`에 정확히 `{revision, level}`을 보내며 다른 Job config를 함께 보내지 않는다. `JOB_INVALID`이면 create form의 잘못된 config를 표시하고, `JOB_NAME_IMMUTABLE`이면 이름이 수정 대상이 아님을 알린다. `JOB_CONFLICT`은 client revision 불일치가 아니라 같은 Job mutation·package lifecycle·interface mutation의 실제 lock 경쟁을 알린다. `JOB_INVALID_CONFIG`은 code 대신 `This Job configuration cannot be read. Recreate the Job before continuing.`으로 안내한다. `POST /job/validate` 성공의 `warnings[]`는 `code`, `reason`, `path`, `details`로 해당 입력과 함께 표시하며, `path`는 draft 안의 문제 위치를 가리키는 JSON Pointer다. warning만 있을 때 저장을 막지 않는다.

브라우저 요청에는 인위적인 timeout을 두지 않는다. 사용자가 취소하거나 화면이 닫힐 때만 AbortSignal을 전달한다. `Request timed out` UI와 timeout 상수는 없다.

사용 API는 settings, `dbus-interface/list`, `dbus-interface`, `dbus-interface/discover`, `dbus-method`, job, `job/status`, `job/log`, job/validate, job/start, job/stop, job/last-run, dbus/call, `db/server`, `db/server/list`, `db/connect`, `db/table/create`, `db/table/list`, `db/table/columns`, `db/table/tags`, `db/table/data`, `db/table/stat`, `db/table/chart`, `log/all`, `log/list`, `log/content`, `log/content/all`, `log/tail`이며, 각 요청·응답 필드와 공개 오류 코드는 `DBUS_SDD.md` 4.1을 따른다.
