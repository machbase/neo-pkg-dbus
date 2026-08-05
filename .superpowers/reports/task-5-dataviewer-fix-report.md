# Task 5 DataViewer 역할 column 수정 보고서

## 변경 내용

- TAG metadata FLAG의 `primaryKey`와 `basetime`을 해석하는 공용 `roleColumn` helper를 추가했다.
- `/db/table/tags`, `/db/table/data`, `/db/table/chart`가 모두 helper를 사용해 실제 primary/basetime column을 자동 감지한다.
- 요청의 `primaryColumn` 또는 `timeColumn`이 있으면 해당 FLAG 역할인지 Backend에서 검증한다.
- metadata에서 얻은 column 이름도 SQL identifier 규칙으로 검증해 SQL 조합 전에 안전성을 확인한다.
- FE는 column 이름을 보내지 않고 Backend 자동 감지 계약을 계속 사용한다.

## 회귀 검증

- TAG_ID(primary key)와 TS(basetime) fixture에서 tags, grid, chart SQL과 응답을 검증했다.
- 잘못 요청한 primary/time 역할 column은 `DB_REQUEST_INVALID`로 거부되는지 검증했다.
- 기존 NAME/TIME fixture도 그대로 통과한다.

## 실행 결과

- `node cgi-bin/tests/data-viewer-api.test.cjs` 통과
- `node --test cgi-bin/tests/*.test.cjs` 통과 (61 passed)
- `git diff --check` 통과

## 범위

- 수정: `cgi-bin/src/db/data-viewer.js`
- 수정: `cgi-bin/tests/data-viewer-api.test.cjs`
- 수정: `docs/specs/DBUS_SDD.md`
- stage, commit, frontend 변경은 하지 않았다.
