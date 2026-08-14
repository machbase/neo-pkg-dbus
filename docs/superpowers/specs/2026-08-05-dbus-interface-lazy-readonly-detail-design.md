# DBus Interface 지연 상세·Built-in 읽기 전용 상세 설계

## 목적

DBus Interface 목록 모달은 목록 API만 사용한다. 사용자가 **Edit DBus Interface**를 누를 때만 상세 API를 호출한다. Built-in Interface도 같은 Edit 동작으로 상세를 볼 수 있지만, 값 변경과 저장·삭제는 할 수 없다.

## 승인된 동작

1. 모달을 열면 `GET /dbus-interface/list`만 호출한다.
2. 목록 행을 선택해도 상세 API를 호출하지 않는다. 선택은 시각 표시만 바꾼다.
3. `Edit DBus Interface`를 누르면 `GET /dbus-interface?id=<id>`를 한 번 호출한 뒤 입력 모달을 연다.
4. 사용자 Interface의 입력 모달은 기존처럼 수정·저장할 수 있다.
5. Built-in Interface의 입력 모달은 모든 필드, Discover, Save Interface, Save All을 읽기 전용 또는 비활성으로 표시한다. Method·입출력 값과 참조 상태는 볼 수 있다.
6. Built-in Interface의 Delete는 목록에서 계속 비활성이다.
7. 상세 API는 Built-in Interface에도 `HTTP 200`과 계약상 전체 상세 응답을 돌려야 한다. `Value is not an object: undefined` 500은 허용하지 않는다.

## API와 오류 처리

공개 API 형식은 바꾸지 않는다. `GET /dbus-interface?id=`의 응답은 `DBUS_SDD.md` 4.1을 그대로 따른다.

상세 응답을 만들 때 선택 상태 파일 또는 계산된 `reviewRequired`를 읽지 못해도, 읽기 실패가 Interface 상세 전체를 500으로 만들면 안 된다. Backend는 실패 원인을 서버 진단에 남기고, 안전한 기본값 `reviewRequired: false`로 상세 응답을 완성한다. 단, Interface 문서 자체가 잘못되어 읽을 수 없는 경우의 기존 `DBUS_INTERFACE_INVALID` 규칙은 유지한다.

## 화면 흐름

```text
목록 모달 열기 → list API → 행 선택(네트워크 없음)
                         ↓
                  Edit 클릭 → detail API → 사용자 편집 / Built-in 읽기 전용 상세
```

상세 요청 중 모달을 닫으면 기존 큐 취소 규칙을 적용한다. 상세 요청 실패 시 입력 모달을 열지 않고 오류를 목록 모달에 표시한다.

## 확인 기준

- 목록 열기와 행 선택에서 상세 API가 0회다.
- 사용자 Edit는 상세 API 성공 뒤 편집 가능 입력 모달을 연다.
- Built-in Edit는 상세 API 성공 뒤 읽기 전용 상세 입력 모달을 연다.
- Built-in Delete는 비활성이다.
- Built-in 상세 API가 Neo 서버에서 HTTP 200을 반환한다.
- 기존 프런트엔드·CGI 테스트와 LS 포함 빌드가 통과한다.
