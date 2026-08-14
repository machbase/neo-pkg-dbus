# 최종 삭제 화면 보완 보고서

## 변경 내용

- 목록에서는 참조·검토 상태를 표시하지 않는다.
- 사용자 Interface의 Delete를 누르면 항상 최신 상세를 다시 읽는다.
- 최신 상세의 `reviewRequiredState`가 `unavailable`이면 삭제 확인 창을 열지 않고 이유를 표시한다.
- 최신 상세의 Method 중 하나라도 `reviewRequired: true`이면 삭제 확인 창을 열지 않고 이유를 표시한다.
- Built-in Interface의 Delete 비활성 동작은 바꾸지 않았다.

## 검증

- `npm test` 통과: 23개 화면 계약 테스트와 4개 빌드 계약 테스트 통과.
- `npm run build:root` 통과: index, main, side 단일 파일 빌드 생성.
- 새 테스트는 두 검토 차단 경우 모두 최신 상세 GET 1회, 삭제 확인 창 미표시, 이유 표시를 확인한다.
