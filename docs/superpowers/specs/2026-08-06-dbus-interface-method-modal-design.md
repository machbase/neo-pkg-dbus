# DBus Interface Method 모달과 참조 보호 설계

## 목적

DBus Interface 목록 화면 아래의 Methods 편집 영역을 없앤다. Interface 생성·수정 모달 안에서만 별도 Method 모달을 열어 많은 Method를 스크롤하며 확인·관리한다.

## Discover 화면 흐름

1. 처음에는 Name, Bus Type, Destination, Object Path와 Discover만 보인다.
2. Destination과 Object Path는 같은 행에 둔다.
3. Discover가 성공한 뒤에만 Discovered Interface 선택 상자를 보인다.
4. `Direct input`을 선택했을 때만 그 아래에 Interface 입력을 보인다.
5. 실제 발견 Interface를 선택하면 `Methods (N)` 버튼을 보인다. 버튼은 별도 모달을 열며, 자동 발견한 Method의 이름·ID·source·입력·출력을 읽기 전용으로 보여 준다.

DBus 표준 Introspection이 성공하면 한 Object Path의 Interface와 각 Interface의 Method 구조를 함께 얻는다. Introspection을 쓸 수 없으면 자동 Interface 목록과 Method 목록을 모두 얻지 못하며, 이때만 Direct input으로 Interface와 Method를 직접 정의한다.

## Method 모달

- 목록 화면에서 행을 선택해도 아래에 Method 목록이나 편집기는 나타나지 않는다.
- 새 Interface의 발견 Method는 저장 전에도 Method 모달에서 전체를 볼 수 있다.
- Method가 많아도 모달 본문만 스크롤한다.
- 자동 발견 Method는 사용자가 직접 추가·수정·삭제하지 않는다. 최신 상태가 필요하면 Interface를 다시 Discover한다.
- Direct input으로 직접 만든 Interface와 `source: "manual"` Method는 같은 모달에서 추가·수정·삭제한다.
- Job이 하나라도 Interface를 참조하면 직접 만든 Interface와 manual Method도 추가·수정·삭제할 수 없다.

Interface 문서는 이 구분을 보존하기 위해 `origin: "discovered"|"manual"`을 가진다. Discover 선택 저장은 `discovered`, Direct input 저장은 `manual`이다. `origin: "discovered"`은 discovered Method만 가진다. 이전 버전에서 직접 만든 Interface에 Discover 결과가 섞여 저장됐을 수 있으므로 `origin: "manual"`은 discovered Method를 보존할 수 있지만, 관리 모달은 `source: "manual"` Method만 바꾼다. 기존 파일에 origin이 없으면 혼합·manual-only Method는 `manual`, discovered-only Method는 `discovered`로 읽는다.

## 참조 보호

Job이 하나라도 Interface를 참조하면 다음 필드는 바꿀 수 없고 Interface도 삭제할 수 없다.

- `busType`, `destination`, `objectPath`, `interface`, `methods`

화면 표시용 `name`만 바꿀 수 있다. 장비의 Interface·Method가 바뀌었거나 주소가 바뀌면 새 Interface를 만들고 Discover한 뒤 Job을 새 Interface/Method로 옮긴다. 이전 Interface는 참조가 0개가 된 뒤 삭제한다. 참조가 없는 직접 만든 Interface와 manual Method만 관리 모달에서 바꿀 수 있다.

## 확인 기준

- Discover 전에는 Discovered Interface 선택 상자가 없다.
- Direct input을 고를 때만 Interface 입력이 보인다.
- 목록 화면 아래에 Methods 편집기가 없다.
- 발견 Method는 별도 스크롤 모달에서 읽기 전용으로 보인다.
- 참조 중 Interface는 이름 외 연결 정보·Method를 변경하거나 재발견·삭제할 수 없다.
