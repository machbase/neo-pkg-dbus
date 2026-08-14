# Job 저장 시 Default Table 생성 설계

## 상태

- 승인일: 2026-08-12
- 승인 방식: 사용자 선택 1번 — Job 저장 시 Table 존재 여부를 판정하고 필요한 schema로 생성
- 적용 대상: generic과 LS target의 공통 Database Server·Job·Collector 동작

## 목표

Database Server를 저장하는 동작과 실제 TAG Table을 만드는 동작을 분리한다.
Database Server에는 기본 Table 이름과, 이미 존재하는 Table에서 사용자가 선택한
Column 이름만 저장한다. 존재하지 않는 Table은 Job을 저장할 때 Job의 출력 형식을
기준으로 한 번만 만든다.

기본 `localhost` Database Server의 Default Table 이름은 `DEFAULT_DBUS`다. 화면에서
`default_dbus`처럼 입력해도 기존 SQL 식별자 규칙에 따라 대문자로 정규화한다.
초기 설정은 Table 이름만 가지며 실제 Table이나 Column은 미리 만들지 않는다.

## Database Server 관리

Database Server Create·Update는 접속 정보와 기본 mapping만 저장하며 Table을 만들지
않는다.

- `Connect and Load Tables` 전에는 Default Table과 두 Column control을 사용할 수 없다.
- 발견 목록의 기존 Table을 선택하면 metadata에서 보여 준 숫자 Value Column과 선택
  String Value Column을 사용자가 고를 수 있다.
- 목록에 없는 Table을 직접 입력하면 Value Column과 String Value Column을 모두
  비활성화하고 빈 값으로 저장한다.
- 없는 Default Table을 저장해도 정상이며, `Table not found` 안내는 실제 생성 시점이
  Job 저장이라는 점을 알린다.
- Database Server 저장은 Table·Column 존재 여부나 자료형을 Backend에서 다시 검증하지
  않는다. 비밀번호 필수, SQL 식별자 정규화 같은 기존 요청 형식 검증은 유지한다.

## Job 화면

새 Job은 기본 Database Server의 `DEFAULT_DBUS` 이름을 복사한다. Table이 아직 없으면
두 Column control을 비활성화한다. 기존 Table을 선택한 경우에만 발견된 Column을
사용자가 고를 수 있다. Job 화면은 Table을 직접 만들지 않는다.

## Job 저장

Job POST와 정지된 Job PUT은 operation lock 안에서 Table 존재 여부를 항상 조회한다.

### 기존 Table

기존 Table은 만들거나 변경하지 않는다. Job 저장 시 선택한 Column의 존재 여부와
자료형을 다시 검증하지 않고, SQL 식별자 형식만 검증해 mapping을 그대로 저장한다.
Table이나 Column이 외부에서 잘못 변경된 경우의 실행 오류는 runtime 결과로 처리한다.

### 없는 Table

Backend는 최종 Job config의 Output Mapping을 분석해 필요한 저장 종류를 결정한다.

- native 기본 출력은 decoder가 결정하는 저장 자료형을 사용한다. DBus 숫자형은 숫자,
  `string`·`object-path`·`signature`와 `boolean`은 문자열 계열이다.
- 명시적 `valueType: "numeric"`과 `array`의 `elementType: "numeric"`은 숫자다.
  명시적 `string`·`json`과 array의 `string`·`json` 원소는 문자열 계열이다.
- 숫자 출력만 있으면 `NAME`, `TIME`, `VALUE DOUBLE SUMMARIZED`로 TAG Table을 만든다.
- 문자열, JSON, object 또는 array처럼 문자열 Column 저장이 필요한 출력이 하나라도
  있으면 위 schema에 `STR_VALUE VARCHAR(1024)`를 추가한다.
- 생성 config는 `valueColumn: "VALUE"`로 정규화한다. 문자열 Column을 만든 경우
  `stringValueColumn: "STR_VALUE"`, 만들지 않은 경우 `stringValueColumn: ""`로 저장한다.
- 동시 요청으로 Table이 먼저 생성된 경우 기존 Table로 간주하고 자동 변경하지 않는다.
- Table 생성 실패 시 Job config와 service는 만들거나 변경하지 않는다.
- `/job/validate`와 runtime Start는 Table을 만들지 않는다.

## Collector 저장

숫자 출력은 선택한 Value Column에 기존 방식으로 저장한다. 문자열·JSON·object·array
출력은 String Value Column이 있을 때만 저장하며 같은 행의 숫자 값은 `0`이다.

String Value Column이 비어 있으면 문자열 계열 출력 행만 저장 대상에서 제외한다.
이는 `DB_APPEND_FAILED`가 아니며 같은 Method와 cycle의 숫자 출력은 계속 저장한다.
이미 숫자 전용으로 만들어진 `DEFAULT_DBUS`에 나중에 문자열 출력 Job을 연결해도
Table을 자동 변경하지 않는다.

## 오류와 원자성

- 새 Table 생성 실패는 Job 저장 실패로 반환하며 반쪽 Job을 남기지 않는다.
- 기존 Table의 Column metadata는 Job 저장을 막지 않는다.
- 실행 시 실제 Value Column을 열거나 append할 수 없는 오류는 기존 `DB_APPEND_FAILED`
  처리와 backoff를 따른다.
- String Value Column 부재로 버린 출력은 실패나 warning으로 기록하지 않는다.

## 검증 기준

1. 초기 `localhost`는 `defaultTable: "DEFAULT_DBUS"`, 두 기본 Column은 빈 값이고 실제
   Table은 생성하지 않는다.
2. Database Server Create·Update는 없는 Default Table을 저장해도 생성 API를 호출하지
   않는다.
3. 기존 Table 선택 시에만 두 Column control이 활성화된다.
4. 숫자 전용 Job은 없는 Table을 `VALUE`만 포함해 생성한다.
5. 문자열 저장이 필요한 Job은 없는 Table을 `VALUE`와 `STR_VALUE`로 생성한다.
6. 기존 Table은 Column metadata 불일치가 있어도 Job 저장 단계에서 거부하지 않는다.
7. String Value Column이 없는 실행은 문자열 행만 버리고 숫자 행은 저장한다.
8. Table 생성 실패 시 Job config와 service가 생기거나 바뀌지 않는다.
9. generic·LS frontend 테스트, Backend 전체 테스트와 두 target 제품 테스트를 통과한다.

## 범위 밖

- 기존 Table에 Column을 자동 추가하거나 schema를 변경하지 않는다.
- 이미 저장된 Job이나 기존 Table을 일괄 마이그레이션하지 않는다.
- 사용자가 임의의 새 Table Column 이름이나 자료형을 지정하게 하지 않는다.
- 별도 Table 생성 API를 제거하지 않는다. 다만 Default Table 저장 흐름에서는 호출하지
  않는다.
