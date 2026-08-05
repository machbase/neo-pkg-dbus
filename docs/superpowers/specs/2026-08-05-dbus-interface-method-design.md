# DBus Interface와 Method 재설계

## 상태와 목적

이 설계는 기존의 `Profile` 계층을 `DBus Interface`로 교체한다. Profile은 여러 Method를 묶는 이유와 책임 경계가 불명확했고, 사용자가 빈 Profile을 먼저 만들어야 하는 흐름도 유용하지 않았다.

DBus Interface는 DBus 서비스 안의 기능 묶음이다. Bus Type, Destination, Object Path, Interface 이름을 가진다. DBus Method는 그 Interface가 제공하는 명령 하나이며, Job Method Call은 Job에서 어떤 Method를 어떤 입력값으로 수집할지 정한다.

```text
DBus Interface
  └─ DBus Method
       └─ Job Method Call
```

## 책임 경계

| 대상 | 책임 |
|---|---|
| DBus Interface | Bus Type, Destination, Object Path, Interface 이름과 Method 목록 |
| DBus Method | Method 이름, 입력·출력 파라미터 이름과 DBus 타입, 자동 조회/직접 추가 출처 |
| Job Method Call | Method 선택, 실제 입력값, 응답 해석, Tag, Transform, 저장 규칙과 호출 순서 |

Job은 여러 DBus Interface의 Method를 함께 호출할 수 있다. Interface 주소나 Method 시그니처는 Job에서 수정하지 않는다.

## 기본 항목과 사용자 항목

패키지는 다음 읽기 전용 기본 항목을 제공한다.

```text
system → ls.plc → /ls/plc/device → ls.plc.device → GetDeviceData
```

기본 LS PLC DBus Interface와 `GetDeviceData` Method는 수정하거나 삭제할 수 없다. 사용자는 DBus Interface와 Method를 추가할 수 있다. 사용자가 만든 Interface와 직접 추가한 Method는 어떤 Job이 참조하면 수정·삭제할 수 없다.

## Interface 생성과 Introspection

1. 사용자는 Bus Type, Destination, Object Path를 입력하고 Discover를 실행한다.
2. Backend는 `org.freedesktop.DBus.Introspectable.Introspect`를 호출한다.
3. XML 결과에서 모든 Interface, Method, 입력·출력 파라미터 이름·타입을 읽는다.
4. 화면은 장비 Interface를 먼저 표시하고, `org.freedesktop.*` Interface에는 `Standard` 뱃지를 붙인다. 모든 항목은 처음부터 펼쳐서 표시한다.
5. 저장하면 발견한 모든 Interface와 Method를 저장한다.
6. Introspection을 지원하지 않거나 권한이 없으면 사용자는 Interface 이름, Method 이름, 모든 입력·출력 파라미터를 직접 입력한다.

자동 조회 Method는 `source: "discovered"`, 직접 추가 Method는 `source: "manual"`로 기록한다. 다시 Discover하면 자동 조회 Method만 최신 결과로 갱신한다. 직접 추가 Method는 이름이 같아도 자동으로 수정하거나 삭제하지 않는다. 참조 중인 자동 Method의 시그니처가 바뀌거나 사라지면 덮어쓰거나 삭제하지 않고 `review-required` 상태로 표시한다.

## 저장 모델

DBus Interface 파일은 Interface와 그 하위 Method를 한 JSON 문서로 원자 저장한다.

```json
{
  "schemaVersion": 1,
  "id": "ls-plc-device",
  "builtIn": true,
  "busType": "system",
  "destination": "ls.plc",
  "objectPath": "/ls/plc/device",
  "interface": "ls.plc.device",
  "methods": [
    {
      "id": "get-device-data",
      "source": "discovered",
      "member": "GetDeviceData",
      "inputs": [
        { "name": "dataCount", "type": "uint16" },
        { "name": "memoryAddress", "type": "string" }
      ],
      "outputs": []
    }
  ]
}
```

저장 위치는 다음과 같다.

```text
cgi-bin/interfaces.d/ls-plc-device.json
cgi-bin/conf.d/interfaces/<interface-id>.json
cgi-bin/conf.d/jobs/<job-name>.json
```

Job은 `profileId`와 공통 `dbus.busType`/`dbus.destination`을 갖지 않는다. 각 Method Call은 `interfaceId`와 `methodId`를 참조한다.

## 실행 규칙

실행기는 Job의 Method Call 순서대로 Interface와 Method를 읽는다. 같은 Bus Type과 Destination을 쓰는 호출은 DBus 연결 하나를 재사용한다. 각 호출에는 해당 Interface의 Object Path, Interface 이름과 Method의 member를 사용한다. 앞선 호출이 실패하면 기존 계약대로 남은 호출을 중단한다.

## API

| API | 역할 |
|---|---|
| `GET /dbus-interface/list` | DBus Interface 목록 조회 |
| `GET /dbus-interface?id=` | Interface와 Method 상세 조회 |
| `POST /dbus-interface/discover` | 저장 없는 Introspection 조회 |
| `POST/PUT/DELETE /dbus-interface` | 사용자 DBus Interface 관리 |
| `POST/PUT/DELETE /dbus-method` | 직접 추가 Method 관리 |

Discover는 읽기 전용 DBus 호출이며 결과를 저장하지 않는다. Backend는 XML 크기, Interface·Method·파라미터 수, 이름, 경로, 타입을 최종 검증한다. Job 저장·시작 전에는 참조한 Interface·Method와 파라미터 타입을 다시 검증한다.

`/dbus-method` 요청에는 부모 `interfaceId`를 포함한다. 수정·삭제 요청에는 대상 `methodId`도 포함한다. Backend는 해당 Interface JSON 한 개를 원자적으로 바꾼다.

## 화면

- `Profiles` 화면과 Side의 New Profile 버튼은 `DBus Interfaces`와 New DBus Interface 버튼으로 교체한다.
- 현재 route를 유지하는 모달에서 Interface 목록과 생성·Discover 흐름을 제공한다.
- Job 화면은 Interface별로 접고 펼치는 Method Call 트리를 제공한다.
- Job은 서로 다른 Interface의 Method를 여러 개 추가할 수 있다.

## 비호환 전환

이 기능은 신규 개발이다. 기존 Profile API, 저장 파일, 화면, `profileId`, 공통 Job DBus 설정은 변환하거나 호환하지 않는다. 기존 Profile 기반 설정은 새 DBus Interface와 Method로 다시 만든다.

## 검증

- Introspection XML의 Interface·Method·입력·출력 파싱
- 장비 Interface 우선 정렬과 Standard 뱃지
- 자동 Method 갱신, 직접 추가 Method 보존, `review-required`
- 여러 Interface Method의 Job 호출 순서와 연결 재사용
- 기본 항목 보호와 참조 중 수정·삭제 차단
- 잘못된 Interface·Method 참조 및 파라미터 타입 거부
- 실제 Neo 환경에서 `Introspect()` 호출 검증
