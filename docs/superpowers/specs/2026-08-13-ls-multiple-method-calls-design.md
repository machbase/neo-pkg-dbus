# LS 다중 Method Call 설계

## 목적

LS 새 Job도 같은 고정 `GetDeviceData` Call을 여러 개 추가해 서로 다른 PLC 주소를
한 Job에서 순서대로 수집할 수 있게 한다. Interface, Method와 Output 해석 규칙은
사용자가 바꾸지 못하며, Call별 `DeviceString`, `DataCount`, Tag 이름과 Transform만
독립적으로 관리한다.

## 고정 계약

- LS Job에는 Method Call이 하나 이상 있어야 한다.
- 모든 Call은 `ls-plc-device`의 `get-device-data`만 사용한다.
- 각 Call의 Output은 `Return → JSON → /data → array(numeric)` 한 개로 고정한다.
- 새 Job은 Call 하나로 시작한다.
- `Add Call`은 Provider 기본 Call을 깊은 복사하고 고유 ID를 만든 뒤 배열 끝에
  추가한다.
- 배열 순서가 실행 순서다. 좌측 drag handle로만 순서를 바꾼다.
- 마지막 남은 Call은 삭제할 수 없다.
- Test Call은 현재 선택한 Call 하나만 실행한다.
- Backend는 저장되는 모든 Call의 고정 Interface, Method, Output과 입력·Tag 규칙을
  검증한다.
- generic 제품의 Method Call 계약과 화면은 바꾸지 않는다.

## 화면 구조

Method Calls는 하나의 master-detail 카드로 표시한다.

### 목록

- 헤더 오른쪽에 `Add Call`을 둔다.
- 각 행은 drag handle, `DeviceString`, `DataCount`를 이 순서로 표시한다.
- 선택 행은 기존 선택색과 왼쪽 강조선으로 구분한다.
- 행을 선택하면 오른쪽 상세가 해당 Call로 바뀐다.
- 목록은 최대 8행 높이를 사용한다. 9번째부터 목록 안에서 세로 스크롤하며 새로
  추가하거나 선택한 행은 보이는 범위로 자동 이동한다.
- 선택 Call을 삭제하면 앞 Call을 선택한다. 첫 Call을 삭제했다면 다음 Call을
  선택한다.

### 선택 Call 상세

- 상단에 고정 Method 식별자 `ls-plc-device · get-device-data`를 보조 텍스트로
  표시한다.
- 오른쪽에는 `Test Call`과 삭제 아이콘을 둔다.
- 입력은 `DeviceString`, `DataCount` 순서다.
- 바깥 DeviceString 주소 본문은 현재 적용값을 읽기 전용으로 표시하고 오른쪽 화살표로
  주소 선택 팝오버를 연다. 팝오버는 입력과 같은 너비의 overlay이며 Memory Area와
  Data Type은 같은 비율, Address는 고정 너비의 숫자 spinner다. 후보 목록은 한 번에
  하나만 열린다. Memory Area 후보는 `A/F/I/Q/M/K/R/W`, Data Type 후보는
  `X/B/W/D/L`이다. 새 Call은 DeviceString `%MB0`, DataCount `1`, 자동 Tag `MB0`
  한 개로 시작한다.
  Address 기본값은 `0`, DataCount 최소값은 `1`이고 두 숫자 입력은 같은 위·아래
  아이콘 control을 사용한다. 화살표뿐 아니라 바깥 읽기 전용 주소 본문을 눌러도
  팝오버가 열린다. 팝오버 아래 완성 주소 입력은 `%MB3`
  정규형을 직접 수정한다.
- 팝오버가 열려도 Method Calls 상세와 Tags의 높이·위치는 바뀌지 않는다.
- 두 입력은 `repeat(2, minmax(0, 1fr))`인 같은 너비이며 사이 간격은 디자인 시스템의
  `grid-gap`을 쓴다.
- Tags는 기본 접힘이며 `TAGS`, Tag 개수, 첫 Tag~마지막 Tag를 요약한다. 비어 있으면
  `0 tags`를 표시한다.
- Tags disclosure의 바깥 왼쪽·오른쪽 경계는 위 입력 행과 정확히 같다. 별도 음수
  margin이나 전체 상세 폭 사용을 금지한다.
- 펼치면 현재 Call의 Tag 이름과 Transform만 표시한다.
- 다른 Call을 선택하면 Tags는 다시 접힌다.

선택 Call과 Tags 접힘 상태는 화면 상태일 뿐 Job payload에 저장하지 않는다.

## 자동 Tag와 편집

기존 LS 규칙을 그대로 사용한다. `DeviceString` 또는 `DataCount`가 바뀌면 자동 Tag만
다시 계산하고, 사용자가 바꾼 같은 위치의 Tag 이름과 Transform은 유지한다.
`DataCount`가 줄면 범위 밖 Tag는 삭제한다. 이 계산은 Call별로 독립적이다.
Bias와 Multiplier는 Address·DataCount와 같은 공통 숫자 Stepper를 사용하되 Bias
음수와 기존 Transform 계산 범위는 유지한다.

## 기존 Job

유효한 단일 고정 LS Call Job은 같은 LS 전용 편집기를 사용한다. 별도 migration은
하지 않는다. 과거 generic 구조나 LS 고정 규칙을 위반한 Job을 자동 변환하지 않는다.

## 오류와 완료 기준

- Call이 없거나 하나라도 고정 Interface·Method·Output 규칙과 다르면
  `JOB_INVALID`으로 거부한다.
- Add, 선택, drag 순서 변경, Call별 입력·Tag 독립성, 마지막 Call 삭제 차단을
  Frontend 테스트로 확인한다.
- Backend 테스트는 다중 유효 Call 허용과 각 index의 잘못된 Call 거부를 확인한다.
- 같은 viewport에서 확정 시안과 실제 화면을 비교하고 DeviceString/DataCount 동일
  너비, Method 식별자, Tags 동일 좌우 margin을 확인한다.
- 전체 Frontend·Backend·제품 테스트와 기본 generic build를 통과해야 한다.

## 승인

2026-08-13 사용자가 Product Design master-detail 시안을 선택하고, Method 식별자 복원,
DeviceString/DataCount 동일 너비, Tags 동일 좌우 margin 수정안을 확인한 뒤
“확정”으로 승인했다.
