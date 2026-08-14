# DBus Interface 모달 관리 설계

## 목적

사용자가 DBus Interface를 Database Servers와 같은 흐름으로 관리한다. Side의 `New DBus Interface`는 현재 Job 화면을 떠나지 않고 목록 모달을 열며, 목록에서 추가·수정·삭제와 Method 관리를 할 수 있다.

이 설계는 이미 확정된 `DBUS_SDD.md` CCR-007과 `FE_DESIGN.md`의 DBus Interface 관리 약속을 구현하는 것이다. 공개 API, 저장 형식, 잠금 순서, built-in 보호 규칙은 바꾸지 않는다.

## 사용자 흐름

```text
Side New DBus Interface
  → DBus Interfaces 목록 모달
    → Add Interface / Edit Interface
      → Interface 입력 모달
        → Discover 또는 직접 입력
          → Save / Save All
    → Delete Interface 확인 모달
```

모달을 닫거나 취소·Esc·바깥 영역 클릭을 해도 현재 route와 Job 편집 중인 내용은 바꾸지 않는다.

## 화면 구성

### 1. DBus Interfaces 목록 모달

- 제목은 `DBus Interfaces`, 아이콘은 기존 `account_tree`를 쓴다.
- 각 행에는 Interface 이름, `busType`, `destination`, `objectPath`, Method 수, Built-in/User 상태를 표시한다.
- `org.freedesktop.*` Interface에는 `Standard` 뱃지를 표시한다.
- 사용자 Interface 행에는 Edit와 Delete 아이콘 버튼을 둔다.
- built-in LS PLC Interface는 `Built-in · Read only`로 표시하고 Edit·Delete를 제공하지 않는다.
- 참조 중인 사용자 Interface는 Edit·Delete를 disabled로 표시하고 참조 Job 이름을 title 또는 보조 문구로 알린다.
- 하단에는 Close와 Add Interface 버튼을 둔다.
- 목록이 비어 있으면 `No DBus Interfaces configured.` 상태 문구와 Add Interface 버튼을 보여 준다.

Database Servers 목록 모달의 표면, 행 높이, 아이콘 버튼, footer와 확인 모달을 그대로 재사용한다. `DESIGN.md` 밖의 색·간격·모서리 값은 추가하지 않는다.

### 2. Interface 입력 모달

- Add에서는 Bus Type, Destination, Object Path, Interface ID, Interface Name을 입력한다.
- Edit에서는 Interface ID를 읽기 전용으로 하고 나머지 주소와 이름은 편집한다.
- Discover를 누르면 현재 Bus Type·Destination·Object Path의 결과를 저장 없이 표시한다.
- Discover 결과는 Interface와 모든 Method·입력·출력을 펼쳐 표시한다. `org.freedesktop.*`는 Standard 뱃지를 붙인다.
- Save All은 Discover 결과 전체를 기존 `POST /dbus-interface` bulk API로 저장한다.
- Discover를 쓰지 않는 직접 입력은 현재 입력한 Interface 하나를 기존 `POST /dbus-interface` 또는 `PUT /dbus-interface`로 저장한다.
- 저장 성공 뒤 목록을 다시 읽고 입력 모달을 닫아 목록 모달로 돌아간다.

### 3. Method 관리

- 목록 행을 선택하면 같은 목록 모달 안에 해당 Interface의 Method 목록을 펼친다.
- 사용자 Interface에는 Add Method, Edit Method, Delete Method를 제공한다.
- Method가 Job에서 참조되면 기존 API 계약에 맞춰 수정·삭제를 disabled로 하고 참조 Job을 보여 준다.
- built-in Interface와 그 Method는 읽기 전용이다.
- Method 입력·출력 파라미터 편집은 기존 Method editor의 필드와 검증을 재사용한다. 새 DBus type이나 새 저장 구조를 만들지 않는다.

## 상태와 오류 처리

- 목록·상세·저장·삭제 실패는 해당 모달의 `Notice` 오류 영역에 API의 reason을 표시한다.
- `DBUS_INTERFACE_IN_USE`, `DBUS_METHOD_IN_USE`, `JOB_CONFLICT`는 오류를 숨기거나 재시도하지 않는다.
- API가 반환한 references가 하나라도 있으면 FE는 mutation 버튼을 선제적으로 disabled 처리한다. 동시에 Backend의 최종 검증을 신뢰한다.
- Discover 실패는 입력값과 Discover 결과를 지우지 않는다. 사용자는 값을 고쳐 다시 Discover하거나 직접 저장할 수 있다.
- 성공 후 `resourceChanged()`를 호출해 Job form의 Interface 선택 목록도 최신 상태로 갱신한다.

## 컴포넌트 경계

| 컴포넌트 | 책임 |
|---|---|
| `DbusInterfacesModal` | 목록, 선택된 Interface 상세, 목록 갱신, Add/Edit/Delete 전환 |
| `DbusInterfaceFormModal` | 주소·이름 입력, Discover, 직접 저장, Save All |
| `DbusInterfaceDeleteConfirmModal` | 삭제 대상 확인 |
| `DbusMethodEditor` | 선택 Interface의 Method 추가·수정·삭제 |
| `CreateModalLayer` | `dbus-interface` 요청을 목록 모달로 연결 |

기존 `InterfacesPage`, `/interfaces` route, PageNav의 `DBus Interfaces` 링크는 제거한다. DBus Interface 관리는 Side의 `New DBus Interface`에서만 시작한다. 이로써 현재 Job 화면을 유지한다는 계약을 한 가지 흐름으로 지킨다.

## API 매핑

| 화면 동작 | API |
|---|---|
| 목록 | `GET /dbus-interface/list` |
| 선택 상세·references | `GET /dbus-interface?id=` |
| Discover | `POST /dbus-interface/discover` |
| 직접 생성·Save All | `POST /dbus-interface` |
| Interface 수정 | `PUT /dbus-interface` |
| Interface 삭제 | `DELETE /dbus-interface?id=` |
| Method 생성·수정·삭제 | `POST`·`PUT`·`DELETE /dbus-method` |

## 완료 기준

1. Side에서 목록 모달을 열고 현재 화면을 유지한다.
2. 사용자 Interface는 Add·Edit·Delete 및 Method 관리가 가능하다.
3. Discover와 Save All, 직접 입력 저장이 기존 API payload로 동작한다.
4. built-in 및 참조 중 Interface/Method는 수정·삭제할 수 없고 이유가 보인다.
5. 저장·삭제 뒤 목록과 Job form의 Interface 선택 목록이 갱신된다.
6. 모달 접근성(aria-label, Esc, Close, disabled, 오류 `role=alert`)과 `DESIGN.md` 토큰을 지킨다.
7. 프런트엔드 API·상태·렌더링 테스트와 기존 전체 테스트가 통과한다.
