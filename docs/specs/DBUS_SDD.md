# DBus Collector 통합 SDD

## 1. 결정 요약과 우선순위

이 문서는 `neo-pkg-dbus` 구현의 단일 기능 기준이다. 기능이 `FE_DESIGN.md` 또는 `BE_DESIGN.md`와 다르게 읽히면 이 문서의 결정이 우선한다. 시각 규칙은 저장소 루트 `DESIGN.md`가 우선하며 이 문서는 화면의 기능과 상태만 정한다.

Database default track (approved 2026-08-11): `settings.json` stores one default Database Server. Each server can store a default Table, Value Column, and optional String Value Column. A new Job copies only those Database values; it does not receive a default DBus Interface, Method, output parser, or tag rule.

1. Side/Main jobs 패키지만 구현한다.
2. 최소 Neo는 `8.5.8`, 모든 새 JSON schemaVersion은 `1`이다. 단일 개발 브랜치에서 `generic` 또는 `ls` target을 선택해 같은 이름의 `neo-pkg-dbus` 완성 package를 루트에 만든다. 두 target은 하나의 version과 설치 위치를 공유하며 동시에 설치하지 않는다. 인자 없는 `npm run build`는 항상 generic이다. generic build는 `provider:null`이고 기존 DBus Interface/Method/Job 관리 기능을 모두 제공한다. Provider build는 검증된 읽기 전용 Provider Profile이 명시한 화면 표시와 새 Job 초기값만 바꾼다.
3. Job service 이름은 `_dbu_<jobName>`이다.
4. 실행 중 Job은 Edit, Delete, Backend update를 할 수 없다. stop-save-start 갱신은 금지다.
5. DBus와 브라우저 API 요청에 요청 timeout을 만들지 않는다.
6. installed, running, Controller 원본 상태는 서로 다른 값으로 전송한다. `config-only`는 외부 service 삭제를 진단하는 복구 상태로만 남긴다.
7. API envelope는 성공 `{ok,data}`, 실패 `{ok:false,code,reason,details}`다.
8. 여러 관리자의 장기 화면 잠금은 제공하지 않는다. 대신 같은 Job의 POST create/start/stop, PUT update, DELETE와 package stop/uninstall을 하나의 mutation operation으로 직렬화한다. Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 `operation lock`을 유지하고, 다른 mutation이 lock을 보유하면 HTTP 409 `JOB_CONFLICT`를 반환한다. GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다. Job GET 응답의 정수 `revision`은 PUT에 반드시 보내며, 저장 직전 revision이 달라져도 HTTP 409 `JOB_CONFLICT`로 거부한다. 화면은 최신 설정을 다시 읽어 사용자가 다시 수정하게 한다.
### 1.1 구현 중 확정한 계약 보완 기록

아래 항목은 구현·검토 중 발견해 **현재 계약으로 확정한 변경**이다. 각 항목은 이전 약속, 새 약속, 바꾼 이유와 확인 근거를 함께 남긴다. 앞으로 계약을 바꿀 때도 이 형식으로 승인 상태와 근거를 기록한다.

| ID | 이전 계약 | 확정한 새 계약 | 이유와 확인 근거 | 승인 상태 |
|---|---|---|---|---|
| CCR-001 | 장기 화면 잠금이 없다는 원칙만 있었고, 같은 Job의 Start·수정·삭제 요청이 겹칠 때의 순서가 충분히 정해지지 않았다. | 장기 화면 잠금은 계속 제공하지 않는다. 대신 짧은 서버 `operation lock`과 `revision`으로 같은 Job의 mutation을 직렬화하고, 충돌은 `409 JOB_CONFLICT`로 돌려준다. | 요청이 겹치면 Controller side effect와 설정 저장의 순서가 뒤섞일 수 있었다. 사용자는 최신 설정을 다시 읽어 다시 수정한다. 자세한 순서는 3.1이다. | 기존 확정 |
| CCR-040 | Job 생성은 config-only를 만들고 사용자가 별도 Install을 눌러야 했다. Start/Stop 뒤 Side와 Main 상세는 서로 다른 최신 상태를 보일 수 있었고, 목록이 있는 Refresh도 Loading jobs 문구를 보였다. | POST /job은 config 저장과 Controller install을 한 operation으로 수행해 `installed` / `stopped`를 반환한다. `POST /job/install`과 화면 Install control은 제거한다. 외부 service 삭제로 config-only가 되면 Start가 자동 설치 후 시작한다. Start/Stop은 현재 Job 행을 즉시 응답으로 갱신하고 반대 화면은 BroadcastChannel 신호 뒤 상세를 다시 읽는다. 목록이 있으면 Refresh 중 Loading jobs 문구를 보이지 않는다. | 사용자는 Job을 만들고 곧바로 Start/Stop만 하면 된다. Controller 등록은 내부 준비 단계이므로 별도 화면 행동이 될 이유가 없다. | 승인됨 — 사용자 “그래 그 방식이 맞지.” |
| CCR-002 | 실행 중 참조만 막는 규칙이어서, Interface/Method 저장과 Job의 Interface 검증이 동시에 일어날 때의 경계가 분명하지 않았다. | Interface mutation fence, Job의 Interface reader, 정렬된 Job lock 순서로 참조를 다시 확인한다. | Job이 오래된 Interface/Method를 보고 시작하거나, 참조 중인 Method가 바뀌는 경합을 막기 위해서다. 자세한 순서는 3.1이다. | CCR-009로 용어·대상 갱신 |
| CCR-003 | DataViewer가 `NAME`, `TIME`이라는 열 이름을 기본으로 가정할 수 있었다. | TAG metadata FLAG의 유일한 primary key와 basetime 열을 찾아 쓴다. 역할 열이 없거나 둘 이상이면 실패한다. | 정상 TAG table도 실제 열 이름이 다를 수 있다. 잘못된 열을 조용히 읽는 것보다 안전하게 오류를 내는 편이 맞다. | 기존 확정 |
| CCR-004 | 페이지를 넘겨도 행이 중복·누락되지 않는다고만 읽힐 수 있었다. | 당시에는 한 응답 안에서 basetime과 내부 `_RID` 정렬로 중복·누락을 막고, pagination은 snapshot이 아니라고 정했다. 이 `_RID` 규칙은 **CCR-021로 대체**됐다. | 계속 수집되는 table에서는 offset 기준 행이 밀리는 것이 정상이다. 사용자가 이를 알맞은 동작으로 승인했으며, 고정 분석은 `to` 시간으로 범위를 고정한다. | 기존 확정 — `_RID` 부분은 CCR-021로 대체 |
| CCR-005 | Job/Interface ID 길이와 lock 파일 키의 상한이 충분히 정해지지 않았다. | Job name과 Interface ID는 최대 100자이며, Interface reader lock에는 raw ID 대신 고정 64자 SHA-256 key를 쓴다. | 검증 전의 긴 입력도 경로 이탈이나 파일 이름 길이 초과를 만들지 않게 한다. | CCR-009로 용어·대상 갱신 |
| CCR-006 | DataViewer의 기본 시간대와 IANA 지역 시간대 지원 범위가 확정되지 않았다. | DB 저장값과 CGI API 범위는 UTC(`Z`)를 유지한다. 화면은 UTC·LOCAL·IANA timezone 선택으로 **표시만** 바꾼다. CGI timezone query는 받지 않는다. | 수집 데이터의 기준은 UTC로 고정하면서도, 원본 OPC UA DataViewer처럼 사용자가 읽는 시간대는 고를 수 있어야 한다. 이 변경은 CCR-052의 원본 전체 이식 승인에 따른다. | CCR-052로 대체됨 |
| CCR-007 | Side의 New Profile/New DB Server는 `{type:"navigate",path}`로 Main route를 바꾸고 생성 화면을 열었다. | Side는 `{type:"open-create-modal",target:"dbus-interface"|"db-server"}`를 BroadcastChannel로 보낸다. `db-server`는 `Database Servers` 목록 모달을 열고, 목록 안의 `Add Server`와 Edit가 각각 입력 모달을 연다. Main과 통합 화면은 현재 route를 유지한다. 기존 `select-job`, `new-job`, `navigate`, `refresh` 메시지는 그대로 유지한다. | 이 패키지는 Single Page App이며 Side의 생성 동작이 현재 상세 화면을 바꾸면 안 된다. DBus Interface와 Database Server 관리를 참고 패키지와 같은 목록→입력 모달 흐름으로 통일한다. CCR-009로 New Profile의 대상은 DBus Interface로 바뀌었다. | 승인됨 — 사용자 요청과 CCR-009 |
| CCR-008 | Main의 `/` 경로는 Job이 하나라도 있으면 첫 Job 상세로 자동 이동했고, Job 생성·수정 화면에는 텍스트 Cancel만 있었다. 생성 모달의 배경은 불투명해서 뒤 화면을 볼 수 없었다. | Main의 `/` 경로는 자동 선택하지 않고 제목·상단 메뉴·카드 없이 중앙 안내만 보인다. Job이 없으면 `inbox`, `No jobs yet`, `Click "New" to get started`를, Job이 있으면 `inbox`, `Select a job from the sidebar`를 보인다. Job 생성·수정 화면에는 이전 화면으로 돌아가는 32px Back 화살표를 둔다. 생성 모달 배경은 검정 50% overlay로 뒤 화면을 보이게 하면서도 어둡게 구분한다. | 참고 화면의 빈 상태와 모달 overlay 구조, Side에서 Job을 고르는 흐름을 명확히 맞추고, 처음 열거나 새 Job 화면에서 안전하게 돌아갈 길을 제공하며, 모달을 열어도 현재 화면의 맥락을 보존하기 위해서다. 사용자가 직접 요청했다. API·Backend에는 영향이 없다. | 승인됨 — 사용자 “현재 모달이 나올때, 뒷배경이 가려지고 있어… Select a job from the sidebar…”, “메인 첫 진입시 위에 쓸데 없는 메뉴, 타이틀 다 지워.”, “주소 다시 참고해서 메인 화면 제대로 변경해”, “스타일 정확히 따라해” |
| CCR-009 | Profile이 Bus Type, Destination, Object Path, Interface와 Method를 한데 묶었다. Job도 Profile 하나와 공통 DBus 주소만 고를 수 있었다. | Profile 계약을 삭제하고 DBus Interface → DBus Method → Job Method Call로 나눈다. Job의 각 Call이 `interfaceId`와 `methodId`를 가리키므로 서로 다른 Interface의 Method를 한 Job에서 순서대로 호출할 수 있다. | Profile은 사용자가 왜 만들어야 하는지 알기 어려웠고, DBus의 실제 책임 경계인 Interface와 맞지 않았다. Introspection으로 Interface·Method·파라미터를 읽고, 실패 시 직접 입력할 수 있게 하려는 목적이다. 이 기능은 신규 개발이므로 Profile API·파일·Job 필드는 변환하거나 호환하지 않는다. 상세 설계 기록은 `docs/superpowers/specs/2026-08-05-dbus-interface-method-design.md`를 따른다. | 승인됨 — 사용자 “프로필도 사용자가 추가는 할 수 있게… 다시 설계”, “1번으로 상세 설계”, “신규 개발이라 변환 안해도돼” |
| CCR-010 | LS PLC 기본 Interface는 모든 빌드에 고정 포함되는 것으로 읽혔다. | `frontend`에서 `npm run build:root`는 기본 Interface 없이 빌드하고, `npm run build:root -- --with-ls-interface`만 `cgi-bin/interfaces.d/ls-plc-device.json`을 포함한다. | LS 장비가 없는 사용자는 불필요한 기본 자산 없이 빈 목록에서 Discover 또는 직접 입력으로 시작해야 한다. 이 선택은 빌드 산출물만 바꾸며 사용자 Interface·Method·Job은 바꾸지 않는다. | 승인됨 — 사용자 “빌드 명령이 맞는거 같다”, “맞아” |
| CCR-011 | DataViewer 정렬 설명의 `TIME` 표현이 실제 열 이름을 고정하는 것처럼 읽힐 수 있었다. | 모든 DataViewer 정렬·조회 설명은 metadata FLAG로 찾은 **basetime 열**을 뜻한다. `TIME`과 `NAME`은 기본 열 이름이 아니다. | DB 계약은 실제 primary key와 basetime 열 이름을 metadata에서 찾도록 이미 정한다. 고정 이름 표현은 이 약속과 충돌한다. | 승인됨 — 사용자 “리뷰대로 계약 문서 수정” |
| CCR-012 | `/db/server`, `/db/table/*`, `/log/*`의 표는 목적만 설명했고 요청·응답의 필수 공통 필드를 정하지 않았다. | 이 API들은 각 endpoint의 필수 식별 query/body, 선택 query, 성공 data의 최상위 구조를 **4.1 API 세부 형식**으로 공개한다. | FE와 Backend가 서로 다른 query 이름 또는 pagination 응답을 추측하지 않게 한다. | 승인됨 — 사용자 “리뷰대로 계약 문서 수정” |
| CCR-013 | package stop/uninstall의 fence와 `PACKAGE_LIFECYCLE_FAILED`는 정했지만, CGI API인지 package lifecycle script인지 구분하지 않았다. | package stop/uninstall은 CGI API가 아니라 package lifecycle script의 동작이다. 실패하면 script는 `PACKAGE_LIFECYCLE_FAILED`와 `details.errors[]`를 표준 오류 envelope로 stdout에 쓰고 non-zero로 끝난다. | 호출 주체와 오류를 받는 방법을 분명히 해 CGI API 표와 혼동하지 않게 한다. | 승인됨 — 사용자 “리뷰대로 계약 문서 수정” |
| CCR-014 | Frontend 문서에 Backend lock 파일·stale 회수·회귀 테스트 상세가 중복돼 기준이 나뉠 수 있었다. | lock 알고리즘과 회귀 테스트의 유일한 기준은 이 SDD와 `BE_DESIGN.md`다. `FE_DESIGN.md`에는 사용자가 보는 `JOB_CONFLICT` 처리만 둔다. 또한 공개 오류 코드 목록은 이 문서에 적힌 코드를 모두 포함한다. | FE는 서버 lock을 직접 구현하지 않으므로 중복을 줄이고, 외부 호출자가 오류 처리를 추측하지 않게 한다. | 승인됨 — 사용자 “리뷰대로 계약 문서 수정” |
| CCR-015 | DataViewer가 현재 Job의 Tag만 허용하지만 요청에 Job 식별자가 없었다. | `/db/table/tags`, `/db/table/data`, `/db/table/stat`, `/db/table/chart`는 `job` query를 필수로 받는다. Backend는 Job의 DB server/table/column mapping만 대조하고, 같은 Table의 실제 Tag는 현재 Job이 만들지 않았어도 허용한다. | Job은 데이터 원본과 접근 권한을 고르는 기준이다. 전체 Table 탐색은 원본 OPC UA DataViewer의 동작이며 CCR-052 승인으로 기존 Tag 제한을 바꾼다. | CCR-052로 대체됨 |
| CCR-016 | DBus Interface/Method 변경의 POST·PUT·DELETE lock 순서가 SDD와 BE에서 다르게 읽혔다. | 세 요청 모두 Interface mutation fence → Interface reader 확인 → 참조 Job 이름순 lock → 참조 재조회 → 검증·저장/삭제 순서를 사용한다. 참조가 남으면 PUT/DELETE는 `DBUS_INTERFACE_IN_USE` 또는 `DBUS_METHOD_IN_USE`로 거부한다. | Job create/update/start와 Interface 변경이 겹쳐도 side effect 순서가 갈리지 않게 한다. | 승인됨 — 사용자 “SDD에 POST·PUT·DELETE별 lock 순서를 표로 확정하고 BE가 그대로 따르게” |
| CCR-017 | FE 앞부분이 LS Interface를 기본 제공한다고 단정해 선택 빌드 조건과 충돌했다. | FE도 `--with-ls-interface` 빌드에서만 LS PLC Interface와 Method를 기본 제공한다고 명시한다. | SDD·BE와 같은 지원 범위를 보여 준다. | 승인됨 — 사용자 “SDD/BE의 --with-ls-interface처럼 fe 수정” |
| CCR-018 | Job 상세 성공 응답의 상태 필수가 예시와 상태 모델에 나뉘어 있었다. | GET/POST/PUT Job 상세 성공 data는 `name`, `config`, `revision`, `configState`, `executionState`, `statusKnown`, `controllerState`, `controllerDetail`을 항상 포함한다. nullable 값은 명시된 `null`만 허용한다. | FE가 UNKNOWN 상태를 추측 없이 처리할 수 있게 한다. | 승인됨 — 사용자 “상세 응답의 완전한 구조를 SDD 한 곳에 정의” |
| CCR-019 | `POST /job/validate`의 warning 구조와 성공 응답 관계가 없었다. | 유효한 draft는 HTTP 200 `{ "ok": true, "data": { "valid": true, "warnings": [{ "code": "...", "reason": "...", "path": "...", "details": {} }] } }`를 반환한다. `path`는 draft 안의 문제 위치를 가리키는 JSON Pointer다. warning은 저장 차단 오류가 아니며 `TAG_NAME_USED_BY_ANOTHER_JOB`는 공개 warning code다. | FE와 외부 호출자가 경고 위치와 이유를 안정적으로 표시하게 한다. | 승인됨 — 사용자 “warnings[] 구조 생성” |
| CCR-020 | DB Server 수정 때 비밀번호 누락 의미와 TAG table 생성 입력이 모호했다. | DB Server 생성·수정은 모두 `name`, `host`, `port`, `user`, `password`를 필수로 받는다. TAG table 생성은 server/table/valueColumn/선택 stringValueColumn만 받고, `stringValueColumn`은 생략하거나 `null`로 보낼 수 있으며 Backend가 key·time 열과 자료형을 정한다. | 비밀번호 유지·삭제를 추측하지 않고, 사용자가 DB 형식 세부를 고르지 않아도 되게 한다. | 승인됨 — 사용자 “비밀번호는 서버쪽 수정할때마다 항상 입력을 받아야하는 필수인 값이야”, “1” |
| CCR-021 | DataViewer Grid는 basetime 뒤에 내부 `_RID`를 정렬하고, 같은 basetime 행도 페이지에서 빠지거나 겹치지 않는다고 약속했다. | Grid는 metadata FLAG로 찾은 basetime 열만 정렬한다. `_RID`를 조회·정렬·응답에 쓰지 않는다. 같은 basetime 행의 상대 순서와 페이지 경계 안정성은 보장하지 않는다. | 실제 Neo `v8.5.7-snapshot` TAG 가상 테이블에서 `SELECT _RID`와 `SELECT ID`가 모두 `Column name ... not found`로 실패했다. 공식 문서는 `_RID`의 존재를 보이지만 TAG 데이터 조회 지원 문법을 확정하지 않는다. | 승인됨 — 사용자 “그러면 빼자” |
| CCR-052 | DataViewer는 현재 Job 설정 안의 Tag만 트리·조회 대상으로 삼고, UTC 고정 Grid/간단 Chart만 제공했다. | `neo-pkg-opcua-client` DataViewer의 태그 탐색, 다중 선택, Raw Grid, 시간 범위·페이지·통계, Chart·분할 Chart·줌, 시간 형식·timezone 표시, Asset hierarchy, Derived Tag 표시와 Neo Web Tag Analyzer 연결을 공통 기능으로 이식한다. Job은 DB source를 고르는 기준으로만 쓰며, 같은 server/table의 실제 Tag는 모두 선택할 수 있다. 이 항목은 CCR-006의 화면 UTC 고정과 CCR-015의 현재 Job Tag 제한을 대체한다. | DBus 수집 계약은 DB source와 접근 검증을 지키되, DataViewer의 디자인·기능이 OPC UA 패키지에 비해 부족했다. 사용자가 원본 전체 이식과 계약 변경을 명시 승인했다. | 승인됨 — 사용자 “진짜 그냥 다 그대로 가져와 계약도 변경하고” |
| CCR-022 | `GET /dbus-interface?id=`의 `references[]`에는 참조 Job 이름과 Call ID만 있어, FE가 어느 Method가 실제로 참조됐는지 알 수 없었다. | Interface 상세 응답의 각 `references[]` 항목에 필수 `methodIds: string[]`를 둔다. 이는 해당 Interface에서 그 Job이 실제 참조하는 고유 Method ID 목록이다. 상세 응답의 전체 구조는 4.1에 단일 기준으로 정의한다. | 참조된 Method만 수정·삭제를 막고, 같은 Interface의 다른 Method는 관리할 수 있어야 한다. Backend의 참조 분석과 FE의 Method 버튼 차단이 같은 목록을 사용함을 단위 테스트로 확인했다. | 승인됨 — 사용자 “승인” |
| CCR-023 | Built-in DBus Interface의 Edit는 비활성이라 상세 내용을 열어 볼 수 없었다. 목록 행 선택도 상세 API를 요청하지 않았다. | Built-in의 Edit는 활성화하고 `GET /dbus-interface?id=`로 읽기 전용 상세를 연다. 제목은 `View DBus Interface`이며 Interface 입력, Discover, Save Interface, Method 추가·수정·삭제와 그 입력은 모두 비활성이다. Built-in Delete는 계속 비활성이다. 목록 행 선택은 계속 네트워크 요청을 하지 않는다. 공개 API 형식은 바꾸지 않는다. | 기본 제공 LS PLC Interface와 Method의 값을 확인할 수 있어야 하지만, 변경 요청은 절대 보내면 안 된다. 상세 GET은 이미 공개된 API를 사용하므로 API 계약을 넓히지 않는다. | 승인됨 — 사용자 Task 2 작업 지시 |
| CCR-024 | 목록에서 참조 상태를 보여 주고, 참조가 있으면 목록 단계에서 Edit/Delete를 막는 것으로 읽힐 수 있었다. Interface/Method 입력 오류는 공개 오류 코드 목록에 없었다. | 목록은 참조 상태를 표시하거나 목록 단계에서 참조 여부를 추측하지 않는다. 행 선택은 상세 요청을 보내지 않고, 사용자가 Edit 또는 Delete를 누를 때만 `GET /dbus-interface?id=`를 먼저 호출한다. 그 상세의 `references[]`로 안전하게 차단한다. Built-in View 상세는 모든 Method의 입력·출력과 참조 정보를 읽기 전용으로 표시한다. 유효한 다른 Method만 참조 중이면 새 Method 추가와 미참조 Method 변경은 허용하고, 참조된 Method만 막는다. `invalidConfig: true` 또는 review-required 상태 저장소를 읽거나 해석할 수 없는 경우는 안전하게 모든 Method 변경을 막는다. `DBUS_INTERFACE_INVALID`, `DBUS_METHOD_INVALID`을 공개 오류 코드로 추가한다. | 목록 API에는 참조 정보가 없고, 미리 요청하면 불필요한 상세 조회가 생긴다. 상세 조회 뒤의 최신 참조 정보만으로 막아야 한다. Method 단위 보호를 지키면서 다른 Method 관리를 가능하게 하고, 상태 파일 오류를 `false`로 숨기지 않기 위해서다. | 승인됨 — 사용자 “1~3 구현 보완 및 4는 목록에서는 참조 상태를 표시하지 않고, Edit/Delete를 누른 뒤 상세 조회에서만 차단, 5는 오류 목록에 추가. Minor도 수정” |
| CCR-025 | 상세 응답은 Method별 `reviewRequired: boolean`만 반환했다. 따라서 검토가 실제로 필요한 상태와 검토 상태 파일을 읽을 수 없는 상태를 화면이 구별할 수 없었다. | `GET /dbus-interface?id=`의 성공 `data` 최상위에 필수 `reviewRequiredState: "available"\|"unavailable"`을 둔다. 상태 파일이 없거나 정상적으로 읽히면 `available`, 읽기 또는 JSON 해석 오류면 `unavailable`이다. `unavailable`일 때에도 읽기 전용 상세는 반환하되 모든 Method의 `reviewRequired`는 `true`이며, FE는 새 Method·수정·삭제를 모두 막는다. | `reviewRequired: true`만으로는 실제 검토 대상과 상태 저장소 장애를 구분할 수 없어, 안전 차단의 이유를 사용자에게 정확히 알릴 수 없었다. Backend가 오류 시에도 읽기 전용 상세를 반환하는 구현과, 상태가 `unavailable`이면 모든 변경을 막는 화면 동작을 단위 테스트로 확인한다. 영향 범위는 상세 API 응답, Backend 상태 계산, FE의 Method 변경 차단이다. | 승인됨 — 사용자 “승인” |
| CCR-026 | `reviewRequiredState: "unavailable"`일 때 Interface 삭제와 Interface 속성 수정의 범위, 그리고 `/dbus-method` POST·PUT·DELETE 요청 wrapper 구조가 문서에 완전히 적혀 있지 않았다. | `unavailable`이면 Interface 삭제와 Method 추가·수정·삭제를 막는다. 다만 저장된 Method 배열과 요청 Method 배열이 완전히 같으면 Destination·Object Path 등 Interface 속성 수정은 허용한다. `/dbus-method`는 POST body `{interfaceId, method}`, PUT body `{interfaceId, methodId, method}`, DELETE query `interfaceId`, `methodId`만 허용한다. PUT은 바깥 `methodId`와 `method.id`가 모두 필수이고 같아야 하며, 모든 wrapper의 알 수 없는 필드는 `DBUS_METHOD_INVALID`으로 거부한다. | 상태 파일 오류에서 Method 정의를 잃거나 바꾸지 않으면서도 연결 정보는 바로 고칠 수 있어야 한다. 요청 형식을 명확히 해 FE·Backend가 ID 출처를 다르게 해석하거나 알 수 없는 값을 조용히 버리지 않게 한다. | 승인됨 — 사용자 “검토 상태가 unavailable일 때 … /dbus-method 요청 형식 … 문서 보완” |
| CCR-027 | Discover 뒤 `Save All` 한 번으로 발견한 모든 Interface와 Method를 일괄 저장했다. | Discover는 저장하지 않는다. 결과는 선택 목록으로 보이며 사용자가 한 Interface를 고르면 그 Method 목록을 현재 편집 폼에 반영한다. 저장은 footer의 단일 `Save Interface`만 쓴다. 새 Interface는 `POST`, 기존 Interface 재-Discover는 `PUT ?discover=true`으로 한 Interface만 저장한다. `{interfaces:[...]}` 배열 wrapper와 Save All·카드별 저장은 제공하지 않는다. | 원하지 않는 표준 Interface까지 함께 등록되는 일을 막고 저장 동작을 하나로 만든다. 영향 범위는 Discover 화면, Interface API, Backend 병합 규칙, 테스트다. | 승인됨 — 2026-08-06 사용자: “애초에 save all은 존재하지 않아야하는 기능”, “연결 정보 입력 → Discover → Interface select → 선택 Method 자동 반영 → 단일 Save Interface” |
| CCR-028 | Parameter `type`은 일부 앱 전용 별칭만 허용했고, Introspection XML을 자체 정규식으로 읽었다. 표준 복합 signature가 있으면 Discover 전체가 실패할 수 있었다. | DBus Type의 유일한 기준은 [DBUS_TYPE_SYSTEM.md](DBUS_TYPE_SYSTEM.md)다. Discover는 Neo DBus module의 검증된 `Connection.introspect()` 구조화 결과를 사용하고, signature는 DBus 규격 parser로 읽는다. 기본·복합 Type을 전체 지원하고 Discover·저장·화면·Job·Test Call이 같은 Type 표현을 사용한다. | 원격 `ls.plc`의 정상 Introspection 응답에는 `v`, `a{sv}`가 포함된다. 기존 구현은 이를 읽지 못해 `INTROSPECTION_UNSUPPORTED`로 전체 결과를 버렸다. | 승인됨 — 2026-08-06 사용자: “원본 타입을 그대로 쓸수 있도록 해야해”, “전부 지원해야지”, “dbus 표준 관련 계약들 별도 문서로 작성” |
| CCR-029 | Neo DBus module은 기본 Type만 문자열 ABI로 변환하며 복합 Type 호출을 받지 못한다. | 공개 API·저장·화면은 표준 Type과 원시 JSON 값만 사용한다. Neo 호출 바로 전 어댑터만 기본 Type을 문자열 ABI로 바꾸며, `array`, `dict-entry`, `struct`, `variant`, `unix-fd` 호출은 HTTP 409 `DBUS_ARGUMENT_UNSUPPORTED`으로 거부한다. | 원시 숫자만으로는 `q`와 일반 숫자를 구별할 수 없고, 지원하지 않는 복합 Type을 다른 값으로 바꾸면 DBus 계약이 깨진다. | 승인됨 — 2026-08-06 사용자: “패키지만 수정… Neo가 안받는게 정상으로 취급”, “새 오류 추가” |
| CCR-030 | Add DBus Interface 모달에 Interface 이름 입력이 항상 보여 Discover 선택 흐름과 직접 입력 흐름이 섞였다. | Discover 선택 목록에는 실제 발견 Interface 뒤 마지막 항목으로 `Direct input`을 둔다. 이 항목을 고를 때만 새 Interface의 Interface 이름 입력을 보인다. 실제 발견 Interface를 고르면 해당 Interface와 Method를 draft에 자동 반영한다. | 일반 사용자는 Object Path → Discover → Interface 선택만 하면 되고, Introspection을 쓸 수 없는 경우에도 같은 목록의 마지막 항목에서 수동 입력을 시작할 수 있다. | 승인됨 — 2026-08-06 사용자: “Discovered Interface 목록에 직접 입력을 추가해”, “직접 입력은 마지막 항목으로” |
| CCR-031 | Discover 선택 뒤에는 저장 반영 안내 문구만 보여 Method 내용을 확인할 수 없었고, 새 Interface의 사용자가 입력한 ID를 발견한 ID가 덮어썼다. | 안내 문구 대신 선택한 Interface의 Method와 입력·출력을 읽기 전용으로 표시한다. 새 Interface의 ID는 사용자가 이미 입력했다면 유지하고, 비어 있을 때만 발견한 Interface ID를 제안한다. 기존 Interface의 ID는 저장·Job 참조 키이므로 계속 읽기 전용이다. | 선택 전에 호출 구조를 검토할 수 있어야 하며, 사용자가 정한 저장 ID가 Discover 선택 때문에 바뀌면 안 된다. | 승인됨 — 2026-08-06 사용자: “선택한 인터페이스의 메소드 목록을 볼 수 있게”, “ID가 … 자동으로 변경되는 거 같은데” |
| CCR-032 | 새 Interface 생성 화면이 사용자가 내부 `id`를 입력하게 했고, 발견 결과가 그 값을 제안·변경할 수 있었다. | Interface 문서는 내부 `id`와 사용자가 입력하는 `name`을 함께 가진다. `POST /dbus-interface` body는 `name`을 필수로 받고 `id`를 받지 않는다. 서버는 생성 잠금 안에서 `name`의 slug(불가능하면 DBus Interface 이름의 slug)로 겹치지 않는 `id`를 만든다. PUT·GET·DELETE와 Job의 `interfaceId`는 이 내부 ID를 계속 쓴다. | 사용자가 보는 이름과 저장·Job 참조 키는 역할이 다르다. 이름 변경이 Job 연결을 끊지 않으며, 동시에 생성해도 파일 키가 겹치지 않는다. | 승인됨 — 2026-08-06 사용자: “id는 애초에 내부적으로 자동 생성하고 name을 사용자에게 입력 받도록” |
| CCR-033 | Discover 선택 상자가 미리 보이고 목록 아래에 Method 편집기가 남아 있어, 발견·직접 입력·Method 관리 흐름이 섞였다. | Discover 성공 뒤에만 Interface 선택 상자를 보인다. `Direct input`을 고를 때만 그 바로 아래에 Interface 입력을 보인다. Method는 별도 내부 스크롤 모달에서 관리한다. 자동 발견 Interface는 `origin: "discovered"`과 discovered Method만 가지며 Method를 직접 바꿀 수 없다. Direct input Interface는 `origin: "manual"`이고 manual Method만 추가·수정·삭제할 수 있다. Job이 참조하면 Interface의 `name`만 바꿀 수 있고 연결 정보·Discover·Method·삭제는 막는다. | 장비에서 읽은 호출 구조를 임의로 바꾸지 않고, Job이 사용하는 호출 기준을 보존한다. 많은 Method도 모달 안에서 확인한다. | 승인됨 — 2026-08-06 사용자: “메소드는 별도 모달로 관리”, “자동으로 가져오는 메소드는 수정 삭제를 하면 안되는거지”, “잡이 쓰는 인터페이스 자체는 수정 못하는게 맞을거 같아” |
| CCR-034 | Edit 화면이 `reviewRequiredState` 같은 상세 계산 필드를 PUT body에 포함했고, 생성·수정 모두 `Save Interface`라는 모호한 문구를 썼다. 자동 발견 Interface도 참조가 없어도 연결 정보와 Discover가 잠겨 있었다. | FE는 저장 요청에서 계산 필드를 제거한다. 새 Interface 버튼은 `Create Interface`, 기존 Interface 버튼은 `Update Interface`다. 참조 Job이 없으면 자동 발견 Interface도 연결 정보 수정과 Discover를 허용하되, discovered Method는 계속 읽기 전용이다. | API allow-list 오류를 없애고, 사용자가 생성과 수정을 구분할 수 있게 한다. 자동 발견은 Method 출처이지 Interface 연결 정보의 영구 잠금이 아니다. | 승인됨 — 2026-08-06 사용자: “우리 아무 잡에서 사용하지 않으면 수정할 수 있어야”, “save interface가 아닌 update? 이런 느낌이 맞아” |
| CCR-035 | Discover 결과의 변경 후보를 `reviewRequired` 상태 파일과 상세 응답으로 따로 관리했다. Job 참조가 있으면 Interface 변경 자체를 막는 현재 규칙과 겹쳤다. | `reviewRequired`, `reviewRequiredState`, `interface-review-required.json`, `DBUS_METHOD_REVIEW_REQUIRED`를 제거한다. Job이 하나라도 Interface를 참조하면 이름 외 Interface 변경, Discover, Method 변경, 삭제를 `DBUS_INTERFACE_IN_USE`로 거부한다. | 별도 검토 단계는 실제 변경 경로가 아니며, 참조 Job 보호가 더 단순하고 확실하다. 기존 상태 파일은 읽거나 쓰지 않는다. | 승인됨 — 2026-08-06 사용자: “우리의 계약은 잡이 사용하고 있으면 업데이트가 안된다고 고정했잖아”, “제거” |
| CCR-036 | Discover 뒤 선택 목록이 항상 비어 있고, Edit는 사용자가 다시 Discover를 눌러야 기존 Interface를 찾을 수 있었다. | Discover가 성공하면 FE는 정렬된 첫 Interface를 기본 선택한다. 사용자가 이미 선택한 Interface가 새 결과에도 있으면 그 선택을 유지한다. 참조 Job이 없는 discovered Interface의 Edit는 모달을 열 때 Discover를 자동 호출하고 저장된 `interface`와 같은 결과를 선택한다. manual Interface는 자동 Discover 뒤에도 `Direct input`과 기존 수동 값을 유지한다. 자동 Discover는 저장 요청을 만들지 않는다. | 새 등록의 다음 행동을 줄이고, 수정 시 현재 장비 구조를 바로 비교할 수 있게 한다. 수동으로 만든 Interface의 출처와 입력값은 바뀌지 않는다. | 승인됨 — 2026-08-06 사용자: “discover를 누르면 기본적으로 처음거를 선택”, “edit 들어오면 discover가 자동으로 호출되어서 … 기존 인터페이스가 선택” |
| CCR-037 | Job 생성·수정 화면에 Backend가 Job Name으로 계산하는 읽기 전용 `Service Name` 필드를 표시했다. | FE는 `Service Name`을 Job 생성·수정·상세·설치 결과 화면에 표시하지 않는다. Backend의 `_dbu_<jobName>` service 생성 규칙과 API·저장 형식은 바꾸지 않는다. | 사용자가 입력하거나 선택할 수 없는 내부 구현 이름은 화면 정보로 필요하지 않다. | 승인됨 — 2026-08-06 사용자: “상세 화면이나 설치 결과에도 안보여줘도 될 거 같아 필드 제거” |
| CCR-038 | DBus `string` 출력 안에 JSON 모양의 내용이 있으면, DBus Type 자체가 object/array인 것처럼 취급할 수 있었다. | 출력 선택의 기본 해석은 Introspection DBus Type 그대로다. `string` 출력만 사용자가 `parse as JSON`을 선택할 수 있으며, 그 뒤 JSON tree와 JSON Pointer로 내부 값을 고른다. array/dictionary는 해석 방식이 아니라 native 또는 JSON 해석 뒤 값의 형태다. | 실제 LS `GetDeviceData`는 `Return:string` 하나를 선언하고 body에 JSON 문자열 하나를 돌려준다. 바깥 body 배열은 반환 인자 목록이므로, 문자열 안의 JSON을 해석하려면 명시적 선택이 필요하다. 임시 상세는 `DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`를 따른다. | 승인됨 — 2026-08-06 사용자: “그러면 임시 출력 선택 계약 변경” |
| CCR-039 | JSON 내부 값을 고르려면 Test Call 결과에서 만든 드롭다운을 반드시 사용했고, `Store`가 저장 방식과 자료형을 섞어 표현했다. | 출력 선택은 사용자 입력 RFC 6901 `selector`, `valueType` (`numeric`/`string`/`json`/`array`), array의 `elementType`으로 정한다. 단, native 기본 DBus 출력은 Type이 저장 자료형을 결정하므로 세 필드를 저장하지 않는다. Test Call은 작성 필수 단계가 아니며 원본 body만 돌려주는 호출 결과·진단 기능이다. selector·자료형·Tag 미리보기를 만들지 않는다. Backend는 선택 결과의 자료형과 Tag 수를 실행 시 검증한다. | 사용자는 실제 응답 샘플이 없어도 선택 규칙을 먼저 정의할 수 있어야 하며, 선택값을 숫자·문자열·JSON·배열 중 어떤 방식으로 저장할지 분명히 정해야 한다. 영향 범위는 임시 출력 선택 문서, Job validator/decoder, Job 폼이다. | 승인됨 — 2026-08-06 사용자: “사용자가 설렉터로 이렇게 파싱할거다를 표시”, “뉴메릭인지 문자열인지 배열인지 json인지”, “네이티브 스트링인데 왜 벨류타입이 들어가냐” |
| CCR-040 | Tag에 배열 순서와 같은 `outputIndex`를 중복 저장·검사했고, 문자열 행은 숫자 `VALUE`에 null을 넣었다. | Tag의 `outputIndex`를 저장·API·검증에서 제거한다. Tag 배열 순서가 값 연결 순서다. 문자열·JSON·복합 출력 행은 `VALUE`에 `0`, `STR_VALUE`에 원본 문자열 또는 JSON 문자열을 저장한다. | 중복 내부 번호가 정상 Tag 목록을 잘못 막는 오류를 만들었다. Neo TAG append는 필수 숫자 value column에 값을 요구할 수 있다. 문자열 행이 숫자 차트에서 0으로 보일 수 있다. | 승인됨 — 2026-08-06 사용자: “승인 및 str value만 넣을 때… value가 0으로 입력” |
| CCR-041 | Tag가 실제 저장값 연결과 무관한 `sourceAddress`, `calcOrder`, `outputIndex`까지 저장했고, 두 가지 계산 순서를 제공했다. | 새로 저장하는 Tag는 `name`, `bias`, `multiplier`만 가진다. 예전 세 필드는 읽기 입력으로만 허용하고 다음 저장에서 제거한다. 숫자 Transform은 `(value + bias) * multiplier` 하나만 적용하며 숫자가 아닌 출력은 Transform하지 않는다. Tag 생성은 `Generate Tags` 모달에서 Prefix·Count로 진행한다. | 저장 형식과 실행 규칙을 하나로 단순화하고, 주소·순서는 출력 선택과 Tag 배열 순서가 맡게 한다. | 승인됨 — 2026-08-06 사용자 승인 |

| CCR-042 | Transform의 `bias`와 `multiplier` 묶음은 고정 순서여서 화면에서 두 항의 적용 순서를 바꿀 수 없었다. Method Call drag는 아이콘에서 시작해도 브라우저에 드래그 대상을 전달하지 않아 이동이 실패할 수 있었다. | 새 Tag는 `transformOrder: ["bias", "multiplier"]`를 저장한다. 두 항은 각각 한 번만 있고 왼쪽부터 적용한다. Transform 묶음은 드래그로 순서를 바꾸며, `["multiplier", "bias"]`는 `(value * multiplier) + bias`를 뜻한다. 기존 Tag에 이 필드가 없으면 기존 식 `(value + bias) * multiplier`를 쓴다. Method Call은 좌측 상단 drag 아이콘에서만 drag data를 시작하고, 대상 Call은 그 data로 순서를 바꾼다. | 사용자가 수식의 두 연산 순서를 직접 정하고, 드래그가 실제 브라우저에서도 안정적으로 동작해야 한다. 영향 범위는 Job Tag 저장·검증·수집 계산, Job Form, 임시 출력 선택 계약과 FE/BE 설계 문서다. 기본 순서와 기존 Job 호환은 유지한다. | 승인됨 — 2026-08-06 사용자 “승인” |
| CCR-043 | 새 Job의 Database Mapping은 `TAG`/`VALUE`/`STR_VALUE`를 기본값으로 넣고, Table과 Column을 목록에서만 고르게 했다. | 새 Job의 `database.table`, `valueColumn`, `stringValueColumn`은 빈 값으로 시작한다. Table과 두 Column은 직접 입력하거나 서버에서 발견한 후보를 고르는 콤보박스다. Column 입력은 Table 값이 있을 때만 활성화한다. | DB마다 Table·Column 이름이 다르므로 FE가 특정 TAG 이름을 가정하면 잘못된 Job 설정을 만들 수 있다. Backend 검증과 저장 형식은 바꾸지 않는다. | 승인됨 — 2026-08-07 사용자 “기본값을 없애고 입력 가능 + 설렉트 박스 형태” |
| CCR-043 | `string` 출력에서 `parse as JSON`을 새로 선택하면 Value type 기본값이 `json`이었다. | JSON 해석 전환의 새 기본 Value type은 `numeric`이다. 사용자는 계속 string/json/array로 직접 바꿀 수 있고, 이미 저장된 Job의 값은 바꾸지 않는다. | JSON에서 선택하는 값은 기본적으로 숫자 Tag에 저장하는 목적이므로 Numeric이 더 알맞다. 영향 범위는 Job 출력 선택 화면과 임시 출력 선택·FE/BE 설계 문서다. | 승인됨 — 2026-08-06 사용자 “변경” |
| CCR-044 | Method Call 카드 안에 Output Mapping의 모든 입력과 Tag 편집기를 계속 펼쳐 여러 Call·여러 Output Job에서 화면이 길고 복잡해졌다. | 카드는 Tag가 아닌 Output 단위 행 목록을 표시한다. `Add Output`은 새 Output 하나를 설정하는 모달을 열고, 목록 행의 Output 이름 또는 Edit는 해당 Output 하나를 수정하는 모달을 연다. 삭제는 목록에서 한다. `outputSelections`의 API·저장 형식·검증·실행 규칙은 바꾸지 않는다. | Node Mapping의 목록 중심 흐름처럼 Call의 실행 순서와 Output 구성을 먼저 비교하고, 복잡한 설정은 한 Output씩 필요할 때만 열 수 있게 한다. 영향 범위는 Job Form 화면뿐이다. | 승인됨 — 2026-08-07 사용자 “add를 누르면 모달… 아웃풋 단위로 리스트에 표시 후 수정 가능하게” |
| CCR-045 | 단일값도 `Generate Tags` 버튼을 보여 Tag 하나를 다시 만드는 모달을 열었고, array 생성 기능의 의미가 약했다. | `Generate from Array`는 array 출력의 Tag 목록 헤더 오른쪽에만 보인다. 단일값은 Tag 이름 하나만 직접 수정한다. 생성 모달의 Prefix·Count 규칙과 Tag 저장 형식은 바꾸지 않는다. | 여러 array 원소에 맞춰 Tag를 만드는 기능임을 버튼 위치와 이름으로 분명히 한다. 영향 범위는 Output Mapping 모달과 관련 화면 문서다. | 승인됨 — 2026-08-07 사용자 “array일때만… 버튼 위치도…”, “진행” |
| CCR-046 | Job form은 등록 DB Server를 고르는 것과 DB Server 관리 화면이 분리되어 있었고, 없는 Table은 먼저 별도 API로 만들어야 했다. | `Registered Server` 옆 `+`는 기존 Database Servers 관리 모달을 연다. Table은 직접 입력 또는 발견 목록 선택 콤보 박스이며, 목록에 없는 이름은 `Table not found. It will be created automatically when the job is saved.`를 표시한다. Job POST와 정지된 Job PUT은 Job mutation lock 안에서 없는 TAG Table을 `valueColumn`과 선택 `stringValueColumn`으로 만들고 metadata를 다시 검증한 뒤 저장한다. Table 생성 실패 시 Job config와 service는 바꾸지 않는다. `/job/validate`와 runtime Start는 Table을 만들지 않는다. | 서버와 테이블을 따로 관리하되, 새 수집 Job을 만들기 위해 화면을 오갈 필요를 없앤다. 생성 중 실패해도 반쯤 저장된 Job이 남지 않는다. | 승인됨 — 2026-08-07 사용자 “그리고 설계 승인” |
| CCR-047 | 직접 입력한 새 Table도 사용자가 임의의 `valueColumn`과 `stringValueColumn`을 골라 생성할 수 있었고, 기존 Table의 column 선택과 새 Table의 고정 생성 규칙이 섞여 있었다. | DB Server를 고르기 전에는 Table과 두 Column control을 비활성화한다. 기존 Table을 고르면 `GET /db/table/columns` 결과의 호환 Column만 선택한다. 목록에 없는 Table 이름은 새 TAG Table로 보고 두 Column control을 비활성화하며, Job POST/정지된 PUT은 요청값과 무관하게 `VALUE`(numeric), `STR_VALUE`(string) 고정 Column으로 생성·저장한다. | 새 Table의 schema를 하나로 고정해 수집 worker와 저장 config가 다른 Column을 가리키는 일을 막고, 기존 Table에서만 실제 metadata에 맞춘 선택을 허용한다. Backend 단위 테스트로 임의 Column 요청도 고정 Column으로 바뀌는 것을 확인했다. | 승인됨 — 2026-08-07 사용자 “새 테이블은 고정 기본 컬럼으로 자동 생성하고 저장하는게 맞아” |
| CCR-048 | 직접 입력한 `qqq`는 Neo에서 `QQQ`로 생성되지만 Job config에는 소문자가 남아, 생성 직후 metadata 검증이 다른 이름을 조회했다. | Job의 `database.table`은 항상 대문자 SQL 식별자로 정규화한다. FE는 입력·목록 선택 즉시 대문자로 바꾸고, Backend는 POST·PUT 및 직접 API 요청에서도 저장 전 다시 대문자로 바꾼다. | 화면, 자동 생성, metadata 검증, 저장 document가 같은 Table 이름을 사용하게 한다. | 승인됨 — 2026-08-07 사용자 “통일” |
| CCR-049 | 공통 문서가 `--with-ls-interface` 빌드 옵션과 특정 LS Interface/Method를 공통 배포 방식으로 정했다. Settings와 build 고정값의 저장 경계도 분명하지 않았다. | generic build는 `provider:null`이다. Provider build는 `cgi-bin/provider.json`의 검증된 읽기 전용 Profile을 `GET /settings.data.provider`로 제공한다. Profile은 Settings에 저장하지 않으며 `jobMode:"fixed"`는 표시와 새 Job 초기값만 바꾼다. 별도로 승인된 제한이 없으면 공통 CRUD API는 그대로 유지한다. | 공통 제품과 Provider 배포판을 같은 코드에서 분리하고, 사용자 Settings에 build 정체성·비밀·Job/Tag 이름이 섞이지 않게 한다. 세부 schema는 `providers/DBUS_PROVIDER_PROFILE.md`와 Backend/CGI 테스트로 확인한다. | 승인됨 — 2026-08-11 공통/Provider branch topology 작업 지시 |
| CCR-053 | generic과 LS를 별도 브랜치·이름·version의 package로 관리하거나, 한 저장소에서도 `dist` 아래에 서로 다른 package로 동시에 만드는 방식을 검토했다. | 하나의 개발 브랜치, package 이름 `neo-pkg-dbus`, 루트 version과 설치 위치를 사용한다. 실제 차이만 `products/generic`, `products/ls`의 고정 모듈과 LS asset으로 분리한다. `npm run build`와 `--target=generic`은 같은 generic 완성 package를 루트에 만들고, `--target=ls`는 같은 루트를 LS 완성 package로 바꾼다. build는 생성 HTML과 `cgi-bin/product`, Provider asset만 교체하고 원본 source와 사용자 설정은 건드리지 않는다. Git에 커밋하는 완성 산출물은 항상 인자 없는 기본 generic build 결과여야 하며 업체 전용 build 산출물은 금지한다. `product.json`, 제품별 build script, `build:all`, 자동 플러그인 검색은 만들지 않는다. 이 항목은 CCR-010·CCR-017의 옛 build 명령과 CCR-049의 브랜치 topology 부분을 대체하되 Provider Profile의 저장 경계는 유지한다. | 실제 배포는 generic과 LS를 동시에 설치하지 않고 같은 package 중 하나를 선택한다. 공통 수정을 한 번만 관리하면서도 배포 전 완성 build를 제공하고, 업체 산출물이 실수로 기본 Git package에 섞이는 일을 막는다. 상세 구조는 `docs/superpowers/specs/2026-08-12-unified-product-modules-design.md`를 따른다. | 승인됨 — 2026-08-12 사용자 “오버엔지니어링을 금지”, “승인”, “사실상 같은 이름으로 빌드”, “기본 빌드는 generic”, “다른 회사 버전이 올라가면 안돼” |
| CCR-054 | LS Job의 `DeviceString` 입력과 Tag 생성이 모두 사용자가 `%MB3`처럼 `%`까지 직접 입력한다고 가정했다. Interface 검증은 `%3`도 허용해 실제 Tag 생성 규칙과 달랐다. | LS 새 Job 화면은 수정할 수 없는 `%` 접두사와 주소 본문 입력을 나눠 표시한다. 사용자는 `MB3`만 입력하지만 Job 저장값, Test Call과 수집 DBus 호출값은 `%MB3`이다. 실제 Interface 입력은 `%`로 시작하고 숫자로 끝나며 그 사이에 문자가 하나 이상 있어야 한다. 주소 본문에 `%`를 다시 넣지 않는다. `%MB3`, `%AREA.X09`는 허용하고 `%3`, `MB3`, `%MB`, `%%MB3`는 거부한다. Tag 이름에서는 정규형의 첫 `%`만 제외하며 기존 자동 재계산·수동 이름 보존 규칙은 유지한다. generic 동작은 바꾸지 않는다. | 사용자가 DBus 전송 문법의 `%`를 반복 입력하지 않게 하면서 저장값과 실제 호출값은 장비가 요구하는 완성 문법 하나로 유지한다. Interface 검증과 Tag 생성기가 같은 주소를 유효하다고 판단하게 한다. | 승인됨 — 2026-08-12 사용자 “실제 인터페이스 호출할땐… %와 숫자 사이에 문자가”, “%를 사용자가 입력 안하고 기본적으로 %가 존재”, “승인” |
| CCR-055 | Database Server 저장이 없는 Default Table을 즉시 만들었고, Job 저장은 없는 Table을 출력 형식과 관계없이 항상 `VALUE`와 `STR_VALUE`로 만들었다. 기존 Table은 Job 저장 때 Column metadata를 다시 검증했으며 String Value Column 없이 문자열 계열 출력을 실행하면 `DB_APPEND_FAILED`였다. | 기본 `localhost`의 Default Table 이름은 `DEFAULT_DBUS`이고 실제 Table은 만들지 않으며 두 기본 Column은 빈 값이다. Database Server Create·Update는 Default Table을 생성하거나 metadata를 검증하지 않는다. 기존 Table에서만 발견된 Column을 선택할 수 있고 없는 Table에서는 두 Column control을 비활성화한다. Job POST와 정지된 PUT은 Table 존재 여부를 항상 조회한다. 기존 Table은 선택 mapping의 SQL 식별자 형식만 검증해 그대로 저장하고 metadata·자료형을 재검증하거나 schema를 변경하지 않는다. 없는 Table은 최종 Output Mapping의 실제 저장 자료형을 사용한다. native DBus 숫자형, `valueType:numeric`, `elementType:numeric`만 숫자이며 나머지 string/json 계열 저장이 있으면 `VALUE`와 `STR_VALUE`, 없으면 `VALUE`만 포함한 TAG Table로 만들고 config를 같은 이름으로 정규화한다. String Value Column이 없는 runtime은 문자열 계열 행만 버리고 숫자 행은 계속 저장하며 실패로 보지 않는다. 이 결정은 CCR-046·CCR-047의 Table 생성·재검증 부분과 기존 Default Database 저장 시 생성 규칙을 대체한다. | 실제 schema가 필요한 시점은 Job 저장이며, 그때만 Output Mapping으로 String Column 필요 여부를 알 수 있다. 서버 설정 저장의 부수 효과를 없애고 숫자 전용 Table을 단순하게 유지한다. 기존 Table은 사용자 소유 schema이므로 자동 검증·변경하지 않으며, 선택 String Column이 없다는 것은 문자열 값을 저장하지 않겠다는 뜻으로 처리한다. 상세 설계는 `docs/superpowers/specs/2026-08-12-job-time-default-table-creation-design.md`를 따른다. | 승인됨 — 2026-08-12 사용자 “1번 방식으로 진행”, “string value column이 없을때만” |
| CCR-056 | 새 Job 화면의 Job Name은 빈 값이었고 Job Configuration 여섯 필드가 항상 펼쳐져 Method Call보다 먼저 긴 영역을 차지했다. | FE는 현재 화면이 이미 읽은 Job 목록에서 정확히 `job-N`인 이름의 가장 큰 양의 정수 `N`을 찾아 새 Job 이름을 `job-(N+1)`로 한 번 제안한다. 대상이 없으면 `job-1`이며 별도 API나 last counter는 저장하지 않는다. New/Edit의 Job Configuration은 기본 접힘이다. 접힌 summary는 현재 Job Name, Run Interval, Save Policy를 읽기 전용 텍스트로 표시하고, 펼치면 기존 입력을 그대로 수정할 수 있다. Edit Job Name은 계속 변경 불가이고 접힘 상태는 API·저장 형식을 바꾸지 않는다. | 추가 저장소나 중복 목록 요청 없이 새 Job 작성 단계를 줄이고, 자주 바꾸지 않는 실행 설정이 Method Call 화면을 밀어내지 않게 한다. 동시 생성 충돌은 기존 `JOB_ALREADY_EXISTS`가 최종 차단한다. 상세 설계는 `docs/superpowers/specs/2026-08-12-job-name-and-collapsible-configuration-design.md`를 따른다. | 승인됨 — 2026-08-12 사용자 “job-1로 가자”, “오케이 그렇게 진행”, “Job configuration 자체는 database처럼 접힌게 기본” |
| CCR-057 | New/Edit Job의 Database 섹션은 기본 접힘이지만 접힌 상태에는 제목만 보여 현재 Database Server와 Table을 확인할 수 없었다. | 접힌 제목 행에 현재 `Database Server / Table` 값을 레이블 없는 읽기 전용 텍스트로 표시한다. 비어 있는 값은 `—`로 표시하고, 펼치면 기존 Server, Table, Value Column, String Value Column control을 그대로 제공한다. 펼친 상태에서 Server 또는 Table을 바꾸면 다시 접었을 때 현재 draft가 즉시 반영된다. 접힘 상태와 요약은 API·Job schema·저장 payload를 바꾸지 않는다. | 자주 확인하는 저장 대상을 섹션을 펼치지 않고 볼 수 있게 하면서 기존 Database 편집과 저장 계약을 유지한다. 상세 설계는 `docs/superpowers/specs/2026-08-12-database-collapsed-summary-design.md`를 따른다. | 승인됨 — 2026-08-12 사용자 “database server와 table이 read only로 볼 수 있도록”, “값만 표시”, “진행” |
| CCR-058 | CCR-056·057은 Job Configuration과 Database를 화면 안에서 접고 펼쳐 같은 카드가 요약과 편집 폼을 번갈아 표시했다. 펼치면 요약 정보가 사라지고 Method Call의 위치도 아래로 밀렸다. | New/Edit Job에서 두 영역은 항상 레이블이 있는 읽기 전용 요약 카드로 표시한다. Job Configuration은 Job Name·Run Interval·Save Policy를, Database는 Database Server·Table을 보여 주며 연필 버튼으로 각각의 편집 모달을 연다. 모달은 기존 control을 그대로 제공하고 별도 draft를 사용한다. `Apply`만 상위 Job draft에 반영하고 `Cancel`, 닫기, 바깥 영역 클릭, Esc는 변경을 버린다. Edit Job Name 변경 금지, Database 후보 조회·자동 생성 안내, API·Job schema·저장 payload는 바꾸지 않는다. | 자주 확인하는 값을 항상 같은 위치에서 읽고, 긴 설정 폼이 Method Call의 위치를 바꾸지 않게 하며, 적용 전 변경을 안전하게 취소할 수 있게 한다. 상세 설계는 기존 두 설계 문서의 2026-08-13 대체 기록을 따른다. | 승인됨 — 2026-08-13 사용자가 Product Design 3번 시안(요약 카드 + 편집 모달)을 선택하고 “3번 디자인이 제일 알맞다”라고 확정 |
| CCR-059 | LS 새 Job은 고정 `GetDeviceData` Method Call 하나만 만들고 Method Call 추가·삭제를 숨겼다. 여러 PLC 주소를 한 Job에서 수집할 수 없었다. | LS Job은 같은 고정 `ls-plc-device/get-device-data` Call을 하나 이상 가진다. `Add Call`은 고정 기본 Call을 깊은 복사해 배열 끝에 추가하고, 배열 순서대로 실행한다. 각 Call은 독립적인 `DeviceString`, `DataCount`, 자동·수동 Tag와 Transform을 가진다. 화면은 목록과 선택 상세를 나눈 master-detail 구조이며 Method 식별자를 표시한다. 선택 상세의 두 입력은 같은 너비이고 접힌 Tags 영역은 입력 행과 같은 좌우 경계를 가진다. Interface, Method, Output 해석은 계속 고정이며 마지막 Call은 삭제할 수 없다. generic 제품은 바꾸지 않는다. | LS 고정 규칙을 유지하면서도 여러 주소를 한 Job에 구성하고, Call과 Tag가 많아져도 긴 카드 반복 없이 현재 편집 대상을 분명히 보여 주기 위함이다. 상세 설계는 `docs/superpowers/specs/2026-08-13-ls-multiple-method-calls-design.md`를 따른다. | 승인됨 — 2026-08-13 사용자가 Product Design master-detail 시안과 margin 수정안을 확인하고 “확정” |
| CCR-060 | LS `DeviceString`은 고정 `%` 접두사 뒤 주소 본문을 키보드로만 입력했다. | 새 LS Call의 DeviceString 기본값은 `%MB0`이다. 바깥 DeviceString은 현재 주소를 읽기 전용으로 표시하며, 읽기 전용 입력 본문이나 오른쪽 화살표를 누르면 LS 전용 주소 선택기를 연다. Memory Area 후보는 `A/F/I/Q/M/K/R/W`, Data Type 후보는 `X/B/W/D/L`로 고정한다. Address는 기본값 `0`, DataCount는 최소값 `1`이며 둘 다 브라우저 기본 spinner 대신 공통 위·아래 아이콘 control을 사용한다. 아래 완성 주소 입력에서는 `%MW10` 같은 정규형을 직접 입력하고 Apply 때 반영한다. Memory Area와 Data Type은 남은 너비를 같은 비율로 차지하고 Address는 고정 너비다. 두 후보 목록은 동시에 열리지 않는다. 팝오버 너비는 DeviceString 입력과 같고 절대 배치되어 Method Calls와 Tags 높이를 바꾸지 않는다. DeviceString과 DataCount는 기존의 같은 너비를 유지한다. Method Call 목록 hover는 전체 행에 적용하고 Add Call·Test Call은 공통 button을 사용한다. 저장·Test Call·수집 값은 계속 `%`를 포함하며 generic 제품에는 선택기를 제공하지 않는다. | 표시와 편집 위치를 분리해 현재 적용값을 실수로 바꾸지 않으면서, 유효한 LS 주소 후보와 숫자 범위를 일관된 control로 입력하게 한다. API와 Backend 저장 형식은 바뀌지 않는다. | 승인됨 — 2026-08-13 사용자가 검색 가능한 단일 팝오버 시안과 정확한 너비·배치 조건을 확정한 뒤 “오케이 그럼 구현에서 고정해”, 이어 바깥 읽기 전용·아래 직접 입력·Address 숫자 화살표와 LS 후보·공통 button·전체 행 hover를 지정하고, 초기 `MB0` 표시와 입력 본문 클릭 열기를 추가 지정함 |

| CCR-061 | LS Method Call을 추가할수록 왼쪽 Call 목록과 전체 카드 높이가 계속 늘어났고, Tag Transform의 Bias·Multiplier는 Address·DataCount와 다른 브라우저 기본 숫자 화살표를 사용했다. | Call 목록은 행 8개 높이를 최대로 사용하고 9번째부터 목록 내부에서 세로 스크롤한다. 새 Call을 추가하거나 Call을 선택하면 선택 행이 목록의 보이는 범위로 이동한다. 오른쪽 상세 높이는 Call 개수 때문에 늘어나지 않는다. Bias·Multiplier는 Address·DataCount와 같은 공통 위·아래 화살표 control을 사용하며 Bias의 음수와 기존 Transform 계산 범위는 유지한다. | 많은 Call에서도 편집 카드의 위치와 크기를 안정적으로 유지하고, 모든 숫자 입력의 조작 방식과 모양을 통일하기 위함이다. | 승인됨 — 2026-08-13 사용자 “메소드콜이 여러개 추가되면… 높이 제한”, “트랜스폼의 화살표도 동일하게 변경”, “콜 목록은 최대 8개로하고 승인” |
| CCR-062 | LS Test Call 결과가 Method Calls와 떨어진 Job form 맨 아래의 독립 카드에 표시되어 어떤 Call의 결과인지 화면 위치로 알기 어려웠고 사용자가 결과를 지울 수 없었다. | LS 제품은 가장 최근 Test Call 결과 하나에 실행한 Call ID를 함께 보관한다. 선택된 Call ID가 결과의 Call ID와 같을 때만 해당 Call 상세의 Tags 아래에 결과를 표시한다. 다른 Call을 선택하면 숨기고 원래 Call로 돌아오면 다시 표시하며, 다른 Call을 실행하면 직전 결과를 교체한다. `Clear`는 화면의 Test Call 결과만 지우고 Job draft와 저장값은 바꾸지 않는다. 성공과 실패 모두 Call ID를 가진다. generic 제품의 기존 결과 위치와 Backend API·응답·저장 형식은 바꾸지 않는다. | 결과의 소유 Call을 분명히 하고 오래된 진단 결과를 사용자가 즉시 정리할 수 있게 하면서 제품 공통 계약과 저장 형식에는 영향을 주지 않기 위함이다. | 승인됨 — 2026-08-13 사용자 “테스트콜을 메소드콜 내부로 이동 및 클리어 기능 추가”, 이어 제안된 선택 Call 표시·교체·Clear 동작에 “진행” |
| CCR-063 | CCR-061은 왼쪽 LS Call 목록 높이를 8행으로 고정했다. Test Call 결과처럼 오른쪽 선택 Call 상세가 더 길어져도 실제 목록은 8행까지만 사용해 두 영역의 사용 가능한 높이가 달랐다. | 데스크톱 master-detail에서 왼쪽 목록 외곽과 내부 스크롤 영역은 오른쪽 선택 Call 상세의 실제 높이를 그대로 따른다. Call 행 전체가 이 높이를 넘을 때만 왼쪽 내부 세로 스크롤을 사용한다. Test Call 실행·Clear 등으로 오른쪽 높이가 바뀌면 별도 저장 상태나 JavaScript 높이 계산 없이 함께 바뀐다. 이 규칙은 CCR-061의 고정 8행 제한을 대체하며 Call 순서·선택 자동 이동·API·저장 형식은 바꾸지 않는다. | 같은 카드의 좌우 영역이 같은 세로 공간을 사용하게 하고, 오른쪽에 여유가 있는데 왼쪽 목록만 일찍 잘리는 문제를 없애기 위함이다. | 승인됨 — 2026-08-13 사용자 “좌측 리스트의 최대 길이는 우측 내용으로 고정하자 최대 8개 높이인게 아니라”, 제안된 우측 상세 높이 기준·초과 시 내부 스크롤 설계에 “진행” |
| CCR-064 | Test Call 화면은 `Call result`와 접힌 `Raw body (diagnostic only)`를 함께 표시했다. 현재 Test Call 응답은 `values`와 `body`에 같은 반환 인자 목록을 넣어 두 영역이 같은 내용을 반복했다. | LS와 generic Test Call 화면에서 `Raw body` 진단 영역을 제거하고 성공 여부, 소요 시간, 값 개수와 `Call result`만 표시한다. Backend 응답의 `body` 필드와 호출·저장 동작은 호환성을 위해 바꾸지 않는다. | 사용자에게 같은 JSON을 두 번 보여 주는 중복을 없애기 위함이다. 확인 근거는 `cgi-bin/src/dbus/test-call.js`가 성공 응답의 `values`와 `body`에 모두 `response.body`를 넣는 현재 구현이다. | 승인됨 — 2026-08-13 사용자 “둘 다 동일해보이는데” 확인 후 “제거” |
| CCR-065 | CCR-060 주소 선택기는 Memory Area와 Data Type만 남는 너비를 나눠 쓰고 Address는 72px 고정 너비였다. 또한 앞의 두 선택기는 입력과 화살표가 테두리를 나눠 가져 입력에 포커스하면 active border가 화살표까지 이어지지 않았다. | Memory Area, Data Type, Address를 같은 너비의 3열로 배치한다. Memory Area와 Data Type은 입력과 화살표를 하나의 바깥 control로 묶고, 어느 자식에 포커스가 있어도 control 전체에 하나의 active border를 표시한다. 후보·주소값·API·저장 형식은 바꾸지 않는다. 이 너비 규칙은 CCR-060의 Address 고정 너비 규칙을 대체한다. | 세 입력의 시각적 비중을 맞추고 선택 control이 하나의 조작 영역으로 보이게 하기 위함이다. | 승인됨 — 2026-08-13 사용자가 브라우저에서 “memory area, data type, address 입력폼들 같은 너비로”, “active border가 화살표쪽까지 같이 되지 않음”을 지정함 |
| CCR-066 | LS DeviceString 주소 선택기의 `Apply`가 링크 모양이라 주소를 최종 반영하는 주요 동작으로 보이지 않았다. | `Apply`는 공통 Primary 버튼 스타일을 사용한다. 오른쪽 정렬, 유효하지 않은 주소에서의 비활성화, 주소 반영 동작은 유지한다. | 제품의 다른 적용·저장 동작과 같은 시각 규칙을 사용해 최종 반영 동작을 분명하게 하기 위함이다. | 승인됨 — 2026-08-13 사용자 “apply 버튼 기존 디자인 시스템 버튼 사용하도록 변경” |
| CCR-067 | Database Server의 Default Table이 아직 없을 때 Job 저장이 고정 `VALUE`/선택 `STR_VALUE` Column으로 Table을 만들었지만, 서버의 기본 Column 설정은 계속 빈 값이라 다음 새 Job이 같은 Default Table의 Column을 이어받지 못했다. | Job POST 또는 정지된 PUT이 없는 Table을 실제로 만들었고 그 이름이 해당 서버의 `defaultTable`과 같으면, Table 생성 성공 직후 서버 기본 `valueColumn`을 `VALUE`로 저장한다. 문자열 계열 출력이 있어 `STR_VALUE`도 만든 경우 기본 `stringValueColumn`도 `STR_VALUE`로 저장하고, 없으면 빈 문자열로 저장한다. 연결 정보와 비밀번호는 그대로 보존한다. Job이 서버의 Default Table이 아닌 다른 Table을 만들거나, 기존 Table을 사용하거나, 생성 경쟁에서 `TABLE_ALREADY_EXISTS`를 받은 경우 서버 기본값은 바꾸지 않는다. | 자동 생성된 Default Table의 실제 고정 schema와 다음 새 Job의 기본 Database mapping을 일치시키기 위함이다. | 승인됨 — 2026-08-13 사용자 “없는 테이블이면 생성… 생성되는 경우 default value column도 제대로 지정” |
| CCR-068 | LS Method Call의 Tag 이름과 Transform은 화면에서 한 행씩만 수정할 수 있었다. | 선택된 LS Method Call의 Tags 헤더에 `Import CSV`를 제공한다. CSV 헤더는 정확히 `name,bias,multiplier,order`이며 `name`은 필수다. 빈 `bias`, `multiplier`, `order`는 각각 `0`, `1`, `0`으로 해석한다. `order=0`은 `(value + bias) * multiplier`, `order=1`은 `(value * multiplier) + bias`다. 파일 선택 즉시 첫 데이터 행부터 현재 Tag 첫 행에 치환하며 미리보기는 없다. CSV 행이 Tag/DataCount보다 적으면 뒤 Tag는 유지하고, 많으면 DataCount까지만 적용하고 초과 행은 검증하지 않고 무시한다. 적용 대상의 빈 이름, 유한하지 않은 숫자, `0|1`이 아닌 order 또는 CSV 구조 오류가 하나라도 있으면 전체 import를 취소하고 오류를 표시한다. 적용된 이름은 수동 이름으로 표시해 이후 DeviceString/DataCount 변경 때 같은 위치에서 보존한다. Import는 Tag 수와 DataCount를 바꾸지 않는다. Generic 제품, Backend API와 Job 저장 형식은 바꾸지 않는다. | DataCount로 이미 정해진 Tag 배열을 외부 설정표에서 빠르게 덮어쓰되, 부분 실패로 어느 행까지 바뀌었는지 불분명해지거나 CSV가 Tag 수를 몰래 늘리는 일을 막기 위함이다. | 승인됨 — 2026-08-14 사용자가 CSV 열·기본값·order 의미, 초과 행 무시, 부족 행 유지, 미리보기 없는 즉시 반영과 오류 시 전체 취소를 순서대로 확정한 뒤 “승인” |
| CCR-069 | Job 상세는 Config·Execution·Controller·Interval·Method Calls·Database를 같은 크기의 6개 지표로 따로 표시했고, 마지막 cycle의 시작·종료 시각만 보여 주었다. 실행 중에도 상세를 다시 읽지 않아 화면의 마지막 결과가 오래된 값으로 남았으며 `Stored`가 누적인지 이번 실행의 행 수인지 불분명했다. | 상단은 `JOB`, `METHOD CALLS`, `DATABASE` 세 의미 카드로 합친다. `CONFIG` 표시는 제거하고 Job 카드에는 실행/Controller 상태, Interval, Save Policy를 표시한다. Method Calls 카드는 Call 수를 강조하고 Database 카드는 Server·Table·Value Column·String Column을 표시한다. 실행 결과는 `LATEST RUN`으로 표시하며 `Latest Status`, `Last Successful`, `Last Stored`와 Method별 `Rows saved`, 오류를 보여 준다. `Rows saved`는 마지막 cycle의 해당 Method가 실제 append한 행 수다. 실행 중 Job 상세는 5초마다 다시 읽고 화면을 벗어나거나 정지하면 polling을 끝낸다. Backend lastRun 저장·API 구조는 바꾸지 않는다. | 설정 설치 여부보다 운영자가 필요한 현재 실행 상태·수집 규모·저장 위치·마지막 성공/저장 시각을 한눈에 확인하고, 오래된 실행 결과를 최신 정보로 오해하지 않게 하기 위함이다. | 승인됨 — 2026-08-14 사용자 “config도 제외”, “합칠 수 있는 정보들은 합쳐서 하나의 카드”, 제공한 3카드 참고 이미지 |
| CCR-070 | Job 상세 상단에는 저장 로그를 여는 `Logs` 버튼만 있었고, 현재 log level·file limit을 확인하거나 상세 화면 안에서 최근 로그를 멈춰 읽을 수 없었다. `/log/tail`의 응답도 `{name,file,content}`로 문서화되어 저장 로그 본문과 혼동될 수 있었다. | 상단 `Logs`는 `Live Logs`로 대체하고 저장 로그는 `LATEST RUN` 아래 `Logging Controls`의 `View Logs`에서 연다. 버튼 순서는 `Live Logs`, `Data Viewer`, `Edit`, `Delete`다. Logging Controls는 현재 level, 실제 기록 level, `config.log.maxFiles`를 표시한다. Live Logs는 active 파일을 `GET /log/list`로 찾고, 기존 JSON `GET /log/tail`을 1초 polling하여 최대 100줄만 보여 준다. `Pause/Resume`, `Clear`, `Close`, drag, resize, viewport clamp와 오류 뒤 자동 복구를 제공하며 SSE를 추가하지 않는다. `/log/tail` 공개 응답은 `{name,file,lines,totalLines}`이다. 페이지형 `/log/content`는 `{name,file,page,linesPerPage,totalLines,lines,nextPage,previousPage}`이고, 전체 본문 `/log/content/all`만 `{name,file,size,content}`를 사용한다. | 새 장기 연결 API 없이 Neo CGI에서 검증된 list/tail 요청·응답을 재사용하면서, 운영자가 상세 화면을 떠나지 않고 로그 설정과 최근 로그를 확인하게 하기 위함이다. 승인 설계 `docs/superpowers/specs/2026-08-14-job-logging-controls-live-logs-design.md`와 현재 `cgi-bin/api/log/tail.js` 및 `cgi-bin/src/log/reader.js`의 `lines`, `totalLines` 응답을 확인했다. | 승인됨 — 2026-08-14 사용자가 권장안인 기존 JSON tail polling 방식으로 진행 승인 |
| CCR-071 | 패키지 매니페스트와 계약 문서는 최소 Neo 버전을 `8.5.6`으로 안내했다. | generic과 LS가 공유하는 최소 Neo 지원 버전을 `8.5.8`로 올린다. 루트·CGI 매니페스트, 새 Profile 기본값과 built-in LS Profile, README, 사용자 매뉴얼, FE·BE·LS 설계 및 출시 검증 기준을 모두 같은 값으로 유지한다. `8.5.8` 미만은 지원 범위 밖이다. | 실제 납품 기준의 최소 지원 버전이 `8.5.8`임을 바로잡고, 매니페스트·화면 기본값·문서가 서로 다른 버전을 안내하지 않게 하기 위함이다. 과거 `8.5.6` JSH 조사 기록은 당시 확인 사실이므로 보존하되 현재 출시 gate로 사용하지 않는다. | 승인됨 — 2026-08-14 사용자 “최소버전 8.5.8 이였어”, 이어 “변경” |

CCR-060의 초기값 계약에 따라 새 LS Call을 만들 때는 `%MB0`과 DataCount `1`만
저장하지 않고, 같은 자동 생성 규칙으로 Tag `MB0` 한 개도 즉시 만든다.

### 1.2 JSH 호환성 검토와 수정 설계

이 절은 공개 API나 시간 모델을 바꾸는 계약이 아니라, 최소 Neo 지원 약속을 지키기 위한 구현 검토 기록이다. 아래 수정은 JSH 통합 검증이 끝나기 전까지 완료로 선언하지 않는다.

- Neo `8.5.6`부터 확인한 `8.5.9`까지의 JSH에서 전역 `process`와 `Intl`, `fs.utimesSync`, `stat.mtimeMs`가 없었다. `require('process')`, `stat.mtime.unixMilli()`는 사용할 수 있었다.
- `6e8ec9d`의 Job operation lock은 전역 `process`, `fs.utimesSync`, `stat.mtimeMs`를 사용해 최소 JSH에서 실행 오류가 날 수 있다. 이것은 계약 변경이 아니라 수정해야 할 호환성 버그다.
- 수정 설계: 모든 process 접근은 `require('process')`로 통일한다. PID 확인 함수가 `false`를 반환하거나 반환·예외의 `code`가 `ESRCH`일 때만 종료로 보고 stale lock을 회수한다. `EPERM`과 알 수 없는 오류는 생존 여부를 확정할 수 없으므로 `JOB_CONFLICT`로 보호한다. 정상 Job lock은 owner JSON과 owner token별 heartbeat 파일로 만료를 판단해, 이전 owner가 새 owner의 lease를 갱신하지 못하게 한다. crash로 owner 문서가 완성되지 않은 경우에만 JSH의 `stat.mtime.unixMilli()`를 fallback으로 쓴다. 따라서 `utimesSync`와 `mtimeMs` 의존성을 제거한다.
- 검증: Node 단위 테스트와 최소 Neo 8.5.8 JSH smoke test에서 전역 `process`, `Intl`, `fs.utimesSync`, `mtimeMs` 없이 lock 획득·heartbeat·stale reclaim을 확인한다.
- JSH 통합 검증 전 상태는 계속 “실제 Neo/설비 통합 미검증”으로 표시한다.

## 2. 공통 모델

### 2.1 Settings

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

위 JSON만 `cgi-bin/conf.d/settings.json`에 저장한다. Database Server 기본값은
Provider와 독립이며 모든 build에서 같다.

### 2.2 Provider Profile

선택 build 파일 `cgi-bin/provider.json`은 Settings가 아니라 읽기 전용 Provider
Profile이다. 파일이 없으면 generic mode이며 `GET /settings`는 Settings에
`provider:null`을 더해 반환한다. 파일이 있으면
[DBUS_PROVIDER_PROFILE.md](providers/DBUS_PROVIDER_PROFILE.md)의 검증된 객체를
`provider`로 반환한다. `PUT /settings`에 `provider` key를 보내면 HTTP 400
`SETTINGS_INVALID`이고, 파일이 잘못되면 HTTP 400
`PROVIDER_PROFILE_INVALID`이다. 어떤 경우에도 Profile을 `settings.json`에 쓰지
않는다.

`jobMode:"fixed"`는 Provider 화면의 표시/default 동작일 뿐 공통 DBus
Interface/Method/Job CRUD API를 제한하지 않는다. generic build는 기존 관리 화면을
그대로 제공한다. 패키지 이름과 `cgi-bin/package.json.version`이 Provider 배포판의
버전 기준이며, Database Server 기본값은 Provider와 독립이다.

### 2.3 DBus Interface와 Method

DBus Interface는 `schemaVersion`, `id`, `name`, `origin`, `builtIn`, `busType`, `destination`, `objectPath`, `interface`, `methods`를 가진다. `origin`은 Discover로 만든 `discovered` 또는 Direct input으로 만든 `manual`이다. 출력 선택·해석·저장 규칙의 임시 단일 기준은 `DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`다. 특정 Provider Method의 반환 수, JSON 필드, Tag 수를 공통 코드가 미리 추측하지 않는다. generic build는 빈 Interface 목록을 정상 처리하며 기존 Interface/Method 관리 기능을 제공한다.

DBus Method는 부모 Interface 안에 저장하며 `id`, `source`, `member`, `inputs`, `outputs`를 가진다. `source`는 Introspection으로 찾은 `discovered` 또는 사용자가 넣은 `manual`이다. Parameter의 Type 표현, signature 해석·재생성, 값 구조와 지원 범위의 유일한 기준은 [DBUS_TYPE_SYSTEM.md](DBUS_TYPE_SYSTEM.md)다. 사용자는 Bus Type, Destination, Object Path를 넣고 Discover를 실행한다. Backend는 Neo DBus module의 `Connection.introspect()`로 `org.freedesktop.DBus.Introspectable`의 구조화 결과를 받고 모든 Interface, Method, 입력·출력 파라미터를 읽는다. `org.freedesktop.*`는 숨기지 않고 선택 목록에서 `Standard`로 표시한다. Discover 결과는 저장하지 않는다. 선택 목록은 실제 발견 Interface 뒤 마지막 항목으로 `Direct input`을 제공한다. Discover가 성공하면 화면은 정렬된 첫 Interface를 선택하되, 사용자가 이미 고른 결과가 계속 있으면 그 선택을 유지한다. 참조 Job이 없는 discovered Interface의 Edit는 모달을 열 때 Discover를 자동 호출하고 저장된 Interface와 같은 결과를 선택한다. manual Interface는 자동 Discover 뒤에도 `Direct input`과 기존 수동 값을 유지한다. 사용자가 실제 Interface를 고르면 화면은 그 Interface와 Method 목록을 현재 편집 draft에 반영하고, 그 아래에 Method와 입력·출력을 읽기 전용으로 표시한다. `Direct input`을 고르면 Interface 이름을 직접 입력한다. 새 Interface의 ID는 이미 입력한 값이 있으면 유지하고 비어 있을 때만 발견 ID를 제안한다. 기존 Interface ID는 저장·Job 참조 키라 수정할 수 없다. footer의 단일 control은 새 Interface에서 `Create Interface`, 기존 Interface에서 `Update Interface`다. 새 Interface는 단일 object `POST /dbus-interface`, 기존 Interface 재-Discover는 단일 object `PUT /dbus-interface?discover=true`로 저장한다. `{interfaces:[...]}` 배열 wrapper, Save All, 카드별 저장은 없다. Introspection을 지원하지 않거나 권한이 없으면 사용자는 목록의 `Direct input`으로 Interface와 Method·모든 파라미터를 직접 입력한다.

CCR-032가 위 문단의 새 Interface ID 입력 규칙을 대체한다. Interface 문서는 내부 `id`와 사용자 관리 이름 `name`을 함께 가진다. 생성 때 `name`은 필수이고, POST body에는 `id`를 넣지 않는다. 서버는 생성 잠금 안에서 Name slug(불가능하면 DBus Interface 이름 slug)에 숫자 suffix를 붙여 겹치지 않는 내부 ID를 만든다. 목록·상세는 `name`을 표시하고, PUT·GET·DELETE 및 Job의 `interfaceId`는 기존 내부 ID를 쓴다.

Provider 배포판의 읽기 전용 Interface asset은 Provider Profile과 별도로 제공한다. Profile loader는 Interface/Method/Job 파일을 만들거나 고치지 않는다. 어떤 build도 사용자 데이터인 `cgi-bin/conf.d/interfaces`와 `cgi-bin/conf.d/jobs`를 바꾸지 않는다. Method API는 부모 Interface JSON 한 개를 완성한 임시 파일로 만든 뒤 원자 교체한다.

다시 Discover할 때는 `discovered` Method만 갱신한다. `manual` Method는 자동 수정·삭제하지 않는다. Built-in Interface/Method는 수정·삭제할 수 없다. 사용자 Interface를 Job이 하나라도 참조하면 이름 외 수정, Discover, Method 변경, 삭제를 모두 `DBUS_INTERFACE_IN_USE`로 거부한다. 참조가 없을 때만 manual Interface의 manual Method를 추가·수정·삭제할 수 있고, discovered Method는 계속 읽기 전용이다.

### 2.4 저장 Job document

```json
{
  "schemaVersion": 1,
  "name": "production-line",
  "revision": 1,
  "schedule": { "intervalMs": 1000 },
  "retry": { "initialDelayMs": 5000, "maximumDelayMs": 30000, "multiplier": 2 },
  "execution": { "savePolicy": "perMethod", "onMethodError": "stop" },
  "methodCalls": [
    {
      "id": "read-values-1",
      "name": "Read Values - Call 1",
      "interfaceId": "device-status",
      "methodId": "read-values",
      "inputs": { "channel": 1 },
      "outputSelections": [
        {
          "id": "result-1",
          "sourceIndex": 0,
          "tags": [
            {
              "name": "SENSOR_1",
              "bias": 0,
              "multiplier": 1
            }
          ]
        }
      ]
    }
  ],
  "database": { "server": "localhost", "table": "TAG", "valueColumn": "VALUE", "stringValueColumn": "STR_VALUE" },
  "log": { "level": "info", "maxFiles": 10 }
}
```

위 예시는 `conf.d/jobs/production-line.json`에 저장되는 document다. document top-level `name`은 파일명 `production-line`과 반드시 같아야 한다. `methodCalls`는 한 개 이상이다. 각 Call은 고정 ID, 표시 이름, `interfaceId`, `methodId`, raw inputs, `outputSelections`를 가진다. Tag는 `name`, `bias`, `multiplier`만 가진다. Tag 배열 순서가 값 연결 순서다. `sourceAddress`, `calcOrder`, `outputIndex`는 예전 Job을 읽을 때만 입력으로 허용하고 다음 저장에서 제거한다. Tag name은 TAG table의 `NAME VARCHAR(100)`에 맞춰 최대 100자다.

`database.valueColumn`은 숫자 저장에 사용하는 column이고 `database.stringValueColumn`은 선택 문자열 column이다. 문자열 column을 쓰지 않을 때는 `""`로 저장한다. `database.table`은 항상 대문자 SQL 식별자로 저장한다. 기본 `localhost`는 실제 Table을 미리 만들지 않고 `defaultTable: "DEFAULT_DBUS"`, 빈 기본 Column 두 개로 시작한다. Database Server 저장은 Default Table을 만들거나 metadata를 검증하지 않는다. Job POST 또는 정지된 Job PUT은 mutation lock 안에서 Table 존재 여부를 항상 확인한다. 기존 Table은 요청 mapping의 SQL 식별자 형식만 검증하고 Column 존재·자료형을 재검증하거나 schema를 변경하지 않는다. 없는 Table은 최종 Output Mapping에 문자열·JSON·object·array 저장이 하나라도 있으면 `VALUE`와 `STR_VALUE`, 없으면 `VALUE`만 포함한 TAG Table로 만들며 config도 각각 `VALUE`/`STR_VALUE` 또는 `VALUE`/빈 문자열로 정규화한다. 생성 실패 시 Job config·service는 바꾸지 않으며 `/job/validate`와 runtime Start는 Table을 만들지 않는다. 숫자 output은 Tag의 `transformOrder`를 왼쪽부터 적용해 `valueColumn`에 저장한다. 기본 `["bias", "multiplier"]`는 `(value + bias) * multiplier`이고, 반대 순서는 `(value * multiplier) + bias`다. 문자열·JSON·복합 output은 Transform 없이 String Value Column이 있을 때 저장하며 같은 행의 숫자 value에는 `0`을 저장한다. String Value Column이 없으면 해당 문자열 계열 행만 버리고 같은 Method·cycle의 숫자 행은 계속 저장한다. 이 생략은 `DB_APPEND_FAILED`가 아니다. DataViewer Chart는 숫자 column만 사용하고 Grid는 선택 문자열 column이 있을 때 문자열 값을 함께 보여 준다.

API create/patch의 `config`은 저장 document에서 top-level `name`과 `revision`을 뺀 객체다. Backend만 검증된 바깥 Job 이름을 document, 파일명, service name에 넣는다. `revision`은 Backend가 생성·증가시키는 정수이며 config 안에는 넣지 않는다.

### 2.5 상태 응답

```json
{
  "name": "production-line",
  "revision": 3,
  "configState": "installed",
  "executionState": "running",
  "statusKnown": true,
  "controllerState": "RUNNING",
  "controllerDetail": null
}
```

- `configState`: Controller 상태를 알면 보통 `installed`, 외부 service 삭제 시만 `config-only`, 알 수 없으면 `null`
- `executionState`: Controller 상태를 알면 `running` 또는 `stopped`, 알 수 없으면 `null`
- `statusKnown`: 두 요약 상태를 신뢰할 수 있으면 `true`, Controller 조회 실패 또는 `UNKNOWN`이면 `false`
- `controllerState`: `RUNNING`, `STARTING`, `STOPPING`, `STOPPED`, `FAILED`, `UNKNOWN`, `NOT_INSTALLED`
- `controllerDetail`: Controller가 제공한 설명 또는 `null`
- `revision`: GET/POST/PUT Job 상세 응답의 현재 설정 revision. Job 수정 PUT은 이 값을 보낸다.

GET/POST/PUT Job 상세 성공 data는 항상 `{ name, config, revision, configState, executionState, statusKnown, controllerState, controllerDetail }`를 포함한다. `configState`와 `executionState`는 `statusKnown: false`일 때만 `null`일 수 있고, `controllerDetail`은 설명이 없을 때 `null`이다.

## 3. 상태 전이와 동작 권한

```text
POST /job                 → installed + stopped + STOPPED
POST /job/start           → installed + running + STARTING/RUNNING
POST /job/stop            → installed + stopped + STOPPING/STOPPED
DELETE /job (정지 상태만)  → 설정과 service 제거
```

| 현재 상태 | start | stop | edit | delete |
|---|---:|---:|---:|---:|
| config-only (외부 service 삭제) | 자동 설치 후 가능 | 불가 | 가능 | 가능 |
| installed + stopped/failed | 가능 | 불가 | 가능 | 가능 |
| installed + running/starting/stopping | 불가 | 가능 또는 전환 대기 | 불가 | 불가 |
| UNKNOWN | 불가 | 불가 | 불가 | 불가 |

start는 외부에서 service가 지워진 Job이면 내부적으로 설치한 뒤 시작한다. `STARTING`과 `STOPPING`은 완료될 때까지 새 lifecycle 요청을 받지 않는다. update/delete가 실행 중이면 HTTP 409과 `JOB_RUNNING`을 반환한다. 사용자 DBus Interface를 Job이 하나라도 참조하면 이름 외 수정, Discover, Method 변경, 삭제를 `DBUS_INTERFACE_IN_USE`로 거부한다.

### 3.1 Job mutation operation lock과 lease

같은 Job의 POST create/start/stop, PUT update, DELETE와 package stop/uninstall은 하나의 mutation operation이다. Backend는 상태 조회부터 Controller side effect와 설정 파일 변경 완료까지 Job별 `operation lock`을 유지한다. Package stop/uninstall은 package lifecycle fence를 먼저 잡고, 그 안에서 목록을 읽은 뒤 대상 Job lock을 이름순으로 모두 잡은 채 전체 작업을 끝낸다. 그래서 먼저 처리된 Job도 마지막 Job이 끝나기 전에는 API가 다시 바꾸지 못하고, 대상 목록에 없던 새 이름의 Create도 `JOB_CONFLICT`로 막힌다. GET/list/last-run/validate와 DataViewer/Log 조회는 mutation lock을 잡지 않는다.

Package stop은 목록에서 상태를 아는 모든 configured Job을 `stopForPackage()`로 검사한다. 단, package start checkpoint에는 stop 직전 `RUNNING`, `STARTING`, `STOPPING`이었던 Job만 저장한다. Package lifecycle은 Job lock 일부만 잡다가 충돌해도 이미 잡은 lock과 fence를 모두 풀고 실패한다. 이 실패는 `PACKAGE_LIFECYCLE_FAILED`이며 원래 `JOB_CONFLICT`를 `details.errors[]`에 보존하므로 호출자가 안전하게 재시도할 수 있다. API mutation은 읽기 전용 availability probe로 fence 상태를 확인하고 Job lock을 잡은 뒤 같은 probe로 다시 확인한다. Probe는 canonical fence가 없거나 lease가 지났고 owner PID가 종료됐으면 available로 판단하며 어떤 lock도 만들거나 회수하지 않는다. Fresh fence, 살아 있는 owner, PID 판단 오류는 `JOB_CONFLICT`다. 실제 stale 회수는 package lifecycle의 exclusive acquire만 수행한다. Reclaim rename 중 canonical이 잠깐 없어 첫 probe가 통과해도 안전하다. API가 Job lock을 잡은 뒤 replacement fence가 보이면 두 번째 probe가 실패하고, package가 먼저 replacement fence를 잡고 API가 가진 Job lock에 도달하면 package 쪽이 실패하므로 둘이 함께 side effect를 실행할 수 없다. Package session 해제는 성공한 Job handle만 제거하고 실패한 handle과 fence는 보존한다. 모든 Job handle이 해제된 뒤에만 fence를 풀며, 실패한 같은 `session.release()`를 재시도할 수 있다.

lock은 `owner token`과 `heartbeat` 시각을 가진다. owner는 CGI 요청이 끝날 때 heartbeat를 중지하고 자기 token의 lock만 해제한다. lease가 지났고 `owner PID`가 종료되었다고 확인된 lock만 고유 quarantine 이름으로 원자 이동한 뒤 회수한다. PID 생존 여부를 확인할 수 없으면 안전하게 회수하지 않고 `JOB_CONFLICT`를 반환한다. 이전 owner는 Controller 호출이나 설정 파일 변경 같은 side effect 직전에 token을 다시 확인하며, 소유권을 잃었으면 `JOB_CONFLICT`로 중단한다. 이전 owner는 새 owner의 lock을 갱신하거나 해제할 수 없다.

Job create/update/start의 lock 순서는 package lifecycle probe → Job lock → Interface reader다. 배타 DBus Interface/Method 변경의 lock 순서는 아래 표를 유일한 기준으로 사용한다.

| 요청 | 고정 순서 | 참조가 남았을 때 |
|---|---|---|
| `POST /dbus-interface` | Interface mutation fence → Interface reader 확인 → 참조 Job 이름순 lock → 참조 재조회 → 검증·저장 | 새 Interface 생성 전 재조회에서 참조가 보이면 `JOB_CONFLICT` |
| `POST /dbus-method` | Interface mutation fence → Interface reader 확인 → 참조 Job 이름순 lock → 참조 재조회 → 검증·저장 | 유효한 다른 Method 참조는 생성 차단 사유가 아니다. `invalidConfig: true` 참조가 있으면 안전하게 `JOB_CONFLICT`; lock 충돌도 `JOB_CONFLICT` |
| `PUT /dbus-interface`, `PUT /dbus-method` | Interface mutation fence → Interface reader 확인 → 참조 Job 이름순 lock → 참조 재조회 → 검증·저장 | `DBUS_INTERFACE_IN_USE` 또는 `DBUS_METHOD_IN_USE` |
| `DELETE /dbus-interface`, `DELETE /dbus-method` | Interface mutation fence → Interface reader 확인 → 참조 Job 이름순 lock → 참조 재조회 → 삭제 | `DBUS_INTERFACE_IN_USE` 또는 `DBUS_METHOD_IN_USE` |

각 lock 획득이 충돌하면 이미 획득한 lock을 역순으로 풀고 `JOB_CONFLICT`로 실패한다. Job create/update/start는 Job lock 뒤 참조 Interface reader lock을 잡고 Interface와 Method를 다시 검증한다.

Interface ID와 Job name은 각각 ASCII 영문 소문자·숫자·`-`(Job은 `_`도 허용)만 사용하고 최대 100자다. Interface reader lock은 raw ID 대신 고정 64자의 SHA-256 Interface key를 써서 `<sha256InterfaceKey>--<jobName>`으로 만든다.

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

파일명과 document top-level name이 다르면 `JOB_INVALID_CONFIG`이다. 목록과 상세는 진단 목적으로 오류를 보여 줄 수 있지만 start/stop/update/delete는 모두 막는다. 이 상태를 자동으로 고치거나 이름을 추측하지 않는다.

FE의 Side switch는 Start/Stop control이다. 별도 Install 버튼과 `POST /job/install`은 없다. config-only Job은 외부 service 삭제 복구 상태이며 switch의 Start가 자동 설치 후 시작한다.

create와 config-only 복구 Start는 Job JSON을 사용해 아래 descriptor를 Controller에 등록한다. `enable: false`이므로 Controller 재시작 뒤 Job은 자동으로 시작하지 않는다.

```json
{
  "name": "_dbu_production-line",
  "enable": false,
  "working_dir": "<package>/cgi-bin",
  "executable": "<package>/cgi-bin/neo-collector.js",
  "args": ["production-line.json"]
}
```

## 4. API 목록과 envelope

모든 경로는 `/cgi-bin/api` 아래다.

| Method | 경로 | 입력 | 성공 data |
|---|---|---|---|
| GET | `/settings` | 없음 | Settings와 읽기 전용 `provider` (`null` 또는 Profile) |
| PUT | `/settings` | limits 또는 defaults; `provider` 금지 | 저장된 Settings (`provider` 없음) |
| GET | `/dbus-interface/list` | 없음 | DBus Interface 요약 배열 |
| GET | `/dbus-interface?id=` | Interface ID | 4.1의 DBus Interface 상세 |
| POST | `/dbus-interface/discover` | Bus Type, Destination, Object Path | 저장 없는 Introspection 결과 |
| POST/PUT/DELETE | `/dbus-interface` | POST는 단일 사용자 Interface body, PUT/DELETE는 id | 사용자 Interface 결과 |
| POST/PUT/DELETE | `/dbus-method` | interfaceId, methodId, Method | 부모 Interface 안의 Method 결과 |
| GET | `/job/list` | 없음 | Job 요약 배열 |
| GET | `/job?name=` | Job 이름 | `{name, config, 상태}` |
| POST | `/job` | `{name, config}`; `config.name` 금지 | 자동 설치된 stopped Job |
| PUT | `/job?name=` | name 없는 부분 config patch | 수정된 Job |
| DELETE | `/job?name=` | 없음 | 삭제 Job 이름 |
| POST | `/job/validate` | Job draft | valid와 warnings |
| POST | `/job/start?name=` | 없음 | 시작 상태 |
| POST | `/job/stop?name=` | 없음 | 정지 상태 |
| GET | `/job/last-run?name=` | Job 이름 | `{lastRun}` |
| POST | `/dbus/call` | interfaceId, methodId, inputs | Test Call 결과 |
| POST/GET/PUT/DELETE | `/db/server` | DB Server CRUD | 등록 DB Server |
| GET | `/db/server/list` | 없음 | DB Server 목록 |
| GET | `/db/connect?server=` | 등록 이름 | 연결 확인 결과 |
| POST | `/db/table/create` | server와 table 정의 | 생성된 TAG table |
| GET | `/db/table/list` | server | table 목록 |
| GET | `/db/table/columns` | server, table | column과 TAG metadata |
| GET | `/db/table/tags` | Job DB 설정 | Table의 전체 Tag와 선택적 Asset hierarchy |
| GET | `/db/table/data` | Job DB 설정, Tag, 페이지/시간 범위 | Raw Grid 행과 페이지 경계 |
| GET | `/db/table/stat` | Job DB 설정, Tag | 선택 Tag의 첫·마지막 시간 |
| GET | `/db/table/chart` | Job DB 설정, 숫자 Tag, 시간 범위 | Neo Web이 실행할 검증된 Chart query |
| GET | `/log/all` | 없음 | 전체 Job 로그 요약 |
| GET | `/log/list?name=` | Job 이름 | 로그 파일 목록 |
| GET | `/log/content?name=&file=&page=&lines=` | Job 이름과 파일, 선택 page/lines | 페이지 로그 내용 |
| GET | `/log/content/all?name=&file=` | Job 이름과 파일 | 로그 전체 내용 |
| GET | `/log/tail?name=&file=&lines=` | Job 이름과 파일, 선택 lines | 로그 마지막 부분 |

DataViewer의 DB 저장값과 CGI API 시간은 UTC ISO-8601(`Z`)가 기준이다. 화면은 원본 OPC UA DataViewer처럼 UTC·LOCAL·IANA 시간대를 골라 **표시만** 바꾼다. CGI에는 timezone query를 보내지 않는다. 예전 timezone query는 호환을 위해 계속 `TIMEZONE_UNSUPPORTED`으로 거부한다.

DataViewer의 `job`, `server`, `table`은 모두 필수다. Backend는 Job의 Database Server, Table, Value Column, String Value Column과 요청을 대조한다. 단, `names`는 현재 Job이 만든 Tag로 제한하지 않는다. 같은 Table에 실제로 존재하는 다른 Job의 Tag와 과거 Tag도 선택할 수 있다. server/table/column이 다르면 HTTP 400 `JOB_DATA_SOURCE_MISMATCH`다.

`/db/table/tags`는 `_&lt;TABLE&gt;_META`의 전체 Tag를 `id`, `name`, 선택 `asset`으로 반환하고, `__machbase_hierarchy__` 메타 Tag에서 읽은 `assetHierarchy:{column,schema,tree}`를 함께 반환한다. hierarchy 메타 Tag 자체는 선택 목록에 넣지 않는다. hierarchy가 없으면 `assetHierarchy:null`이다.

`/db/table/data`는 Raw Grid용 다중 Tag 조회다. `page`, `pageSize`, `direction`, `from`, `to`, `boundedRange`, `cursorSide`, `cursorTime`, `cursorName`, `cursorOffset`을 받으며 `pageSize`는 최대 1,000,000이다. `cursor*`는 같은 basetime 안에서 Tag 이름까지 함께 비교하는 keyset 경계다. `_RID`는 조회·정렬·응답에 쓰지 않는다. 결과 행은 `{time,name,value,stringValue}`이며 `time`은 UTC `Z`다. `includeTotal=true`이면 행 대신 같은 범위의 `{total,pageSize,lastPage}`를 반환한다. 계속 수집 중인 Table이므로 pagination은 snapshot이 아니다.

`/db/table/stat`은 선택 Tag의 `{minTime,maxTime}`을 반환해 `last-*` 시간 범위를 고정한다. `/db/table/chart`는 CGI에서 series를 만들지 않고, 검증된 실제 key/time/value 열과 SQL 문자열 literal로 만든 `{query}`를 반환한다. Neo Web `/web/api/query`만 이 query를 실행한다.

`/db/table/tags`, `/db/table/data`, `/db/table/stat`, `/db/table/chart`는 `/db/table/columns`와 같은 TAG metadata FLAG에서 `primaryKey === true`와 `basetime === true`인 실제 column 이름을 자동으로 사용한다. FE는 `primaryColumn`과 `timeColumn`을 보내지 않는다. 관리 도구가 두 값을 명시해 보낼 때도 Backend는 metadata의 같은 역할 column인지 검증하고, `NAME`·`TIME`이라는 이름을 기본값으로 가정하지 않는다.

### 4.1 API 세부 형식

이 절의 배열 query는 같은 key를 반복해 보낸다(예: `names=A&names=B`). 성공 응답은 언제나 envelope의 `data` 안에 아래 구조를 넣는다.

| API | 필수 입력 | 선택 입력 | 성공 data 최상위 구조 |
|---|---|---|---|
| `POST/PUT /db/server` | `name`, `host`, `port`, `user`, `password` | 없음 | `{schemaVersion, name, host, port, user, hasPassword}`. 비밀번호 원문은 응답하지 않는다. |
| `GET/DELETE /db/server` | `name` | 없음 | GET은 등록 server 요약, DELETE는 `{name}` |
| `GET /db/server/list` | 없음 | 없음 | `[{schemaVersion, name, host, port, user, hasPassword}]` |

#### DBus Interface 상세 응답

`GET /dbus-interface?id=<interfaceId>`의 성공 `data`는 아래 구조를 **항상** 사용한다. 이 표가 Interface 상세 응답의 유일한 완전한 기준이다.

| 필드 | 타입 | 의미 |
|---|---|---|
| `interface` | object | 저장된 DBus Interface. `schemaVersion: 1`, `id: string`, `builtIn: boolean`, `busType: "system"\|"session"`, `destination: string`, `objectPath: string`, `interface: string`, `methods: Method[]`를 모두 가진다. |
| `interface.methods[]` | Method object | `id: string`, `source: "discovered"\|"manual"`, `member: string`, `inputs: Parameter[]`, `outputs: Parameter[]`를 모두 가진다. |
| `Parameter` | object | 필수 `name: string`, `type: DBusType`와 선택 `required?: boolean`, `validation?: ParameterValidation`을 가진다. `DBusType`의 전체 구조는 [DBUS_TYPE_SYSTEM.md](DBUS_TYPE_SYSTEM.md) 3절을 따른다. |
| `ParameterValidation` | object | 선택 `minimum?: number`, `maximum?: number`, `pattern?: string`만 가질 수 있다. |
| `references` | array | 이 Interface를 참조하거나, 읽을 수 없는 Job 설정 때문에 안전하게 변경을 막아야 하는 Job의 `InterfaceReference[]`다. 파일명(Job 이름) 오름차순이다. |
| `references[].name` | string | Job 파일명에서 얻은 Job 이름이다. |
| `references[].documentName` | `string\|null` | 읽은 Job document의 top-level `name`이다. JSON을 읽지 못했으면 `null`이다. |
| `references[].calls` | `string[]` | 유효한 Job에서 이 Interface를 참조하는 Method Call ID들이다. `invalidConfig: true`이면 빈 배열이다. |
| `references[].methodIds` | `string[]` | 유효한 Job에서 이 Interface를 참조하는 **고유한** Method ID들이다. 이 필드는 모든 항목에 필수이며, `invalidConfig: true`이면 빈 배열이다. |
| `references[].invalidConfig` | boolean | Job JSON을 읽을 수 없거나 파일명·top-level name·필수 Method Call(`id`, `name`, `interfaceId`, `methodId`, `inputs`, `tags`) 구조가 잘못됐으면 `true`다. 이 경우 FE는 특정 Method를 추측하지 않고 Interface의 모든 변경을 안전하게 막는다. |

FE는 목록에서 참조 상태를 표시하지 않으며, 행 선택도 상세 API 요청을 보내지 않는다. 사용자가 Edit 또는 Delete를 누를 때만 상세를 읽고 그 `references[]`로 차단한다. `references[]`가 하나라도 있으면 이름 외 Interface 수정, Discover, Method 추가·수정·삭제와 Interface 삭제를 모두 막고 참조 Job을 안내한다. 참조가 없을 때 discovered Method는 계속 읽기 전용이며, manual Interface의 manual Method만 추가·수정·삭제할 수 있다. Built-in View 상세는 Interface와 모든 Method의 입력·출력, `references[]`를 읽기 전용으로 모두 표시한다.

#### DBus Interface·Method 변경 요청

DBus Interface와 Method의 ID는 소문자 영문·숫자·하이픈만 쓰는 최대 100자 kebab-case 문자열이다. 필수 query/body 필드가 없거나 빈 문자열, ID 형식 오류, 알 수 없는 wrapper 필드가 있으면 Interface 요청은 HTTP 400 `DBUS_INTERFACE_INVALID`, Method 요청은 HTTP 400 `DBUS_METHOD_INVALID`이다. body 또는 query가 최대 크기를 넘으면 이 규칙보다 먼저 HTTP 413 `REQUEST_TOO_LARGE`를 반환한다.

| API | 필수 query | 필수 body | 허용 wrapper 필드 | 성공 data |
|---|---|---|---|---|
| `POST /dbus-interface` | 없음 | `name`, `origin`이 있는 단일 Interface object (`id` 없음) | `schemaVersion`, `name`, `origin`, `builtIn`, `busType`, `destination`, `objectPath`, `interface`, `methods` | 서버가 ID를 만들어 저장한 Interface |
| `PUT /dbus-interface` | 없음 또는 `discover=true` | `id`, `name`, `origin`이 있는 단일 Interface object | Interface object 필드만 | 저장한 Interface |
| `POST /dbus-method` | 없음 | `{interfaceId, method}` | `interfaceId`, `method` | 저장한 Method |
| `PUT /dbus-method` | 없음 | `{interfaceId, methodId, method}` | `interfaceId`, `methodId`, `method` | 수정한 Method |
| `DELETE /dbus-method` | `interfaceId`, `methodId` | 없음 | query는 `interfaceId`, `methodId`만 | `{interfaceId, methodId}` |

`POST`와 `PUT /dbus-interface`는 Interface object 하나만 body로 받는다. `{interfaces:[...]}` 배열 wrapper는 허용하지 않는다. 새 Interface는 `POST`로 저장한다. 기존 Interface에서 Discover로 선택한 `discovered` Method 목록은 `PUT /dbus-interface?discover=true`으로 저장하며, Backend는 기존 `manual` Method를 보존한다. 참조 Job이 하나라도 있으면 Discover 저장은 `DBUS_INTERFACE_IN_USE`로 거부한다. 일반 `PUT`은 `discover` query 없이 기존 Interface 수정 규칙을 따른다. Save All과 카드별 저장 API는 없다. `PUT /dbus-method`의 바깥 `methodId`와 `method.id`는 모두 필수이고 완전히 같아야 한다. Method object와 Interface object 안의 알 수 없는 필드도 같은 `DBUS_*_INVALID` 오류로 거부하며 저장 전에 제거하거나 무시하지 않는다.

| API | 필수 입력 | 선택 입력 | 성공 data 최상위 구조 |
|---|---|---|---|
| `GET /db/connect` | `server` | 없음 | `{server, connected}`와 실패 시 진단 정보 |
| `POST /db/table/create` | `server`, `table`, `valueColumn` | `stringValueColumn` (`null` 허용) | `{server, table, primaryKeyColumn, basetimeColumn, valueColumn, stringValueColumn}` |
| `GET /db/table/list` | `server` | 없음 | `{server, tables}` |
| `GET /db/table/columns` | `server`, `table` | 없음 | `{server, table, columns}`. 각 column은 이름·type·TAG metadata FLAG를 가진다. |
| `GET /db/table/tags` | `job`, `server`, `table` | `limit` | `{server, table, tags:[{id,name,asset?}], assetHierarchy:null|{column,schema,tree}, limited, limit}` |
| `GET /db/table/data` | `job`, `server`, `table`, `names` | `page`, `pageSize`, `direction`, `from`, `to`, `boundedRange`, `cursorSide`, `cursorTime`, `cursorName`, `cursorOffset` | `{rows:[{time,name,value,stringValue}], page, pageSize, direction}`. `includeTotal=true`이면 `{total,pageSize,lastPage}`. |
| `GET /db/table/stat` | `job`, `server`, `table`, `names` | 없음 | `{minTime,maxTime}`. 값이 없으면 `null`. |
| `GET /db/table/chart` | `job`, `server`, `table`, `names` | `from`, `to` | `{query, columns, range}`. `query`는 Neo Web만 실행한다. |
| `GET /log/list` | `name` | 없음 | `{name, files}` |
| `GET /log/content` | `name`, `file` | `page`, `lines` | `{name,file,page,linesPerPage,totalLines,lines,nextPage,previousPage}` |
| `GET /log/content/all` | `name`, `file` | 없음 | `{name,file,size,content}` |
| `GET /log/tail` | `name`, `file` | `lines` | `{name,file,lines,totalLines}` |
| `GET /log/all` | 없음 | 없음 | `{jobs}` |

`/db/table/tags`, `/db/table/data`, `/db/table/stat`, `/db/table/chart`의 `job`은 Job name이다. Backend는 `job`의 `database.server`, `database.table`, Value Column, String Value Column과 요청을 대조한다. `names`는 같은 Table의 실제 Tag라면 현재 Job이 만든 Tag인지와 관계없이 허용한다. `from`과 `to`는 UTC ISO-8601 `Z` 문자열이다. cursor의 세부 비교는 API 사용자가 만들지 않고 화면 모델이 만든다.

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

공개 오류 코드는 `SETTINGS_INVALID`, `PROVIDER_PROFILE_INVALID`, `DBUS_INTERFACE_NOT_FOUND`, `DBUS_INTERFACE_INVALID`, `DBUS_INTERFACE_READ_ONLY`, `DBUS_INTERFACE_IN_USE`, `DBUS_METHOD_NOT_FOUND`, `DBUS_METHOD_INVALID`, `DBUS_METHOD_IN_USE`, `DBUS_METHOD_READ_ONLY`, `INTROSPECTION_UNSUPPORTED`, `JOB_NOT_FOUND`, `JOB_ALREADY_EXISTS`, `JOB_INVALID`, `JOB_INVALID_CONFIG`, `JOB_NAME_IMMUTABLE`, `JOB_REVISION_REQUIRED`, `JOB_CONFLICT`, `JOB_RUNNING`, `SERVICE_NOT_INSTALLED`, `SERVICE_ALREADY_INSTALLED`, `DB_SERVER_INVALID`, `TABLE_INVALID`, `TABLE_ALREADY_EXISTS`, `JOB_DATA_SOURCE_MISMATCH`, `DBUS_UNAVAILABLE`, `DBUS_ARGUMENT_UNSUPPORTED`, `DBUS_CALL_FAILED`, `OUTPUT_DECODE_FAILED`, `OUTPUT_COUNT_MISMATCH`, `DB_APPEND_FAILED`, `TIMEZONE_UNSUPPORTED`, `REQUEST_TOO_LARGE`, `PACKAGE_LIFECYCLE_FAILED`다. `SETTINGS_INVALID`은 저장 Settings 또는 PUT field가 잘못됐을 때, `PROVIDER_PROFILE_INVALID`은 build Profile 파일을 읽거나 검증할 수 없을 때 HTTP 400으로 쓴다. `DBUS_INTERFACE_INVALID`은 Interface 문서 또는 요청 필드가 계약 형식과 다를 때, `DBUS_METHOD_INVALID`은 Method 문서 또는 요청 필드가 계약 형식과 다를 때 HTTP 400으로 쓴다. `DBUS_METHOD_READ_ONLY`는 discovered Method를 직접 바꾸려 할 때 HTTP 409으로 쓴다. `DBUS_ARGUMENT_UNSUPPORTED`은 Interface와 입력값은 유효하지만 현재 Neo DBus module이 해당 Type 호출을 지원하지 않을 때 HTTP 409으로 쓴다. 공개 warning code는 `TAG_NAME_USED_BY_ANOTHER_JOB`다. 이 목록에 없는 문자열을 새 공개 오류·warning code로 추가하려면 계약 변경 기록이 필요하다.

FE는 `reason`을 표시하고 `code`로 비활성화 이유를 안내한다. 요청은 사용자 취소만 AbortSignal으로 처리하며 timeout으로 취소하지 않는다.

Job API 이름 규칙은 다음과 같다.

- POST body의 바깥 `name`은 새 Job의 유일한 식별자다. `config`에 `name`이 있으면 HTTP 400 `JOB_INVALID`이다.
- PUT은 query의 `name`을 고정 식별자로 사용한다. body는 부분 config patch이고 `name`을 포함하면 HTTP 409 `JOB_NAME_IMMUTABLE`이다.
- PUT body는 `revision`과 name 없는 부분 config patch다. `revision`이 없으면 `JOB_REVISION_REQUIRED`, 저장 직전 현재 revision과 다르면 HTTP 409 `JOB_CONFLICT`다. 성공 저장 때 revision은 1 증가한다. 병합 순서는 `defaults → existing config → request patch`다. 객체는 깊이 병합하고 배열은 request 배열 전체로 교체한다.
- Backend는 바깥 또는 query name을 저장 document top-level name, `<jobName>.json`, `_dbu_<jobName>`에만 쓴다. 저장 name과 파일명이 다르면 `JOB_INVALID_CONFIG`이고 모든 위험 동작을 차단한다.
- Job mutation은 `operation lock`을 획득한 뒤 상태를 조회하고, Controller side effect와 설정 파일 변경이 끝날 때까지 유지한다. lock의 `owner token`과 `heartbeat` lease 회수 규칙은 **3.1 Job mutation operation lock과 lease**를 따르며, 다른 mutation이나 소유권을 잃은 이전 owner는 HTTP 409 `JOB_CONFLICT`다.

`POST /job/validate`는 유효한 draft에 HTTP 200 `{ "ok": true, "data": { "valid": true, "warnings": [...] } }`를 반환한다. `warnings`의 각 항목은 `{ "code": "TAG_NAME_USED_BY_ANOTHER_JOB", "reason": "...", "path": "...", "details": { ... } }`다. `path`는 draft 안의 문제 위치를 가리키는 JSON Pointer이며, warning은 저장 차단 오류가 아니다. 유효하지 않은 draft는 warning 응답 대신 일반 실패 envelope의 `JOB_INVALID`을 반환한다.

DB Server 관리 화면은 등록 목록을 읽고, Create/Edit/Delete와 Test Connection을 제공한다. Create와 Edit는 모두 `name`, `host`, `port`, `user`, `password`를 요구하며, password 누락·빈 값은 HTTP 400 `DB_SERVER_INVALID`다. 비밀번호는 등록 DB Server 저장소 밖으로 복사하지 않으며 Job config, 목록, 로그, 오류에 나타나지 않는다. Database Server 저장은 Default Table 이름과 기존 Table에서 사용자가 선택한 Column 이름만 저장하고 Table 생성이나 metadata 검증을 하지 않는다. 없는 Default Table이면 두 Column은 빈 값이다. `POST /db/table/create`는 독립 관리 API로 유지하며 `{server, table, valueColumn, stringValueColumn}`을 받고 `stringValueColumn`은 `null`일 수 있다. Backend는 primary key·basetime 열과 자료형을 정해 만들고 `{server, table, primaryKeyColumn, basetimeColumn, valueColumn, stringValueColumn}`을 반환한다. 이미 있는 table은 HTTP 409 `TABLE_ALREADY_EXISTS`, 잘못된 table 또는 column 설정은 HTTP 400 `TABLE_INVALID`다. DataViewer는 Job Database mapping을 기준으로 열리며, Table의 전체 Tag를 탐색·다중 선택한다.

## 5. 구현 순서

### 단계 1: 공통 기반

1. 공통 HTTP helper를 새 envelope와 HTTP 400/404/409/503 매핑으로 만든다.
2. Settings와 읽기 전용 Provider Profile, DBus Interface, Job의 schemaVersion 1 loader·validator를 만들고 저장 설정에는 atomic writer를 사용한다.
3. 새 service name helper `_dbu_<jobName>`와 Controller 상태 adapter를 만든다.

완료 기준: 새 envelope 단위 테스트가 통과한다.

### 단계 2: DBus Interface·Job·lifecycle API

1. generic 사용자 Interface 저장소와 Provider 배포판이 별도로 공급하는 읽기 전용 Interface asset 경계를 만든다.
2. Neo DBus module의 구조화된 Introspection 결과와 DBus signature parser, Interface/Method validation, 참조 분석, 수정·삭제 차단을 만든다.
3. Job CRUD, 생성 시 자동 설치, Start/Stop, 정지 상태 delete를 만든다.
4. 목록·상세에 분리된 상태 모델과 Controller 원본 상태를 넣는다.

완료 기준: 실행 중 PUT/DELETE가 `JOB_RUNNING`, 참조 Interface/Method 변경이 409, 생성 직후 installed/stopped와 외부 삭제 복구 config-only 상태가 API 테스트로 확인된다.

### 단계 3: Collector와 DBus 실행

1. typed argument builder, simple path decoder, Provider가 선택한 지원 tag generator, Transform을 구현한다.
2. Job별 `neo-collector.js`와 scheduler/backoff, connection 재사용, shutdown 정리를 구현한다.
3. perMethod/afterAllMethods row 저장과 lastRun service details를 구현한다.
4. Test Call과 DBus/DB/Controller 실제 JSH 연결을 확인한다.

완료 기준: 선택 결과와 Tag 수가 다르면 저장 없이 실패하고, 정상 cycle은 Tag 값과 lastRun을 남기며, timeout 관련 구현이 없다.

### 단계 4: Side/Main 프런트엔드

1. API client에서 timeout AbortController 없이 새 envelope를 해석한다.
2. Side 목록과 Main 상세가 분리 상태·전환 상태·차단 사유를 표시하게 만든다.
3. Job/DBus Interface/Method forms, Tag 생성·일괄 편집·Test Call을 구현한다.
4. Job → Method Call → Tag DataViewer와 로그 화면을 연결한다.

완료 기준: `DESIGN.md` 토큰만 사용하고, Side/Main이 같은 선택 상태를 공유하며, 실행 중 Edit/Delete가 UI와 API에서 모두 차단된다.

### 단계 5: 통합 검증과 문서

1. Node 단위 테스트와 JSH 통합 테스트를 실행한다.
2. Neo 8.5.8 환경에서 System Bus, generic CRUD, service lifecycle, TAG append, DataViewer를 점검하고 Provider 설비 검증은 해당 배포판 gate에서 따로 수행한다.
3. README와 API 예시를 새 DBus 모델로 교체한다.

완료 기준: 아래 완료 게이트가 모두 충족된다.

## 6. 테스트와 완료 게이트

Node 단위 테스트는 Settings/Provider schema validation, path decoder, typed args, 지원 tag generator, Transform, retry delay, save policy buffering, API envelope, lifecycle 권한을 검증한다. API 테스트는 다음을 반드시 포함한다.

- 생성 시 자동 설치, start, stop, delete 전이
- running/starting/stopping Job의 update/delete 거부
- 참조 중인 사용자 DBus Interface/Method update/delete 거부
- Introspection의 전체 Interface/Method/입력·출력 파싱, Standard 뱃지, manual Method 보존, 참조 Interface 변경 차단
- DBus string 출력의 JSON 해석 성공·실패, JSON Pointer 실패, 배열 원소 수와 Tag 수 불일치
- perMethod partial 저장과 afterAllMethods 무저장
- `UNKNOWN` Controller 상태의 위험 동작 차단
- 모든 실패 응답의 `ok/code/reason/details` 구조

공통 JSH 통합 테스트는 `require("dbus")`, System Bus 연결, Job별 service install/start/stop/uninstall, shutdown close, service details lastRun, Machbase TAG append, DataViewer query를 확인한다. 특정 Provider destination·Method·tag generator는 해당 Provider 배포판 gate에서 추가 확인한다.

완료 게이트:

1. 최소 Neo `8.5.8`에서 Side/Main 기능이 동작한다.
2. 새 Settings·Provider Profile·DBus Interface·Job은 모두 schemaVersion `1`이고, build Profile과 Provider가 공급한 Built-in Interface/Method는 읽기 전용이다.
3. service는 `_dbu_<jobName>`만 사용한다.
4. running Job은 변경·삭제되지 않고, 참조 중인 사용자 DBus Interface/Method는 변경·삭제되지 않는다.
5. installed/running/Controller 상태와 외부 삭제 복구 config-only 상태가 API와 화면에서 분리된다.
6. API는 새 envelope만 사용하고 timeout 로직이 없다.
7. `DESIGN.md`를 바꾸지 않고 지정된 디자인 토큰과 접근성 규칙을 지킨다.
