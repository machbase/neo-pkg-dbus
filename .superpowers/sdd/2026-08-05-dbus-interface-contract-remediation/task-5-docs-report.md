# Task 5 문서 작업 보고서

## 변경한 계약

- `GET /dbus-interface?id=` 성공 `data`의 최상위 필수 필드로 `reviewRequiredState: "available"|"unavailable"`을 추가했다.
- 상태 파일이 없거나 정상적으로 읽히면 `available`이다.
- 상태 파일을 읽거나 JSON으로 해석하지 못하면 `unavailable`이며, 읽기 전용 상세는 계속 반환하고 모든 Method의 `reviewRequired`는 `true`다.
- FE는 `available`일 때만 `reviewRequired: true`인 Method를 막고, `unavailable`이면 새 Method·수정·삭제를 모두 막고 이유를 보여 준다.

## 문서 일치

- `DBUS_SDD.md` 4.1의 유일한 상세 응답 표에 필드와 값의 뜻을 추가했다.
- `DBUS_SDD.md` CCR-025에 이전 계약, 새 계약, 이유, 영향 범위, 확인 방법, 사용자 승인 상태를 기록했다.
- `FE_DESIGN.md`와 `BE_DESIGN.md`가 같은 SDD 상세 응답 계약을 따르도록 갱신했다.

## 확인

- `git diff --check` 통과.
