# DBus Discover 단일 선택 저장 계획 (대체됨)

이 문서는 2026-08-05에 작성한 카드별 저장 계획이다. 아래의 `Save All` 제거 뒤 카드별 `Save Interface`를 두는 내용은 현재 계획으로 사용하면 안 된다.

현재 기준은 [DBUS_SDD.md CCR-027](../../specs/DBUS_SDD.md#변경-기록-ccr)이다.

## 현재 확정 흐름

1. 사용자가 Bus Type, Destination, Object Path를 입력한다.
2. `Discover`가 장비의 Interface 목록을 가져오지만 저장하지 않는다.
3. 사용자는 선택 상자에서 Interface 하나를 고른다.
4. 선택한 Interface의 Method와 입력·출력 목록을 현재 입력 폼에 자동 반영한다.
5. footer의 단일 `Save Interface`가 현재 입력 폼 하나만 저장한다.
   - 새 Interface: `POST /dbus-interface`
   - 기존 Interface의 다시 Discover: `PUT /dbus-interface?discover=true`

화면·배포 HTML·공개 계약에는 Save All, Discover 카드별 저장 control, `{interfaces:[...]}` 배열 저장 wrapper가 없다.

## 완료 기록

- [x] Discover 결과를 Interface 선택 목록으로 제공한다.
- [x] 선택한 Interface의 Method를 현재 입력 폼에 자동 반영한다.
- [x] Save All과 카드별 저장 control을 제거한다.
- [x] 새 Interface POST와 기존 Interface 재-Discover PUT을 분리한다.
- [x] 배포 HTML에서 제거된 일괄 저장 코드가 없는지 회귀 테스트로 확인한다.
