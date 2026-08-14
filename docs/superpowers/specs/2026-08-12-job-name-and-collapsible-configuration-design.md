# Job 기본 이름과 접이식 Configuration 설계

> 2026-08-13 대체 기록: 이 문서의 이름 제안 규칙은 유지한다. 화면 안에서 접고 펼치는 Job Configuration 규칙만 `DBUS_SDD.md` CCR-058의 읽기 전용 요약 카드 + `Edit Job Configuration` 모달로 대체한다. 모달은 별도 draft를 사용하고 Apply만 반영하며 Cancel·닫기·바깥 클릭·Esc는 버린다.

## 목표

새 Job 화면이 비어 있는 이름 입력부터 시작하지 않게 하고, 자주 바꾸지 않는 실행 설정은 기본적으로 접어 화면 길이를 줄인다. 별도 Backend counter나 새 API는 만들지 않는다.

## 새 Job 이름

- 새 Job 화면은 이미 `AppProvider`가 읽은 Job 목록을 사용한다.
- 이름이 정규식 `^job-([1-9][0-9]*)$`와 일치할 때만 자동 번호 계산에 포함한다.
- 가장 큰 `N`에 1을 더한 `job-(N+1)`을 제안한다. 해당 항목이 하나도 없으면 `job-1`이다.
- `collector-a`, `job-a`, `job-0`, `job-01`은 번호 계산에서 제외한다.
- 중간 번호가 비어 있어도 재사용하지 않는다. `job-1`, `job-3`이 있으면 다음 이름은 `job-4`다.
- Job 목록을 새로 요청하지 않고 현재 화면 목록을 사용한다. direct URL 진입에서는 최초 Job 목록 읽기가 끝난 뒤 한 번만 이름을 채운다.
- 목록 갱신은 사용자가 입력 중인 이름을 덮어쓰지 않는다.
- 동시에 열린 화면이 같은 이름을 제안할 수 있으며, 저장 시 기존 `JOB_ALREADY_EXISTS`가 최종 충돌을 막는다.
- 이 이름은 FE의 편의 기본값이다. Backend 이름 규칙과 POST 계약은 바꾸지 않는다.

## Job Configuration 접힘

- New Job과 Edit Job 모두 Job Configuration을 기본적으로 접는다.
- 접힌 summary는 왼쪽에 `JOB CONFIGURATION`, 오른쪽에 다음 현재 draft 값을 표시한다.
  - Job Name
  - `<intervalMs> ms`
  - `savePolicy`
- summary 값은 별도 form control이 아닌 읽기 전용 텍스트다.
- 펼치면 기존 여섯 control을 그대로 표시한다: Job Name, Run Interval, Retry Initial, Retry Maximum, Retry Multiplier, Save Policy.
- 새 Job의 Job Name은 펼친 상태에서 수정할 수 있다. Edit Job의 이름은 기존 계약대로 비활성·변경 불가다.
- 펼친 상태에서 값을 바꾸고 다시 접으면 summary는 현재 draft 값을 즉시 반영한다.
- 접기와 펼치기는 저장 payload를 바꾸지 않는다. Database 접힘 동작도 그대로 유지한다.
- disclosure control은 `aria-expanded`와 명확한 Toggle label을 제공하고 키보드로 조작할 수 있어야 한다.

## 구현 경계

- 순수 모델 함수가 현재 Job 목록으로 다음 기본 이름을 계산한다.
- `JobForm`은 새 Job route의 첫 안정된 목록에만 기본 이름을 적용한다.
- Job Configuration은 Database 섹션과 같은 panel disclosure 패턴을 쓴다.
- Backend, 저장 schema, API envelope, service name은 수정하지 않는다.
- generic과 LS 제품은 같은 공통 Job Form을 사용하므로 동작도 같다.

## 오류와 경쟁

- Job 목록 조회가 실패하면 기존 화면 오류를 유지하며 잘못된 번호를 새로 계산하지 않는다.
- 제안된 이름이 저장 직전에 다른 사용자가 만들었다면 Backend의 `JOB_ALREADY_EXISTS`를 그대로 표시한다.
- 자동 제안 뒤 사용자가 이름을 바꾸면 이후 목록 refresh가 그 값을 되돌리지 않는다.

## 검증

- 빈 목록, 연속 번호, 중간 번호 누락, 다른 형식의 이름이 섞인 목록을 모델 테스트로 확인한다.
- New Job이 목록 로딩 뒤 기본 이름을 한 번만 적용하고 사용자 입력을 보존하는지 확인한다.
- New/Edit Job의 Configuration이 기본 접힘인지 확인한다.
- 접힌 summary가 이름·Run Interval·Save Policy를 표시하고 펼친 control 변경을 반영하는지 확인한다.
- Edit Job Name이 계속 변경 불가인지 확인한다.
- 전체 frontend 테스트와 generic/LS 제품 테스트, 최종 인자 없는 generic build를 실행한다.

## 승인

- 2026-08-12 사용자 승인: 실제 이름은 `job-1` 형식을 사용한다.
- 2026-08-12 사용자 승인: 별도 last 저장 없이 현재 목록의 가장 큰 `job-N` 다음 번호를 사용한다.
- 2026-08-12 사용자 승인: Job Configuration은 Database처럼 기본 접힘이고 summary에 Job Name, Run Interval, Save Policy를 표시한다.
