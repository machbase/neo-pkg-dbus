# 최종 Backend 보완 보고서

## 변경 내용

- `reviewRequired: true`인 Method의 PUT/DELETE를 Backend 잠금 안에서 다시 확인하고 `DBUS_METHOD_REVIEW_REQUIRED`로 거부한다.
- PUT `/dbus-method`는 바깥 `methodId`와 안쪽 `method.id`를 모두 요구한다. 안쪽 ID가 없거나 둘이 다르면 HTTP 400 `DBUS_METHOD_INVALID`로 거부한다.
- GET/DELETE `/dbus-interface` query는 `id`만, DELETE `/dbus-method` query는 `interfaceId`, `methodId`만 허용한다. 필수값 누락과 알 수 없는 query는 각각 `DBUS_INTERFACE_INVALID`, `DBUS_METHOD_INVALID`로 거부한다.
- 큰 body와 큰 query는 기존 HTTP 413 `REQUEST_TOO_LARGE`를 유지한다.
- `DBUS_METHOD_REVIEW_REQUIRED`의 HTTP 상태를 충돌 의미인 409로 고정했다.

## 테스트 우선 확인

- 수정 전 회귀 테스트에서 Method ID 불일치가 성공하고, 검토 필요 Method가 수정되며, query 누락이 `REQUEST_INVALID`로 나오는 실패를 확인했다.
- 수정 후 manager와 실제 CGI 경계 테스트가 모두 통과했다.
- 일반 HTTP helper 및 다른 기존 Backend endpoint를 포함한 전체 CGI 테스트를 실행했다.

## 검증 결과

- `node cgi-bin/tests/interfaces-api.test.cjs` 통과
- `node cgi-bin/tests/interfaces-cgi-api.test.cjs` 통과
- `node cgi-bin/tests/http.test.cjs` 통과
- `node --test cgi-bin/tests/*.test.cjs` 통과: 82 tests, 82 pass, 0 fail
- `git diff --check` 통과

## 범위

- Backend 구현과 Backend 테스트만 수정했다.
- Interface 저장 DTO 계산은 별도 Frontend 보완 범위이므로 건드리지 않았다.
- 공개 계약 문서는 이미 승인된 오류 코드와 동작을 정의하고 있어 추가 변경하지 않았다.
