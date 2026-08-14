# 최종 프런트엔드 보완 보고서

## 변경 내용

- 사용자 DBus Interface 편집 저장 요청을 만들 때, 각 Method의 계산 전용 `reviewRequired` 필드를 제거했다.
- 상세 화면의 `reviewRequired` 표시, `reviewRequiredState`에 따른 잠금, Built-in 읽기 전용 화면은 변경하지 않았다.

## 확인

- 먼저 `reviewRequired`가 저장 요청에 포함되는 것을 확인하는 계약 테스트를 추가했다. 수정 전에는 이 테스트가 실패했다.
- 수정 뒤 같은 테스트와 전체 프런트엔드 테스트가 통과했다.
- `npm test`와 `npm run build:root`를 실행했다.

## 완료 기준

- Method가 있는 사용자 Interface를 Edit로 열고 저장해도, 저장 JSON에는 `reviewRequired`가 없다.
- 화면에서는 상세 조회로 받은 `reviewRequired`를 계속 보여 주고 Method 잠금에 계속 사용한다.
