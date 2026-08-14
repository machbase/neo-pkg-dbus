# 최종 재리뷰 P1 보완 — DBus 입력 오류 코드

## 수정 내용

- `POST`·`PUT /dbus-interface`의 JSON body·요청 객체 형식 오류를 HTTP 400 `DBUS_INTERFACE_INVALID`으로 반환한다.
- `POST`·`PUT /dbus-method`의 JSON body·요청 객체 형식 오류를 HTTP 400 `DBUS_METHOD_INVALID`으로 반환한다.
- Interface, Method, Parameter 객체에 계약에 없는 필드가 있으면 해당 오류 코드로 거부하고 저장하지 않는다.
- 공통 HTTP 도우미와 다른 endpoint의 `REQUEST_INVALID` 동작은 변경하지 않았다.

## 회귀 확인

- `node cgi-bin/tests/interfaces-cgi-api.test.cjs` 통과
  - Interface POST/PUT 배열 body·알 수 없는 필드 → 400 `DBUS_INTERFACE_INVALID`
  - Method POST/PUT 잘못된 body·알 수 없는 필드 → 400 `DBUS_METHOD_INVALID`
  - 알 수 없는 Interface field 뒤 상세 GET은 404이고, 알 수 없는 Method field 뒤 Method 수는 0이라 저장되지 않음을 확인
- `node cgi-bin/tests/interfaces-api.test.cjs` 통과
- `git diff --check` 통과

## 전체 CGI 테스트 참고

`cgi-bin/tests/*.test.cjs` 전체 실행 중 `dbus-call.test.cjs`만 실패했다. 현재 작업 폴더의 미추적 LS 빌드 산출물 `cgi-bin/interfaces.d/ls-plc-device.json`이 테스트가 임시로 만드는 같은 ID의 Interface와 겹쳐 중복 Interface 오류가 난다. 이번 변경 파일이나 입력 오류 코드와는 관계가 없으며, 산출물 정리는 별도 작업이다.

## Fix round 1 — 최종 재리뷰 P1 보완

- Save All `POST /dbus-interface` wrapper는 정확히 `{interfaces}`만 허용한다. 알 수 없는 바깥 field는 HTTP 400 `DBUS_INTERFACE_INVALID`으로 거부한다.
- Method wrapper는 HTTP method별로 구분한다.
  - POST: 정확히 `{interfaceId, method}`
  - PUT: 정확히 `{interfaceId, methodId, method}`
  - 알 수 없는 field, POST의 `methodId`, PUT의 누락 `methodId`는 HTTP 400 `DBUS_METHOD_INVALID`이다.
- 두 endpoint 모두 body가 최대 크기를 넘으면 `REQUEST_TOO_LARGE`를 다시 감싸지 않는다. 따라서 기존 HTTP 413과 오류 코드를 그대로 유지한다.

### 재검증

- `node cgi-bin/tests/interfaces-cgi-api.test.cjs` 통과
- `node cgi-bin/tests/interfaces-api.test.cjs` 통과
- `node cgi-bin/tests/jsh-process-compat.test.cjs` 통과
- `find cgi-bin/tests -maxdepth 1 -type f -name '*.test.cjs' -print0 | sort -z | xargs -0 -n 1 node` 전체 통과
- `git diff --check` 통과
