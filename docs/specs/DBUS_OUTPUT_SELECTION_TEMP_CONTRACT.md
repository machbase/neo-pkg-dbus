# DBus 출력 선택 임시 계약

> 상태: **임시 계약 / 구현 검증용**
>
> 이 문서는 2026-08-06 사용자 승인에 따라 기존 LS 전용 반환 수 규칙을 대체한다. 검증이 끝나기 전까지 `DBUS_SDD.md`의 최종 계약으로 승격하지 않는다.

> 2026-08-06 보완: DBus 출력은 기본적으로 Introspection이 선언한 Type 그대로 해석한다. 출력 Type이 `string`일 때만 사용자가 JSON 문자열 해석을 선택할 수 있다.

## 1. 목적

DBus Introspection은 Method의 출력 인자 순서와 각 인자의 DBus Type을 알려 준다. 하지만 배열의 실제 길이, dict의 실제 key, variant의 실제 값 Type은 호출 전에는 알 수 없다.

따라서 Method 자체에 예상 반환 개수나 LS 전용 규칙을 넣지 않는다. 사용자는 Job의 각 Method Call에서 실제로 저장할 출력 값을 선택하고, 선택한 값에 연결할 Tags를 만든다.

## 2. Method Call 출력 선택

`methodCalls[]`의 기존 `tags`는 `outputSelections[]` 안으로 옮긴다. 하나의 Method Call은 여러 출력 선택을 가질 수 있다.

```json
{
  "id": "read-status",
  "name": "Read status",
  "interfaceId": "device-status",
  "methodId": "read-status",
  "inputs": {},
  "outputSelections": [
    {
      "id": "result-1",
      "sourceIndex": 0,
      "interpretation": "json",
      "selector": "/data",
      "valueType": "array",
      "elementType": "numeric",
      "tags": [
        {
          "name": "STATUS",
          "bias": 0,
          "multiplier": 1,
          "transformOrder": ["bias", "multiplier"]
        }
      ]
    }
  ]
}
```

| 필드 | 규칙 |
|---|---|
| `id` | Method Call 안에서 고유한 kebab-case ID |
| `sourceIndex` | Neo DBus `body` 배열의 0부터 시작하는 출력 인자 위치 |
| `interpretation` | 기본값 `native`는 Introspection DBus Type 그대로 쓴다. `json`은 선택한 출력 Type이 `string`일 때만 허용하며, 문자열 전체를 JSON으로 해석한다. |
| `selector` | JSON 해석한 string 또는 native 복합 출력의 RFC 6901 JSON Pointer다. 루트 값은 빈 문자열 `""`이다. native 기본 출력에는 이 필드를 넣지 않으며 화면에도 표시하지 않는다. |
| `valueType` | native 기본 출력은 DBus Type으로 자동 결정한다. 이 경우 이 필드를 넣지 않는다. JSON 해석 또는 native 복합 출력에서만 `numeric`, `string`, `json`, `array` 중 사용자가 고른다. `string` 출력에서 `parse as JSON`을 새로 고르면 화면은 `numeric`을 기본으로 제안한다. |
| `elementType` | 사용자가 `valueType: "array"`를 고를 때 필수다. `numeric`, `string`, `json` 중 하나이며 배열 원소의 자료형이다. native 기본 출력에는 이 필드를 넣지 않는다. |
| `tags` | 저장할 DB TAG 규칙 배열. 배열 안의 순서가 저장값 연결 순서다. |

새로 저장하는 Tag 객체는 `name`, `bias`, `multiplier`, `transformOrder`를 가진다. `transformOrder`는 `"bias"`, `"multiplier"`를 각각 한 번씩 가진 두 칸 배열이며, 왼쪽부터 적용한다. 기본값은 `["bias", "multiplier"]`다. 예전 `sourceAddress`, `calcOrder`, `outputIndex`는 읽기 입력으로만 허용하고 다음 저장에서 제거한다.

`numeric`은 유한한 숫자에 `transformOrder`를 왼쪽부터 적용해 `VALUE`에 저장한다. 따라서 `["bias", "multiplier"]`는 `(value + bias) * multiplier`, `["multiplier", "bias"]`는 `(value * multiplier) + bias`다. `string`은 `VALUE`에 `0`, `STR_VALUE`에 문자열을 저장한다. `json`은 `VALUE`에 `0`, `STR_VALUE`에 JSON 문자열을 저장한다. `array`는 배열을 요구하고 각 원소를 `elementType`에 맞춰 순서대로 Tag 하나씩 저장한다. 문자열·JSON·array·dictionary·struct 등 숫자가 아닌 출력은 Transform하지 않는다. array와 dictionary는 해석 방식이 아니라 `native` 또는 `json` 해석 뒤 얻는 값의 형태다.

## 3. 화면 동작

1. 새 Job draft는 빈 Method Call 목록으로 시작한다. 저장 전에는 Call이 하나 이상 있어야 한다.
2. `Add Call`은 빈 Call을 만든다. 각 Call은 자신의 DBus Interface와 Method를 고른다.
3. Method를 고르면 Introspection의 출력 인자와 Type tree를 보여 준다. 기본 해석은 선언된 DBus Type 그대로다.
4. 기본 DBus 출력(byte·정수·double·boolean·string·object-path·signature)은 Type과 저장 자료형을 자동으로 사용한다. 이때 `selector`, `valueType`, `elementType`은 저장하지 않는다. `string`만 `parse as JSON`으로 바꿀 수 있다.
5. JSON 해석 string과 DBus array/dict/struct 출력은 selector와 Value type을 사용자가 정한다. `string`에서 JSON 해석으로 처음 전환할 때 기본 Value type은 `numeric`이다. array는 원소 자료형도 고른다.
6. array 출력 선택의 Tag 표 바로 위 오른쪽에는 `Generate from Array` 버튼을 보인다. 이 버튼이 여는 `Generate Tags` 모달은 Prefix와 Count를 받아 `PREFIX1`부터 순서대로 생성하며, 생성 뒤 각 Tag는 삭제할 수 있다. 단일값은 Tag 하나의 이름만 직접 수정한다.
7. Test Call은 Neo의 원본 반환 `body`만 반환한다. 화면은 이를 호출 결과 또는 진단용 원본 body로 보여 줄 수 있지만, Test Call은 `outputSelections`를 받거나 selector·자료형·Tag 미리보기를 만들지 않는다. 설정 작성의 필수 단계도 아니다.

## 4. 실행 검증

Collector는 호출 결과를 Neo 원본 `body` 배열로 받는다.

- `sourceIndex`가 없거나 `selector`를 찾을 수 없으면 `OUTPUT_DECODE_FAILED`
- `interpretation: "json"`인데 출력 Type이 string이 아니거나 JSON 해석에 실패하면 `OUTPUT_DECODE_FAILED`
- 선택값이 `valueType` 또는 `elementType`과 다르면 `OUTPUT_DECODE_FAILED`
- numeric/string/json은 Tag 수가 정확히 1개가 아니면 `OUTPUT_COUNT_MISMATCH`
- array의 배열 원소 수와 Tag 수가 다르면 `OUTPUT_COUNT_MISMATCH`
- 모든 출력 선택이 성공해야 Method Call 저장을 실행한다. 일부만 저장하지 않는다.

`dataCount`, `returnedCountPath`, `expectedCount`, `ls-get-device-data`처럼 특정 Method의 입력값으로 반환 수를 미리 추측하거나 Tag 수를 정하는 규칙은 사용하지 않는다.

## 5. 호환 범위

이 임시 계약의 새 Job만 `outputSelections`를 쓴다. 기존 `tags` 형식 Job은 변경하지 않고 읽을 수 있으나, 수정 또는 저장은 이 임시 계약의 migration 규칙이 확정되기 전까지 지원하지 않는다.
