# 마지막 프런트엔드 보완 보고서

## 변경 내용

- Method 수정 시작 시 상세 조회 전용 계산 필드인 `reviewRequired`를 수정 초안에서 뺐다.
- `inputs`, `outputs`와 각 입력·출력의 `validation`은 그대로 보존한다.
- 따라서 Method 수정 저장 요청은 Backend가 허용하는 Method 구조만 보내며, `DBUS_METHOD_INVALID`가 나지 않는다.

## 테스트

- 먼저 `reviewRequired`가 포함된 Method를 수정·저장하는 실패 테스트를 추가했다. 수정 전에는 저장 요청에 해당 필드가 남아 실패했다.
- 수정 뒤 같은 테스트가 통과했고, `validation` 보존도 확인했다.
- `npm test`와 `npm run build:root`를 모두 통과했다.

## 범위

- 프런트엔드의 `DbusMethodEditor`와 계약 화면 테스트, 생성된 화면 파일만 변경했다.
