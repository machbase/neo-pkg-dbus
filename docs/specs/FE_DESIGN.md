# DBus Collector Frontend 설계서

## 1. 목적과 고정 범위

이 문서는 `neo-pkg-dbus`의 화면과 사용자 동작을 정의한다. 구현 범위는 **Side**와 **Main**이다. 시각 규칙은 저장소 루트 `DESIGN.md`를 유일한 기준으로 사용하며, 이 문서는 색·글꼴·간격·모서리 값을 새로 정하지 않는다. 구현 중 확정한 추가 계약은 `DBUS_SDD.md`의 **1.1**을 따르며, **1.2는 JSH 호환성 수정 설계**다.

수집 대상은 Linux System Bus의 LS ELECTRIC PLC다. 기본 제공 항목은 읽기 전용 LS PLC DBus Interface와 `GetDeviceData` Method다. 사용자는 DBus Interface와 그 안의 Method를 추가할 수 있다. 패키지 최소 Neo 버전은 `8.5.6`이다.

화면은 다음을 제공한다.

- Job 생성, 조회, 정지된 Job 수정, 삭제, 설치, 시작, 정지
- Built-in DBus Interface 조회와 사용자 DBus Interface/Method 관리
- Method Call을 순서대로 구성하고 입력값에 따라 Tag를 자동 생성·일괄 편집
- Test Call, 직전 cycle 결과, Job 기준 DataViewer, 로그 조회

Write 전용 화면과 Built-in Write Method는 제공하지 않는다. Custom Method가 외부 상태를 바꿀 수 있는지는 사용자가 확인한다.

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
- Side 헤더의 New DBus Interface와 New Database Server는 현재 route를 바꾸지 않는다. Side는 각각 `{type:"open-create-modal",target:"dbus-interface"}` 또는 `{type:"open-create-modal",target:"db-server"}`를 BroadcastChannel로 보낸다. `db-server`는 먼저 `Database Servers` 목록 모달을 열고, `Add Server`와 Edit는 입력 모달을 연다. Main은 현재 화면 위에서만 모달을 열며, 취소·닫기·바깥 영역 클릭·Esc 뒤에도 원래 화면을 유지한다. 이 변경의 이전 계약·이유·승인 기록은 `DBUS_SDD.md`의 CCR-007을 따른다.
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

- `config-only`는 Job JSON은 있으나 service가 설치되지 않은 상태다.
- `installed`는 service가 설치된 상태다. `installed`와 `stopped`는 서로 다른 축이다.
- `running`은 설치된 service가 실행 중인 상태다.
- `STARTING`과 `STOPPING`은 전환 상태다. 시작·정지·설치·삭제·저장 control을 모두 비활성화한다.
- Controller를 읽지 못하면 `controllerState: "UNKNOWN"`, `configState: null`, `executionState: null`, `statusKnown: false`로 표시하고 추측으로 설치 또는 실행 상태를 표시하지 않는다.
- 저장 파일 이름과 document top-level name이 다르면 `JOB_INVALID_CONFIG`으로 표시한다. 이 경우 목록·상세는 진단만 보여 주고 Install, Start, Stop, Edit 저장, Delete를 모두 비활성화한다.

Job 목록의 허용 동작은 아래와 같다.

| 상태 | Side switch | Main 동작 |
|---|---|---|
| config-only | 표시하지 않음 | Install, Edit, Delete |
| installed + stopped/failed | Start | Edit, Delete |
| installed + running/starting/stopping | Stop 또는 전환 대기 | Edit/Delete 불가 |
| Controller UNKNOWN | 비활성화 | 모든 변경 불가 |

`running`, `STARTING`, `STOPPING`인 Job은 Job Edit와 Delete를 차단한다. 이 규칙은 화면 편의가 아니라 Backend 규칙을 반영한다. 화면은 Job 상세 GET의 `revision`을 수정 PUT에 함께 보낸다. 다른 관리자가 먼저 저장하거나 같은 Job mutation이 진행 중이면 `JOB_CONFLICT`를 표시하고 최신 설정을 다시 읽은 뒤 사용자가 다시 수정하게 한다. 장기 화면 잠금은 제공하지 않는다.

### 3.1 Job mutation operation lock 안내

같은 Job의 POST create/install/start/stop, PUT update, DELETE는 하나의 mutation operation이다. Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 `operation lock`을 유지한다. Package stop/uninstall은 전체 작업 동안 package lifecycle fence와 대상 Job의 lock을 함께 유지한다. 이 동안 기존 Job 변경뿐 아니라 새 이름의 Create도 HTTP 409 `JOB_CONFLICT`로 막는다. GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다.

Package stop/uninstall은 lifecycle fence를 먼저 잡고 대상 Job lock을 이름순으로 모두 잡으며, package 작업이 끝날 때까지 풀지 않는다. 일부 Job lock 획득이 충돌하면 이미 잡은 lock과 fence를 모두 풀고 `PACKAGE_LIFECYCLE_FAILED.details.errors[]`에 `JOB_CONFLICT`를 보존하므로 재시도할 수 있다. API mutation은 읽기 전용 availability probe로 fence 상태를 확인하고 Job lock을 잡은 뒤 같은 probe로 다시 확인한다. Probe는 canonical fence가 없거나 lease가 지났고 owner PID가 종료됐으면 available로 판단하며 어떤 lock도 만들거나 회수하지 않는다. Fresh fence, 살아 있는 owner, PID 판단 오류는 `JOB_CONFLICT`다. 실제 stale 회수는 package lifecycle의 exclusive acquire만 수행한다. Reclaim rename 중 canonical이 잠깐 없어 첫 probe가 통과해도 안전하다. API가 Job lock을 잡은 뒤 replacement fence가 보이면 두 번째 probe가 실패하고, package가 먼저 replacement fence를 잡고 API가 가진 Job lock에 도달하면 package 쪽이 실패하므로 둘이 함께 side effect를 실행할 수 없다. Package session 해제는 성공한 Job handle만 제거하고 실패한 handle과 fence는 보존한다. 모든 Job handle이 해제된 뒤에만 fence를 풀며, 실패한 같은 `session.release()`를 재시도할 수 있다.

lock은 `owner token`과 `heartbeat` 시각을 가진다. owner는 CGI 요청이 끝날 때 heartbeat를 중지하고 자기 token의 lock만 해제한다. lease가 지났고 `owner PID`가 종료되었다고 확인된 lock만 고유 quarantine 이름으로 원자 이동한 뒤 회수한다. PID 생존 여부를 확인할 수 없으면 안전하게 회수하지 않고 `JOB_CONFLICT`를 반환한다. 이전 owner는 Controller 호출이나 설정 파일 변경 같은 side effect 직전에 token을 다시 확인하며, 소유권을 잃었으면 `JOB_CONFLICT`로 중단한다. 이전 owner는 새 owner의 lock을 갱신하거나 해제할 수 없다. FE는 요청 단위 lock이나 package lifecycle fence를 직접 보유하지 않는다. 어느 쪽 충돌이든 `JOB_CONFLICT` 안내를 보여 주고 최신 목록 또는 상세를 다시 읽는다.

사용자 DBus Interface/Method의 변경은 Interface mutation fence와 참조 확인으로 보호한다. 참조 Job이 하나라도 있으면 수정·삭제는 거부된다. Job create/update/start는 Job lock 뒤 참조 Interface reader lock을 잡고 Interface와 Method를 다시 검증한다. 전역 순서는 package lifecycle probe → Job lock → Interface reader다.

Interface ID와 Job name은 각각 ASCII 영문 소문자·숫자·`-`(Job은 `_`도 허용)만 사용하고 최대 100자다. Interface reader lock은 raw ID 대신 고정 64자의 SHA-256 Interface key를 사용한다.

canonical Job lock owner 문서도 initial acquire와 stale replacement에서 임시 파일을 완성한 뒤 원자 publish한다. fresh empty/temp-only/malformed owner와 여러 final 또는 final+temp처럼 모호한 owner는 `JOB_CONFLICT`로 보호한다. lease가 지난 empty/temp-only/malformed canonical lock만 orphan으로 고유 quarantine 이름에 원자 이동해 회수한다.

canonical과 reclaim mutex의 공용 owner schema는 비어 있지 않은 `token`, 0보다 큰 safe integer `pid`, 유한한 `acquiredAt`/`heartbeatAt`, `heartbeatAt >= acquiredAt`을 요구한다. schema가 잘못된 owner는 PID 확인 함수에 넘기지 않고 incomplete로 취급한다. fresh이면 `JOB_CONFLICT`로 보호하고 lease가 지난 뒤에만 orphan quarantine 회수한다.

stale 회수를 직렬화하는 `reclaim mutex`도 no-clobber 원자 생성한 고유 owner 문서에 `token`, `pid`, `acquiredAt`, `heartbeatAt`을 기록한다. owner 문서는 임시 파일을 완성한 뒤 원자 publish한다. fresh mutex, 살아 있는 owner, PID 판정 오류, 여러 owner 문서처럼 모호한 mutex는 `JOB_CONFLICT`로 보호한다. owner 문서가 없거나 완성되지 않은 orphan mutex와 lease가 지나고 owner PID 종료가 확인된 mutex만 고유 quarantine 이름으로 원자 이동해 회수하며, 이전 mutex owner는 자기 token 문서만 지워 새 owner mutex를 삭제할 수 없다.

initial canonical owner publish가 실패한 요청은 canonical 경로를 무조건 지우지 않는다. 자기 token의 소유권을 원자적으로 확인할 수 없으면 fresh incomplete를 남겨 `JOB_CONFLICT`로 보호하고, lease가 지난 뒤 orphan quarantine 회수를 허용한다. reclaim mutex는 고유 pending 디렉터리에서 owner를 완성한 뒤 채워진 디렉터리 전체를 canonical 경로로 원자 publish하므로 빈 새 mutex를 노출하지 않는다. publish 중 경로를 잃거나 유효한 다른 owner가 있으면 이전 요청은 `JOB_CONFLICT`로 실패하며 새 owner를 갱신하거나 삭제하지 않는다.

이전 mutex owner가 owner 문서를 지운 직후 stale 회수자가 들어와도, 새 owner는 채워진 mutex만 publish한다. 따라서 이전 owner의 뒤늦은 `rmdir`은 새 owner가 있는 mutex를 지우지 못한다.

회귀 테스트는 이전 owner의 실제 `rmdir` wrapper에서 B의 공개 acquire를 시작한다. B가 채워진 mutex를 publish하면 B 훅은 wrapper의 continuation만 재개하고, wrapper가 저장해 둔 원본 `rmdirSync`를 정확히 한 번 호출해 발생한 `ENOTEMPTY`와 B owner 보존을 확인한다. B의 실제 mutex 해제와 handle 해제 뒤 C가 같은 Job을 다시 획득·검사·해제하는 과정도 확인한다. 또한 crash로 남은 다른 token의 `.reclaim.pending-*`가 있어도 B와 C의 실제 handle 흐름을 막지 않는지 확인한다.

## 4. Job 목록과 상세

목록에는 Job Name, 사용 DBus Interface 수, Destination 수, Method Call 수, `configState`, `executionState`, Controller 상태, 마지막 저장 시각을 표시한다. 같은 Destination을 쓰는 여러 Job은 동시에 실행할 수 있으며, 순서 보장은 한 Job의 Method Call 안에서만 적용된다.

상세에는 Job 이름, 사용 DBus Interface와 Method Call, 실행 상태, Run Interval, Retry Backoff, DB server/table/column mapping, 직전 실행 결과, Edit/Delete/DataViewer/Log 동작을 표시한다. `config-only` 상세에는 전용 **Install** 버튼을 Main에 표시한다. Side switch는 설치를 수행하지 않고, `installed` Job의 Start/Stop에만 쓴다. DBus 호출 timeout은 제공하지 않으므로 입력·표시·API 옵션에 넣지 않는다.

직전 실행 결과는 누적 이력이 아니다. 마지막 cycle 한 건과 그 안의 Method별 결과만 표시한다. 실행 전에는 `No run result yet`를 표시한다. 원본 DBus body와 추출된 값은 이 화면에서 보관하지 않는다.

## 5. Job 생성과 수정

### 기본 정보

| 필드 | 필수 | 규칙 |
|---|---|---|
| Job Name | 예 | 영문 소문자·숫자·`_`·`-`; 생성 뒤 변경 불가 |
| Service Name | 표시 전용 | `_dbu_<jobName>`으로 Backend가 결정 |

Job은 공통 Profile이나 공통 DBus 주소를 고르지 않는다. Method Call마다 DBus Interface와 Method를 고르고, 실제 입력값을 넣는다. 실행 중 Job은 편집 화면으로 들어갈 수 없고 API도 변경을 거부한다.

### 실행·저장·DB 설정

- 기본 Run Interval은 1,000ms다.
- 실패 시 다음 cycle은 5초, 10초, 20초, 이후 30초 간격으로 재시도한다. 같은 cycle에서 Method를 반복하지 않는다.
- `perMethod`는 성공한 Method마다 저장한다. `afterAllMethods`는 모든 Method 성공 뒤 한 번 저장을 시도한다. 둘 다 DB 트랜잭션 원자성을 약속하지 않는다.
- 등록 DB Server, TAG Table, 숫자 Value Column, 선택 String Value Column을 고른다. 숫자 output만 저장할 때 String Value Column은 `None`으로 둘 수 있다. 문자열 output은 그대로, object output은 JSON 문자열로 String Value Column에 저장되므로 이 두 output을 쓰는 Job에는 String Value Column이 필요하다. primary key와 basetime column의 이름은 고정하지 않는다.

### DB Server 관리 흐름

Main의 DB Server 관리 화면은 등록 DB Server를 목록으로 보여 주고 Create, Edit, Delete, Test Connection을 제공한다. Create/Edit에서는 서버 이름과 접속에 필요한 값을 입력하고 `POST` 또는 `PUT /db/server`로 저장한다. 비밀번호는 입력·전송에만 쓰며 Job config나 목록·오류·로그에 다시 보여 주지 않는다.

Job form은 먼저 `GET /db/server/list`로 등록 서버를 고른다. 선택 후 `GET /db/connect?server=...`으로 연결 가능 여부를 확인하고, `GET /db/table/list?server=...`에서 table을 고른다. table을 새로 만들 때는 `POST /db/table/create`를 사용한다. 이후 `GET /db/table/columns?server=...&table=...`로 value/string value column 후보와 metadata를 받아 보여 준다. Backend가 TAG primary key와 basetime column을 판별하므로 FE는 컬럼 이름을 가정하지 않는다.

### Method Call과 Tag

Job에는 Method Call이 하나 이상 필요하고 화면 순서가 실행 순서다. 각 Call draft는 `interfaceId`, `methodId`, raw `inputs`, Tag 목록을 가진다. 화면은 DBus Interface별로 접고 펼치는 구조로 Call을 묶되, 호출 순서는 전체 Job 순서다. drag-and-drop과 키보드로 쓸 수 있는 위/아래 이동 버튼을 모두 제공한다. 각 Call은 Interface, Method, 입력 요약, Tag 수, 수정·삭제 동작을 표시한다.

입력 editor는 `inputs[].editor` 또는 `dbusType`으로 고른다. FE는 `type:value` 문자열을 만들지 않고 원시값만 전송한다. Backend가 Method 정의 순서에 맞춰 type hint를 만든다.

LS `GetDeviceData`에서 `dataCount: 3`, `memoryAddress: "%MB3"`이면 `%MB3`, `%MB4`, `%MB5` Tag를 준비한다. `incrementTrailingNumber` 전략만 1차 지원한다. 알 수 없는 전략은 Method 비호환으로 표시하고 저장·시작을 막는다.

자동 생성 Tag에서 이름이나 Transform을 사용자가 바꾼 경우 입력 변경으로 덮어쓰지 않는다. `Add Missing Only`, `Regenerate All`, `Cancel`을 제공하고, 수가 줄어 삭제될 행은 확인한다. Tag name은 최대 100자다. 저장 전과 일괄 편집 preview 적용 전에는 빈 이름, Job 안의 중복 이름, 100자 초과, 연속 outputIndex, 유한하지 않은 bias/multiplier, 기대 반환 수 불일치를 전체 Job 기준으로 검사한다.

Transform은 다음 두 가지뿐이다.

```text
bm: (value + bias) × multiplier
mb: value × multiplier + bias
```

일괄 편집은 선택 행의 prefix/suffix, 찾기/바꾸기, 줄 단위 이름 붙여넣기, bias, multiplier, 계산 순서, Transform 초기화를 preview와 함께 제공한다. 다른 Job과 같은 DB/Table에 같은 Tag 이름이 있으면 경고하지만 저장을 막지 않는다.

## 6. DBus Interface와 Method 관리

DBus Interface 목록은 Bus Type, Destination, Object Path, Interface 이름, Built-in/User, Method 수와 참조 상태를 표시한다. 생성 모달은 Bus Type, Destination, Object Path를 받고 **Discover**를 제공한다. Discover 결과는 모든 Interface와 Method, 입력·출력 파라미터를 처음부터 펼쳐 보이며, 장비 Interface를 먼저 정렬하고 `org.freedesktop.*`에는 `Standard` 뱃지를 붙인다.

기본 빌드는 DBus Interface 목록이 비어 있을 수 있다. 이 경우 목록의 빈 상태와 New DBus Interface 동작을 표시하며, Job 화면은 Interface 선택 전 Method Call 추가를 허용하지 않는다. `--with-ls-interface` 빌드에서만 읽기 전용 LS PLC Interface와 `GetDeviceData`가 목록에 처음부터 보인다.

- Discover는 저장하지 않는다. 사용자가 Save All을 누르면 발견한 모든 Interface와 Method를 저장한다.
- Introspection을 지원하지 않거나 권한이 없으면 사용자는 Interface 이름, Method 이름, 모든 입력·출력 파라미터 이름과 DBus type을 직접 입력한다.
- Built-in LS PLC Interface와 `GetDeviceData` Method는 읽기 전용이다.
- 사용자 Interface 또는 Method를 참조하는 Job이 하나라도 있으면 수정·삭제 버튼을 비활성화하고 참조 Job을 안내한다.
- 다시 Discover한 결과에서 참조 중인 `discovered` Method의 시그니처가 바뀌거나 사라지면 `review-required`를 표시한다. 화면은 이를 자동 저장하지 않으며, 사용자가 Job을 고쳐 참조를 해제하거나 새 Method를 고르게 한다.

## 7. Test Call, DataViewer, 접근성

Test Call은 저장되지 않은 현재 DBus Interface/Method와 원시 Inputs로 호출한다. 결과에는 호출 시각, 소요 시간, 성공 여부, 추출 값 수, 반환 count, Tag preview를 표시한다. 원본 body는 접을 수 있는 진단 영역에서만 보여 주고 저장하지 않는다.

DataViewer는 Job → Method Call → Tag tree를 사용한다. 현재 Job 설정의 Tag만 기본으로 보이며, 같은 table의 다른 Job Tag나 이름 변경 전 과거 Tag를 자동으로 넣지 않는다. `GET /db/table/tags`로 선택 table의 Tag 후보를 읽되, Job config에 없는 Tag는 tree에 자동 추가하지 않는다. `GET /db/table/data`는 Grid의 cursor pagination, UTC 시간 범위, rows per tag를 지원한다. Grid pagination은 snapshot이 아니므로 조회 사이 새 행이 append되면 다음·이전 페이지의 행 구성이 달라질 수 있다. 고정 분석에는 UTC `to` 시간을 지정한다. `GET /db/table/chart`는 선택 Tag와 UTC 시간 범위의 차트 series를 반환한다. Grid는 문자열 값도 보여 주고 Chart는 숫자 Value Column Tag만 선택할 수 있다. Raw/Grid와 Chart, Forward/Backward, ECharts option/model을 제공한다.

DataViewer는 UTC만 사용한다. 화면의 timestamp와 시간 범위 입력은 `Z`가 붙은 UTC ISO-8601 값이며, timezone 선택기·`Asia/Seoul` 같은 IANA 이름·`+09:00` 같은 offset 입력은 v1에 없다.

Log Viewer는 `GET /log/list?name=...`으로 Job 로그 파일을 고르고, `GET /log/content?name=...` 또는 `GET /log/content/all?name=...`으로 내용을 읽고, `GET /log/tail?name=...`으로 마지막 부분을 갱신한다. 전체 Job 로그 보기에는 `GET /log/all`을 쓴다.

icon button에는 `aria-label`과 title을 둔다. 상태는 색과 텍스트를 함께 표시하고 오류는 `role="alert"`, 경고는 `role="status"`, 첫 로딩은 `aria-live="polite"`를 사용한다. 대량 Tag 변경은 변경 건수와 preview를 먼저 보여 준다.

## 8. API 사용 원칙

API base path는 `/cgi-bin/api`다. 모든 성공 응답은 `{ "ok": true, "data": ... }`, 실패 응답은 `{ "ok": false, "code", "reason", "details" }`다. FE는 `reason`을 사람에게 보여 주고 `code`로 control과 화면 위치를 고른다.

Job 생성 form은 `POST /job`에 `{ name, config }`만 보낸다. `name`은 form의 Job Name이고 `config`에는 `name` 키를 넣지 않는다. Job 수정 form은 상세 GET으로 받은 `revision`과 바뀐 필드만 담은 부분 config patch를 `PUT /job?name=<현재 이름>`에 보낸다. 수정 body에는 `name`을 넣지 않고 Job Name 입력은 읽기 전용이다. Backend가 `defaults → existing config → patch`를 깊이 병합하며, Method Call·Tag 같은 배열은 FE가 보낸 배열 전체로 교체된다.

FE는 `JOB_INVALID`이면 create form의 잘못된 config를 표시하고, `JOB_NAME_IMMUTABLE`이면 이름이 수정 대상이 아님을 알린다. `JOB_CONFLICT`이면 다른 관리자의 저장 또는 같은 Job mutation 진행을 알리고 최신 설정을 다시 읽어 다시 수정하라고 안내한다. `JOB_INVALID_CONFIG`이면 파일명과 저장 name 불일치 진단을 보여 주며 어떤 lifecycle 또는 저장·삭제 요청도 보내지 않는다.

브라우저 요청에는 인위적인 timeout을 두지 않는다. 사용자가 취소하거나 화면이 닫힐 때만 AbortSignal을 전달한다. `Request timed out` UI와 timeout 상수는 없다.

사용 API는 settings, `dbus-interface/list`, `dbus-interface`, `dbus-interface/discover`, `dbus-method`, job, job/validate, job/install, job/start, job/stop, job/last-run, dbus/call, `db/server`, `db/server/list`, `db/connect`, `db/table/create`, `db/table/list`, `db/table/columns`, `db/table/tags`, `db/table/data`, `db/table/chart`, `log/all`, `log/list`, `log/content`, `log/content/all`, `log/tail`이며, 각 요청·응답 필드는 `BE_DESIGN.md`와 `DBUS_SDD.md`를 따른다.
