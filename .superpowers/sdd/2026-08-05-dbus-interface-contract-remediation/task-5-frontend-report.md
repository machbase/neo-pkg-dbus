# Task 5 frontend report

## 변경 사항

- 상세 응답의 `reviewRequiredState`가 `unavailable`이면 새 Method, Method 수정, Method 삭제를 모두 비활성화했다.
- `available`이면 기존처럼 `reviewRequired: true`인 Method만 비활성화한다.
- Built-in 읽기 전용 상세를 포함한 Method 영역에 검토 상태를 표시한다.
- 상태를 읽지 못한 경우에는 사용자가 이해할 수 있는 차단 이유를 버튼과 상태 메시지에 표시한다.

## 확인

- `frontend`에서 `npm test` 통과: 23개 테스트 통과.
- `frontend`에서 `npm run build:root -- --with-ls-interface` 통과.
- 빌드가 만든 HTML과 임시 Interface 산출물은 커밋하지 않았다.
