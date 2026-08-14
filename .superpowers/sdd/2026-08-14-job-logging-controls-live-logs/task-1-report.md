# Task 1 보고서: 승인된 계약 문서 반영

## 변경

- `DBUS_SDD.md`에 CCR-070을 추가했다. 이전 계약, 새 계약, 변경 이유, 구현 근거, 승인 상태를 기록했다.
- `/log/tail` 공개 응답을 `{name,file,lines,totalLines}`로 바로잡고, `/log/content`와 `/log/content/all`의 `{name,file,content}`와 분리했다.
- `FE_DESIGN.md`에 Job 상세 버튼 순서, Logging Controls, 1초 polling Live Logs, 100줄 제한, Pause/Clear, drag/resize, 오류 복구를 기록했다.
- `BE_DESIGN.md`에 새 endpoint·SSE·WebSocket 없이 기존 `list`와 `tail` JSON API를 유지하는 계약을 기록했다.
- `frontend/tests/app-contract.test.mjs`에 CCR-070과 Live Logs 계약 문구 회귀 검증을 추가했다.

## TDD와 검증

- RED: `node frontend/tests/app-contract.test.mjs`는 새 테스트에서 `CCR-070`이 없어 실패했다.
- GREEN: 같은 명령은 변경 뒤 83개 테스트 전체를 통과했다.
- Generic 기본 빌드: 루트 `npm run build`를 성공시켜 커밋 전 산출물을 Generic으로 복원했다.

## 범위와 주의

- 사용자 변경 `frontend/neo-proxy.json`, `implementation-ls-device-string-picker.png`는 수정하거나 스테이징하지 않았다.
- Live Logs 화면 구현은 다음 작업의 범위이며, 이 작업은 승인된 문서 계약과 회귀 검증만 포함한다.

## Fix round 1 (C1, I1, I2)

- `/log/content`를 페이지 응답 `{name,file,page,linesPerPage,totalLines,lines,nextPage,previousPage}`로, `/log/content/all`을 전체 본문 응답 `{name,file,size,content}`로, `/log/tail`을 `{name,file,lines,totalLines}`로 세 계약 문서에서 분리했다.
- 세 endpoint의 URL은 모두 필수 `name`, `file`을 포함하게 맞췄고, `/log/content`의 선택 `page`, `lines`와 `/log/tail`의 선택 `lines`도 기록했다. 승인된 `tail`의 필수 `file` 계약은 유지했다.
- RED: 강화한 `frontend/tests/app-contract.test.mjs`가 `/log/content`의 URL·응답 계약 부재로 실패했다.
- GREEN: `node frontend/tests/app-contract.test.mjs` 83개와 `node cgi-bin/tests/log-api.test.cjs`가 통과했다. CGI 테스트는 세 reader 응답의 정확한 최상위 필드 집합도 확인한다.
