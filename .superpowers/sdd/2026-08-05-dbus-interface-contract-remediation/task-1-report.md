# Task 1 보고서 — 백엔드 참조 판정과 Method 보호

## 완료 내용

- `references.js`가 Job Method Call의 여섯 필드(`id`, `name`, `interfaceId`, `methodId`, `inputs`, `tags`)를 모두 확인한다.
  - `name`은 비어 있지 않은 문자열, `inputs`는 배열이 아닌 객체, `tags`는 배열이어야 한다.
  - 하나라도 맞지 않으면 해당 Job은 `invalidConfig: true` 참조로 반환한다.
  - JSH named import를 사용하지 않고 파일 안의 안전한 검사만 사용한다.
- Job이 Method A만 참조할 때 Method B를 새로 만들 수 있게 했다.
  - 단, 잘못된 Job 참조가 하나라도 있으면 Method 생성은 `JOB_CONFLICT`로 막는다.
- 검토 상태 파일이 없을 때만 빈 목록으로 처리한다.
  - 읽기·JSON·형식 오류가 나면 상세의 모든 Method를 `reviewRequired: true`로 보수적으로 표시한다.
  - Discover 저장은 파일을 읽어 확인한 뒤에만 시작하므로, 오류가 있으면 Interface 파일을 바꾸지 않고 `DBUS_INTERFACE_INVALID`로 실패한다.

## 검증

- `node --test cgi-bin/tests/interfaces-api.test.cjs cgi-bin/tests/jsh-process-compat.test.cjs`
- `node --test cgi-bin/tests/*.test.cjs` — 82개 통과

## 남은 우려

- 없음. 검토 상태 파일이 깨졌을 때의 `true` 표시는 의도적인 안전 우선 동작이다.

## Fix round 1 — 리뷰 P1 보완

- 검토 상태 파일을 읽을 수 없거나 JSON이 손상되면 `createMethod`, `updateMethod`, `deleteMethod`가 잠금을 잡은 뒤 저장 전에 상태 파일을 확인한다.
- 파일이 없을 때는 기존처럼 빈 상태로 허용한다. 그 밖의 오류는 `DBUS_INTERFACE_INVALID`으로 POST·PUT·DELETE를 모두 막는다.
- 손상 JSON과 읽기 권한 오류(`EACCES`) 각각에서 세 변경 요청이 모두 실패하고 원래 Method가 유지되는 테스트를 추가했다.
