# DBus 타입 시스템 계약

## 1. 목적과 기준

이 문서는 `neo-pkg-dbus`가 DBus Introspection XML의 `arg type` signature를 읽고, 저장하고, 화면에 표시하고, Job과 Test Call에서 호출하는 방법의 유일한 타입 기준이다.

기준 규격은 [D-Bus Specification — Type System](https://dbus.freedesktop.org/doc/dbus-specification.html)이다. 장비별 관례나 화면용 임의 별칭을 타입 기준으로 사용하지 않는다.

## 2. 기본 원칙

1. Discover는 모든 유효한 표준 DBus Interface와 Method를 반환한다. `org.freedesktop.*`와 복합 타입이 있다는 이유로 결과 전체를 실패시키지 않는다.
2. Discover는 Neo DBus module의 검증된 `Connection.introspect()` 결과를 사용한다. 패키지가 XML을 정규식이나 자체 XML 파서로 다시 읽지 않는다.
3. signature는 DBus 규격 문법으로 완전하게 파싱한다. 배열, 사전, 구조체, variant와 중첩 타입을 포함한다.
4. 파싱 결과는 저장·API·Frontend·Job·Test Call에서 같은 DBus Type 표현을 사용한다.
5. 기존의 `float32`, `float64`, `path`처럼 DBus 규격에 없는 앱 전용 타입과 `type:value` 문자열 힌트는 공개 API·저장 파일·화면에서 사용하지 않는다. 다만 현재 Neo DBus 모듈과 통신하는 마지막 어댑터 안에서만 기본 Type을 Neo ABI 문자열로 바꿀 수 있다.
6. `q` 같은 원문 code를 별도 저장 필드로 유지할 필요는 없다. 표준 Type 표현에서 정확한 signature를 항상 다시 만들 수 있어야 한다.

## 3. DBus Type 표현

### 3.1 기본 타입

기본 타입은 문자열 하나로 표현한다. 이름은 DBus 규격의 의미를 그대로 사용한다.

| DBus code | Type 표현 | 의미 |
|---|---|---|
| `y` | `"byte"` | 부호 없는 8비트 정수 |
| `b` | `"boolean"` | boolean |
| `n` | `"int16"` | 부호 있는 16비트 정수 |
| `q` | `"uint16"` | 부호 없는 16비트 정수 |
| `i` | `"int32"` | 부호 있는 32비트 정수 |
| `u` | `"uint32"` | 부호 없는 32비트 정수 |
| `x` | `"int64"` | 부호 있는 64비트 정수 |
| `t` | `"uint64"` | 부호 없는 64비트 정수 |
| `d` | `"double"` | IEEE 754 64비트 실수 |
| `h` | `"unix-fd"` | Unix file descriptor |
| `s` | `"string"` | UTF-8 문자열 |
| `o` | `"object-path"` | DBus object path |
| `g` | `"signature"` | DBus signature |
| `v` | `"variant"` | 실행 시 실제 타입을 함께 가지는 값 |

### 3.2 복합 타입

복합 타입만 내부 타입 구조를 추가한다. `element`, `key`, `value`, `fields`에는 기본 타입 문자열 또는 같은 형식의 복합 Type 표현이 들어간다.

```json
{ "type": "array", "element": "string" }
```

```json
{
  "type": "array",
  "element": {
    "type": "dict-entry",
    "key": "string",
    "value": "variant"
  }
}
```

```json
{ "type": "struct", "fields": ["int32", "string"] }
```

위 예시는 각각 `as`, `a{sv}`, `(is)` signature를 뜻한다. 사전 key는 DBus 규격대로 기본 타입 문자열만 허용한다.

## 4. Parameter와 값

Method `inputs[]`와 `outputs[]`의 `type`은 3절의 DBus Type 표현이다.

```json
{
  "name": "DataCount",
  "type": "uint16"
}
```

Job과 Test Call의 `inputs` 값은 해당 Type 표현과 같은 구조를 사용한다. 기본 타입은 그 규격의 값이고, array는 배열, struct는 field 순서 배열, dict는 `{key,value}` entry 배열이다. variant 값은 실제 값의 Type과 값을 함께 보낸다.

```json
{
  "props": [
    {
      "key": "mode",
      "value": { "type": "string", "value": "auto" }
    }
  ]
}
```

현재 Neo DBus module의 마지막 호출 ABI는 기본 Type에 한해 문자열을 사용한다. 패키지는 이 어댑터 안에서만 `boolean → bool:...`, `object-path → objectpath:...`처럼 바꾸며, 그 전후의 API·저장 값은 이 문서의 원시값 구조를 유지한다. `array`, `dict-entry`, `struct`, `variant`, `unix-fd`는 저장·Discover 결과로 보존하지만 현재 Neo module이 호출값으로 받지 못하므로 Test Call과 Job 실행에서 HTTP 409 `DBUS_ARGUMENT_UNSUPPORTED`으로 거부한다. 이 제한은 Type 구조를 축소하거나 Discover 결과를 버릴 근거가 되지 않는다.

## 5. 구현·검증 의무

- signature 파서는 유효한 DBus signature를 완전하게 읽고, Type 표현에서 같은 signature를 다시 생성한다.
- Neo Introspection 결과와 signature parser는 잘못된 응답·signature, 최대 길이, 최대 중첩 깊이를 안전하게 거부한다.
- 각 기본·복합 Type, 중첩 array/dict/struct, variant, 표준 `org.freedesktop.*` Interface를 회귀 시험한다.
- `system → ls.plc → /ls/plc/device`의 실제 Introspection은 Discover가 성공하고 `ls.plc.device`와 표준 Interface를 함께 반환하는 통합 시험 기준이다.

## 6. 관련 계약

- 기능·API·데이터 모델: [DBUS_SDD.md](DBUS_SDD.md)
- Backend 책임·검증: [BE_DESIGN.md](BE_DESIGN.md)
- 화면 입력·표시: [FE_DESIGN.md](FE_DESIGN.md)
