# LS DeviceString 주소 선택기 Design QA

- source visual truth path: `/Users/trycatch/.codex/generated_images/019fcf6b-8066-7a13-b989-003aa0197687/exec-8e385a6a-fa57-4545-9750-942ed8bcd6d2.png`
- implementation screenshot path: `/Users/trycatch/.codex/worktrees/1ff7/neo-pkg-dbus/implementation-ls-device-string-picker.png`
- viewport: 1280 × 720 CSS px, deviceScaleFactor 1
- source pixels: 1486 × 1058
- implementation pixels: 1280 × 720
- normalization: 전체 화면의 크기 차이는 제외하고 Method Calls의 DeviceString 입력·팝오버 영역을 같은 상태로 확대 비교했다.
- state: LS New Job, 첫 Method Call 선택, DeviceString 주소 선택기 열림

## Full-view comparison evidence

- 공통 화면의 어두운 surface, panel border, 입력 높이와 글꼴은 기존 DESIGN.md 토큰을 유지한다.
- DeviceString과 DataCount는 실제 측정값이 각각 288.5px로 같다.
- 두 입력 사이 간격은 16px이며 Method Calls master-detail 구조는 기존과 같다.
- 팝오버는 DeviceString과 같은 x 좌표와 288.5px 너비를 사용한다.
- 팝오버는 `position:absolute`이며 선택기 open 전후 Tags의 문서 흐름을 바꾸지 않는다.
- 바깥 DeviceString 본문은 `readonly`이고 팝오버 아래 완성 주소 입력만 직접 수정된다.
- 새 Call은 바깥에 `MB0`을 표시하고 읽기 전용 본문과 화살표 어느 쪽을 눌러도 팝오버가 열린다.

## Focused region comparison evidence

- 팝오버 내부 computed grid track은 `87.25px 87.25px 72px`이다. Memory Area와 Data Type은 남은 공간을 같은 너비로 사용하고 Address는 72px 고정이다.
- preview는 팝오버의 12px 내부 여백을 제외한 전체 너비 262.5px다.
- Memory Area와 Data Type 후보 목록을 차례로 열었을 때 한 목록만 표시되며, 각각 `A/F/I/Q/M/K/R/W`, `X/B/W/D/L` 전체 후보가 보인다.
- Address는 `type=number`, `min=0`, `step=1`이고 DataCount는 `min=1`이다. 두 입력 모두 네이티브 spinner를 숨기고 공통 위·아래 아이콘 control을 표시한다.
- 완성 주소 입력에 `%MW10`을 넣고 Apply한 뒤 바깥 화면값은 `MW10`, Tag는 `MW10`, 팝오버는 닫혔다.
- Esc 닫기와 팝오버 안 직접 키보드 입력 경로를 확인했다.
- 브라우저 console error/warning은 0건이다.

## Required fidelity surfaces

- Fonts and typography: 기존 앱 글꼴, 크기, 굵기 계층을 재사용했고 선택기 라벨은 `Memory Area`, `Data Type`, `Address`로 통일했다.
- Spacing and layout rhythm: 12px 팝오버 안쪽 여백, 8px 내부 grid gap, 16px 상위 입력 gap을 사용한다. 입력·팝오버 너비와 overlay 동작은 요구값과 일치한다.
- Colors and visual tokens: 새 임의 색상을 추가하지 않고 `--neo-panel`, `--neo-input-surface`, `--neo-border`, `--neo-primary`를 사용한다.
- Image quality and asset fidelity: 이 화면에는 별도 raster asset이 없고 기존 Material icon만 사용한다.
- Copy and content: 고정 `%`, Memory Area, Data Type, Address, preview, Apply를 표시하고 별도 Mouse/Keyboard 모드 문구는 두지 않는다.

## Findings

- P0/P1/P2 없음.
- P3: source와 구현 viewport가 달라 전체 카드 폭은 다르지만, 사용자가 확정한 핵심 비율과 동작은 실제 CSS 측정으로 일치했다.

## Comparison history

1. 초기 구현 테스트에서 복합 컴포넌트와 내부 input의 같은 접근성 이름 때문에 입력 이벤트 대상이 중복됐다.
2. 복합 컴포넌트의 이름 prop을 DOM으로 전달하지 않고 실제 input만 `aria-label`을 갖도록 수정했다.
3. 후보 설정 객체를 고정해 닫힌 상태의 draft 동기화가 불필요하게 반복되지 않도록 했다.
4. 수정 후 component test, 전체 frontend/backend/product test와 브라우저 상호작용을 다시 실행해 통과했다.

## Implementation checklist

- [x] LS 전용 주소 선택기
- [x] 바깥 읽기 전용 표시와 팝오버 안 직접 입력 분리
- [x] 새 Call 기본값 MB0과 입력 본문 클릭 열기
- [x] Address 숫자 spinner
- [x] Address 기본값 0과 DataCount 최소값 1
- [x] 공통 위·아래 숫자 화살표
- [x] 전체 LS Memory Area·Data Type 후보
- [x] Method Call 전체 행 hover와 공통 Add/Test 버튼
- [x] DeviceString/DataCount 동일 너비
- [x] DeviceString과 같은 너비의 absolute popover
- [x] Memory Area/Data Type 동일 비율, Address 고정 너비
- [x] 후보 목록 하나만 열림
- [x] preview와 Apply
- [x] generic 제품 미적용
- [x] 저장·호출값의 `%` 계약 유지

final result: passed

---

# Job 상세 Overview 카드 Design QA

- source visual truth path: `/var/folders/48/f1sntm9979q0l9lz04xl33x80000gn/T/codex-clipboard-69bbb107-4a04-45b7-ae14-1297ddf1f715.png`
- implementation URL: `http://127.0.0.1:5176/?qa=ccr060#/jobs/job-1`
- viewport: 1266 × 885 CSS px
- state: 실행 중인 LS Job 상세, Method Call 2개, 마지막 cycle 성공

## 비교 결과

- 참고 화면처럼 상단을 같은 너비의 3개 bordered card로 구성했다.
- 기존 `CONFIG` 단독 지표는 제거했다.
- `JOB` 카드에는 상태·Interval·Save Policy를, 가운데 카드에는 Method Call 수를, `DATABASE` 카드에는 Server·Table·두 Column을 합쳐 표시한다.
- 카드 높이, 안쪽 여백, 경계선, 배경, 제목 계층은 기존 `DESIGN.md` token만 사용한다.
- 실행 중 화면에서 `LAST SUCCESSFUL`과 `LAST STORED`가 5초 polling에 따라 실제로 갱신되는 것을 확인했다.
- Method별 `Stored` 문구는 누적값으로 오해하지 않도록 `Rows saved`로 변경했다.
- 1266px desktop에서는 3열을 유지하고, 작은 화면에서는 기존 media query에 따라 1열로 전환한다.

## Findings

- P0/P1/P2 없음.
- 참고 이미지는 OPC UA 화면의 부분 crop이므로 글자 내용은 복제하지 않고, 3카드 정보 구조와 시각 밀도만 DBus Job 상세 계약에 맞춰 적용했다.

final result: passed
