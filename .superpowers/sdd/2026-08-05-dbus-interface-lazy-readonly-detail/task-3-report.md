# Task 3 보고서: Neo 상세 API 500 복구

## 변경 내용

- `InterfaceManager.withReviewRequired()`가 메서드마다 상태 조회를 따로 보호한다.
- `InterfaceStore.reviewRequired()`가 예외를 내면 해당 메서드만 `reviewRequired: false`를 사용한다.
- 인터페이스 문서 조회와 Job 참조 조회에는 예외 처리를 추가하지 않아, 기존 오류 규칙을 그대로 유지한다.
- Built-in `ls-plc-device` 상세에서 상태 조회가 실패해도 상세 데이터가 반환되는 회귀 테스트를 추가했다.

## TDD 증거

1. 테스트 추가 뒤 `node cgi-bin/tests/interfaces-api.test.cjs`를 실행했다.
   - 변경 전에는 `reviewRequired()`의 `neo failure` 예외가 `withReviewRequired()`에서 전파되어 실패했다.
2. 메서드별 안전 기본값을 구현한 뒤 같은 명령을 다시 실행했다.
   - `DBus Interface/Method manager: ok`

## 검증

- `node --test cgi-bin/tests/*.test.cjs`
  - 81개 통과, 0개 실패
- 실제 Neo HTTP 확인은 `http://127.0.0.1:5654/public/neo-pkg-dbus/cgi-bin/api/dbus-interface?id=ls-plc-device`로 시도했다.
  - 이 작업 환경에는 Neo 서버가 실행 중이지 않아 연결할 수 없었다 (`curl: (7)`, HTTP 코드 `000`).
  - 따라서 실제 Neo의 HTTP 200 확인은 이 환경에서는 미확인이다.
