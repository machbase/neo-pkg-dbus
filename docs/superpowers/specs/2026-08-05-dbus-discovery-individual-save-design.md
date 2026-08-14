# DBus Discover 단일 선택 저장 설계

## 목표

연결 정보와 경로를 입력해 Discover를 실행한 뒤, 사용자가 Interface 선택 목록에서 하나를 고른다. 화면은 선택한 Interface의 Method 목록을 현재 입력 폼에 자동으로 넣고, footer의 단일 `Save Interface`로 그 입력 폼 하나만 저장한다.

## 현재 문제

이 문서의 초안은 Discover 결과를 카드별로 저장하는 방식을 적었다. 이는 더 이상 현재 설계가 아니다. 이전 `Save All`과 카드별 저장 방식은 [CCR-027](../../specs/DBUS_SDD.md#변경-기록-ccr)에서 대체되었다.

## 확정한 동작

1. Discover는 여러 Interface를 찾지만 저장하지 않는다.
2. 결과는 Interface 선택 목록으로 보인다. 장비 Interface를 먼저 보이고 `org.freedesktop.*`에는 `Standard`를 표시한다.
3. 사용자가 하나를 선택하면 그 Interface와 Method·입력·출력 목록을 현재 입력 폼에 자동 반영한다.
4. 저장 control은 footer의 단일 `Save Interface` 하나다. 새 Interface는 `POST`, 기존 Interface의 다시 Discover 결과는 `PUT /dbus-interface?discover=true`으로 저장한다.
5. Built-in Interface의 읽기 전용 동작과 Interface/Method 서버 검증은 유지한다.

## 화면 흐름

```text
DBus Interfaces → Add/Edit Interface → 연결 정보·경로 입력 → Discover
  → 발견 Interface 선택 목록
    → Interface 하나 선택
      → 선택한 Method 목록을 입력 폼에 자동 반영
        → footer의 Save Interface
```

선택 목록에는 Interface 이름을 보이며, `org.freedesktop.*`에는 `Standard`를 함께 보인다. 선택한 뒤에는 그 Interface의 Method와 입력·출력 파라미터가 입력 폼에 표시된다.

## API와 오류

- 화면은 Discover 결과 배열을 저장 요청으로 보내지 않는다.
- 새 Interface는 `POST /dbus-interface`의 단일 Interface body를 사용한다.
- 기존 Interface에서 다시 Discover한 결과는 `PUT /dbus-interface?discover=true`의 단일 Interface body를 사용한다.
- 저장 실패는 입력 모달 오류로 표시한다.

## 계약 문서 갱신

이 변경은 화면 동작 계약을 바꾸므로 구현과 같은 작업에서 아래 문서를 갱신한다.

- `docs/specs/DBUS_SDD.md`: CCR-027과 Discover 선택·단일 저장 규칙을 기준으로 한다.
- `docs/specs/FE_DESIGN.md`: 선택 목록, 선택 뒤 Method 자동 반영, footer 단일 저장을 명시한다.
- `docs/specs/BE_DESIGN.md`: 새 Interface의 POST와 기존 Interface 재-Discover의 PUT 병합 규칙을 명시한다.

`{interfaces:[...]}` 배열 wrapper와 Save All은 현재 공개 계약과 화면에 존재하지 않는다.

## 테스트 기준

- Discover 뒤 선택 목록에 장비 Interface와 Standard 표기가 보인다.
- Interface 하나를 선택하면 그 Method 목록이 현재 입력 폼에 반영된다.
- 화면과 배포 HTML에 Save All·카드별 저장 control·배열 wrapper 호출이 없다.
- 새 Interface는 POST, 기존 Interface 재-Discover는 discover=true PUT을 사용한다.
