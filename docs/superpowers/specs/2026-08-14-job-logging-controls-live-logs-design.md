# Job Logging Controls 및 Live Logs 설계

## 목표

DBus Job 상세 화면에 `neo-pkg-opcua-client`의 Logging Controls와 Live Logs 경험을 공통 기능으로 이식한다. 운영자는 상세 화면을 벗어나지 않고 현재 로그 설정을 확인하고, 실시간에 가까운 로그를 열어 일시 정지하거나 비우며, 저장된 로그 파일 화면으로 이동할 수 있어야 한다.

Generic과 LS 제품은 같은 공통 화면을 사용한다. Job 저장 형식과 기존 로그 파일 API는 유지한다.

## 승인된 선택

OPC UA 화면은 SSE를 사용하지만 DBus는 기존 `GET /log/tail` JSON API를 1초마다 호출한다. 사용자가 보는 기능과 디자인은 OPC UA를 따르고 전송 방식만 현재 DBus 계약에 맞춘다.

이 방식을 선택한 이유는 다음과 같다.

- 새 장기 연결 API를 만들지 않고 현재 Neo CGI에서 검증된 요청·응답을 재사용한다.
- 기존 Log Viewer와 Backend를 깨뜨리지 않는다.
- Generic과 LS에 같은 공통 컴포넌트를 적용할 수 있다.

사용자가 2026-08-14에 권장안인 기존 JSON tail polling 방식으로 진행을 승인했다.

## 화면 설계

### Job 상세 동작 버튼

Job 상세 헤더의 동작 순서는 다음과 같다.

1. `Live Logs`: `terminal` 아이콘이 있는 공통 보조 버튼
2. `Data Viewer`: `query_stats` 아이콘이 있는 Primary outline 버튼
3. `Edit`: `edit` 아이콘이 있는 공통 보조 버튼
4. `Delete`: `delete` 아이콘이 있는 danger 버튼

기존 상단 `Logs` 버튼은 제거한다. 저장된 로그 파일은 아래 Logging Controls의 `View Logs`로 연다. 기존 Job 상태에 따른 Edit와 Delete 비활성 규칙은 바꾸지 않는다.

### Logging Controls

`LATEST RUN` 아래에 OPC UA와 같은 한 줄 요약 카드를 표시한다.

- 제목과 `terminal` 아이콘
- `LOG LEVEL`과 현재 level 배지
- 현재 level에서 실제 기록되는 level 목록
- `FILE LIMIT`과 `config.log.maxFiles`
- `description` 아이콘이 있는 `View Logs` Primary outline 버튼

기록 level은 `trace → debug → info → warn → error` 순서의 현재 threshold 이상이다. 예를 들어 `info`는 `INFO`, `WARN`, `ERROR`를 표시한다. `View Logs`는 기존 `/logs/:name`으로 이동한다.

### Live Logs 패널

`Live Logs`를 누르면 OPC UA와 같은 부유 패널을 연다.

- 최초 크기 460×360px, 최소 크기 320×220px
- 화면 오른쪽 아래에서 열리고 viewport 밖으로 나가지 않는다.
- 제목 영역을 잡아 이동할 수 있다.
- 오른쪽·아래·오른쪽 아래 resize handle로 크기를 바꿀 수 있다.
- `CONNECTED` 또는 `DISCONNECTED`, 현재 표시 줄 수를 보인다.
- `Pause/Resume`, `Clear`, `Close`를 제공한다.
- 최대 100줄을 유지하고 `[TRACE]`, `[DEBUG]`, `[INFO]`, `[WARN]`, `[ERROR]`를 level 색으로 표시한다.
- 새 로그가 오고 사용자가 이미 아래를 보고 있으면 자동으로 아래에 붙는다. 사용자가 위로 스크롤하면 현재 위치를 유지한다.

패널은 route 이동 또는 Job 변경 시 닫고 polling을 정리한다. 여러 Live Logs 연결을 동시에 만들지 않는다.

## 데이터 흐름

1. 패널을 열면 `GET /log/list?name=<job>`으로 파일 목록을 읽는다.
2. `active:true` 파일을 선택한다. 없으면 로그가 생성될 때까지 다음 polling에서 다시 목록을 확인한다.
3. 활성 파일이 있으면 1초마다 필수 `name`, `file`을 넣어 `GET /log/tail`을 호출한다.
4. 응답의 `lines` 중 마지막 100줄을 화면 snapshot으로 사용한다.
5. Pause 중에는 요청 결과를 화면에 반영하지 않는다. Resume 즉시 다시 읽는다.
6. Clear는 현재 화면만 비운다. Clear 시점의 `totalLines`를 기준으로 이후 추가된 줄만 표시한다. 파일 rotation이나 truncation으로 `totalLines`가 작아지면 새 파일로 보고 기준을 초기화한다.

Backend endpoint, envelope, query 필드와 Job `config.log` 구조는 바꾸지 않는다.

## 오류 처리

- 목록 또는 tail 요청 실패 시 기존 줄은 유지하고 상태를 `DISCONNECTED`로 바꾼다.
- 다음 1초 주기에 자동으로 다시 시도한다.
- 활성 파일이 아직 없으면 오류 alert를 반복해서 띄우지 않고 빈 연결 대기 상태를 표시한다.
- Pause·Clear·Close는 서버 파일을 수정하지 않는다.
- 사용자가 패널을 닫으면 진행 중 요청을 취소하고 timer를 제거한다.

## 컴포넌트 경계

- `JobDetail`: 동작 버튼, Logging Controls 요약, 패널 open 상태를 소유한다.
- `LiveLogs`: polling, pause, clear, 이동, resize, 줄 표시를 소유한다.
- `api.logs`: 기존 `list`와 `tail`만 사용한다.
- `LogsPage`: 저장 로그 파일 선택과 내용 보기를 계속 담당한다.

각 단위는 기존 공개 API로만 연결하며 Live Logs의 화면 상태를 Job draft나 Settings에 저장하지 않는다.

## 문서 영향

- `DBUS_SDD.md`: Job 상세 로그 UX 변경 기록을 추가한다.
- `FE_DESIGN.md`: 버튼 의미, Logging Controls, Live Logs polling과 상태를 추가한다.
- `BE_DESIGN.md`: 새 API가 없고 기존 `/log/list`, `/log/tail` 계약을 유지함을 명시한다.
- 공개 오류 코드와 Backend 저장 구조는 변경하지 않는다.

## 검증 기준

- Job 상세에서 네 동작 버튼의 순서·아이콘·색과 disabled 상태가 계약과 같다.
- Logging Controls가 level, 실제 기록 level, file limit을 정확히 표시한다.
- `View Logs`가 기존 저장 로그 화면으로 이동한다.
- Live Logs가 active 파일을 고르고 1초 polling으로 최대 100줄을 표시한다.
- Pause/Resume, Clear, Close, drag, resize와 viewport clamp가 동작한다.
- polling 오류 뒤 DISCONNECTED가 표시되고 다음 요청 성공 시 복구한다.
- Job 변경·route 이동·unmount 후 요청과 timer가 남지 않는다.
- Generic과 LS frontend 테스트, 제품 경계 테스트와 root Generic build가 통과한다.
- OPC UA 원본과 DBus 구현을 같은 viewport에서 비교해 버튼, Logging Controls와 Live Logs의 간격·색·높이·아이콘 차이를 확인한다.

## 범위 밖

- SSE 또는 WebSocket 로그 API 추가
- 서버 로그 파일 삭제·초기화
- Job 화면에서 Log Level이나 File Limit 편집
- 기존 LogsPage의 기능 재설계
- 로그 검색, 다운로드 또는 여러 Job 동시 Live Logs
