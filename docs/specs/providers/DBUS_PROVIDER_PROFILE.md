# DBus Provider Profile 계약

## 1. 목적과 저장 경계

Provider Profile은 배포판이 제공하는 읽기 전용 build 정보다. 선택 파일
`cgi-bin/provider.json`에만 두며, 사용자 설정 파일
`cgi-bin/conf.d/settings.json`과 분리한다.

- `provider.json`이 없으면 generic mode다. `GET /settings`의 `provider`는
  반드시 `null`이다.
- 파일이 있으면 Provider build다. Backend는 이 문서의 schema를 검증한 객체를
  `GET /settings`의 `provider`로 돌려준다.
- `PUT /settings`는 `provider`를 받거나 저장하지 않는다. 요청에 `provider` key가
  있으면 HTTP 400 `SETTINGS_INVALID`이다.
- 파일을 읽을 수 없거나 JSON/schema가 잘못되면 HTTP 400
  `PROVIDER_PROFILE_INVALID`이다. 잘못된 Profile을 generic mode로 조용히 바꾸지
  않는다.

Provider Profile에는 DB password, Job 이름, Tag 이름, Database 기본값을 저장하지
않는다. Database Server 기본값은 모든 build에서 같은 Settings 계약을 사용한다.

## 2. schemaVersion 1

다음은 유효한 Provider Profile 예시다.

```json
{
  "schemaVersion": 1,
  "id": "ls",
  "jobMode": "fixed",
  "interfaceId": "ls-plc-device",
  "methodId": "get-device-data",
  "outputSelections": [
    {
      "id": "return-data",
      "sourceIndex": 0,
      "interpretation": "json",
      "selector": "/data",
      "valueType": "array",
      "elementType": "numeric",
      "tags": []
    }
  ],
  "tagGenerator": { "kind": "ls-memory-address-v1" }
}
```

Top-level에는 `schemaVersion`, `id`, `jobMode`, `interfaceId`, `methodId`,
`outputSelections`, `tagGenerator`만 허용한다. 모두 필수다.

| 필드 | 규칙 |
|---|---|
| `schemaVersion` | 정수 `1` |
| `id` | 비어 있지 않은 Provider 식별자 |
| `jobMode` | 문자열 `"fixed"` |
| `interfaceId`, `methodId` | 비어 있지 않은 DBus Interface/Method 식별자 |
| `outputSelections` | 하나 이상의 읽기 전용 새 Job 초기 출력 선택 |
| `tagGenerator.kind` | 현재 지원하는 `"ls-memory-address-v1"` |

`outputSelections[]`에는 `id`, `sourceIndex`, `interpretation`, `selector`,
`valueType`, `elementType`, `tags`만 허용한다. `id`는 Profile 안에서 고유하고,
`sourceIndex`는 0 이상의 정수다. `interpretation`은 `native` 또는 `json`이다.
`selector`, `valueType`, `elementType`의 관계는
[DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md](../DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md)를
따른다. Profile은 Tag 이름을 소유하지 않으므로 `tags`는 반드시 빈 배열이다.
`tagGenerator`에는 `kind` 이외의 필드를 허용하지 않는다.

알 수 없는 top-level, output selection, tag generator field는 제거해서 사용하지
않고 `PROVIDER_PROFILE_INVALID`으로 거부한다.

## 3. `fixed`의 뜻과 공통 기능

`jobMode: "fixed"`는 Provider build 화면의 표시와 새 Job 초기값을 정하는 정보일
뿐이다. Backend의 공통 DBus Interface/Method/Job CRUD API를 막거나 삭제한다는
뜻이 아니다. 이후 별도로 승인된 계약이 제한을 정하기 전까지 generic backend CRUD
API는 Provider build에서도 그대로 사용할 수 있다.

Provider Profile은 Interface/Method/Job 파일을 만들거나 고치지 않는다. Provider
배포판이 필요한 읽기 전용 Interface asset을 별도로 제공해야 하며, Profile의 ID는
그 asset을 참조한다. Profile이 화면이나 새 Job에서 바꾸는 동작도 이 문서 또는 해당
Provider 계약에 명시된 범위만 허용한다.

모든 target의 package 이름은 `neo-pkg-dbus`로 고정하고 버전 기준은
`cgi-bin/package.json.version`이다. Profile의 `id`는 선택된 실행 정책을 나타낼 뿐
제품 이름이나 버전 대신 쓰지 않는다. 모든 target은 루트의 한 version을 공유하며,
build 결과의 루트와 CGI manifest가 그 이름과 version을 사용한다. Profile은 제품
소스 경로나 build 입력을 등록하는 manifest가 아니며, 제품별 `product.json`은 두지
않는다.
