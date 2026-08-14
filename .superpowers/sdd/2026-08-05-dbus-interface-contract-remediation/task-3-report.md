# Task 3 보고서 — 승인 계약과 공개 오류 목록

## 완료 내용

- `DBUS_SDD.md`에 CCR-024를 추가했다. 이전 계약, 새 계약, 이유·근거, 사용자 승인 상태를 모두 기록했다.
- 목록은 참조 상태를 표시하지 않고, Edit/Delete를 누른 뒤 상세 조회의 `references[]`로 차단한다고 SDD와 FE 설계를 맞췄다.
- Built-in View 상세가 Interface와 모든 Method의 입력·출력·검토 필요·참조 정보를 읽기 전용으로 보여 준다고 명시했다.
- 유효한 다른 Method만 참조하는 경우 새 Method 추가와 미참조 Method 변경을 허용하고, `invalidConfig` 또는 신뢰할 수 없는 review-required 상태에서는 모든 Method 변경을 막는 규칙을 SDD/BE/FE에 맞췄다.
- Job 참조 분석은 완전한 Method Call 구조를 확인하고, `DBUS_INTERFACE_INVALID`, `DBUS_METHOD_INVALID`은 HTTP 400 공개 오류 코드라고 SDD/BE/FE에 추가했다.
- review-required 상태 파일이 없을 때와 읽기·JSON 해석 실패일 때를 구분했다. 실패는 `false`로 숨기지 않고 안전하게 `true`로 처리한다.

## 검증

- `git diff --check` 통과
- SDD, FE, BE에서 목록 조회 시점·상세 응답·Method 보호·review-required·공개 오류 코드가 같은 규칙을 가리키는지 `rg`로 확인

## 범위

- 문서 세 파일만 수정했다. 구현 코드와 다른 작업 파일은 변경하지 않았다.

## Fix round 1

- 독립 리뷰의 P1 두 건을 반영했다. SDD의 이전 "어떤 Job 참조" 문구를 Method ID 단위 보호 규칙으로 바꾸고, `POST /dbus-interface`와 `POST /dbus-method` lock 표를 분리했다. Method 생성은 다른 Method의 유효한 참조로 막지 않으며 `invalidConfig` 참조 또는 lock 충돌일 때만 `JOB_CONFLICT`다.
- 독립 리뷰의 P2 한 건을 반영했다. BE 저장 Job 설명에 Method Call 필수 여섯 필드 `id`, `name`, `interfaceId`, `methodId`, `inputs`, `tags`를 모두 적었다.
- 다시 `git diff --check`와 관련 SDD/BE 문구 검색으로 모순이 없는지 확인했다.
