# LS Provider Profile 계약

## 1. 적용 범위와 우선순위

이 문서는 LS Provider 제품에만 적용한다. 공통 build 명령
`npm run build -- --target=ls`를 사용하면 `products/ls/provider.json`이 결과
package의 `cgi-bin/provider.json`으로 복사되고, 이 파일의 `id`가 `"ls"`이면 LS
Provider 제품이다.

LS Provider 제품에서는 이 문서의 정확한 조항이 공통
[Provider Profile 계약](DBUS_PROVIDER_PROFILE.md),
[DBUS_SDD](../DBUS_SDD.md), [FE_DESIGN](../FE_DESIGN.md),
[BE_DESIGN](../BE_DESIGN.md)의 일반 조항보다 우선한다. 이 우선순위는 이 문서에
적힌 차이에만 적용한다. 나머지 Database, Job 실행, 오류와 API 규칙은 공통 계약을
그대로 따른다.

`npm run build -- --target=generic`은 `provider:null`인 generic 제품이다. generic
build는 이 문서를 읽거나 적용하지 않으며 LS Profile과 LS Interface를 배포하지
않는다.

## 2. 제품과 자산

LS target도 제품 이름은 `neo-pkg-dbus`다. generic과 다른 package를 동시에 설치하는
것이 아니라 같은 package를 LS 정책으로 선택 빌드한다. build 결과의 루트와
`cgi-bin/package.json`의 `name`, `version`, `minServerVersion`은 서로 같아야 한다.
LS와 generic은 저장소 루트의 SemVer 하나를 공유하며, 최소 Neo 버전은 `8.5.8`이다.
Git에 LS 완성 산출물을 커밋하지 않고 배포할 때만 LS target을 빌드한다.

LS Profile은 다음 고정값을 가진다.

| 항목 | 값 |
|---|---|
| `id` | `ls` |
| `jobMode` | `fixed` |
| `interfaceId` | `ls-plc-device` |
| `methodId` | `get-device-data` |
| `tagGenerator.kind` | `ls-memory-address-v1` |

Profile에는 `displayName`이나 Method의 입력·출력 signature를 넣지 않는다. Method의
단일 기준은 `products/ls/interfaces/ls-plc-device.json`이다. 이 Interface는 System
Bus의 `ls.plc`, `/ls/plc/device`, `ls.plc.device`를 사용하며 다음 Method 하나를
제공한다.

```text
GetDeviceData(DataCount:uint16, DeviceString:string) -> Return:string
```

## 3. Job의 고정 Call

LS build에서 만드는 새 Job은 다음 Call 하나로 시작하며, 같은 구조의 Call을 하나
이상 가질 수 있다.

- Interface: `ls-plc-device`
- Method: `get-device-data` (`GetDeviceData`)
- Output: `Return` 한 개
- 해석: `Return:string`을 JSON으로 해석
- 선택 위치: JSON Pointer `/data`
- 값 모양: `array`
- 원소 형식: `numeric`

저장되는 초기 Output Selection은 아래와 같다. 이 객체는 Profile에서 Job으로 깊은
복사되므로 Job의 Tag를 바꿔도 읽기 전용 Profile은 바뀌지 않는다.

`Add Call`은 이 기본 Call을 깊은 복사하고 Job 안에서 고유한 ID를 만든 뒤
`methodCalls` 끝에 추가한다. 모든 Call은 위 Interface, Method, Output 구조를
그대로 사용하며 Call별 `DataCount`, `DeviceString`, Tag와 Transform만 독립적으로
바뀐다. 배열 순서가 실행 순서이고 마지막 Call은 삭제할 수 없다. Backend는 첫
Call만이 아니라 모든 Call을 같은 고정 규칙으로 검증한다.

```json
{
  "id": "return-data",
  "sourceIndex": 0,
  "interpretation": "json",
  "selector": "/data",
  "valueType": "array",
  "elementType": "numeric",
  "tags": []
}
```

## 4. LS Tag 재계산

LS 새 Job 화면은 `DeviceString`의 수정할 수 없는 `%` 접두사와 현재 주소 본문을
읽기 전용으로 표시한다. 오른쪽 화살표를 누르면 Memory Area, Data Type, Address를
조합하는 LS 전용 팝오버가 열린다. Memory Area와 Data Type은 검색·선택과 직접 입력을
모두 허용하고 후보 목록은 한 번에 하나만 연다. Address는 숫자 control의 화살표와
키보드로 조절하며 기본값은 `0`이다. Memory Area 후보는 `A/F/I/Q/M/K/R/W`, Data
Type 후보는 `X/B/W/D/L`이다. DataCount는 `1`보다 작아질 수 없다. 두 숫자 control은
브라우저 기본 spinner를 숨기고 같은 위·아래 아이콘 control을 사용한다. 팝오버 아래
완성 주소 입력은 `%MB3` 형식을 직접 수정할 수 있다.
새 Call은 `%MB0`, DataCount `1`, 자동 Tag `MB0` 한 개로 시작한다. 화살표뿐 아니라 바깥 읽기 전용 주소
본문을 눌러도 같은 팝오버를 연다.
사용자는 `MB3`만 입력하지만 Job 저장값, Test Call과 수집 Job의 실제 DBus 호출값은
`%MB3`이다. 주소 정규형은 `%`로 시작하고 숫자로 끝나며 그 사이에 문자가 하나 이상
있어야 한다. 주소 본문에 `%`를 다시 넣지 않는다.
`%MB3`, `%AREA.X09`는 유효하고 `%3`, `MB3`, `%MB`, `%%MB3`는 유효하지 않다.

`DataCount`와 정규형 `DeviceString`이 바뀌면 `ls-memory-address-v1` 규칙으로 Tag를
다시 계산한다. 예를 들어 화면에서 `MB3`, `DataCount:3`을 입력하면 저장·호출값은
`%MB3`이고 Tag는 `MB3`, `MB4`, `MB5`다.

- `nameMode:"auto"`인 같은 index의 이름은 새 주소에 맞춰 다시 만든다.
- `nameMode:"manual"`인 같은 index의 이름과 transform 값은 그대로 보존한다.
- `DataCount`가 줄면 새 범위를 벗어난 뒤쪽 Tag는 삭제한다.
- `DataCount`가 늘면 새 index에는 자동 이름과 기본 transform을 만든다.
- 이 규칙은 LS Profile이 있는 새 LS Job에만 적용한다. generic 제품에는 적용하지
  않는다.
- 기존 `%` 포함 저장값을 편집하면 화면 입력에는 첫 `%`를 제외한 주소 본문만
  표시한다. 기존 Job migration은 제공하지 않는다.

## 5. 화면 차이와 기존 Job

LS build의 새 Job과 유효한 고정 LS Job 편집 화면은 `DeviceString`, `DataCount`,
위 고정 Output과 Tag 목록만 표시한다. 다음 generic control은 숨긴다.

- DBus Interface 새로 만들기 진입점
- Interface/Method 선택
- Output Mapping 추가·수정·삭제

Method Calls는 좌측 목록과 우측 선택 상세를 가진 master-detail 카드다. 목록 행은
drag handle, `DeviceString`, `DataCount`를 표시하며 `Add Call`, 순서 변경과 삭제를
제공한다. 선택 상세 상단에는 `ls-plc-device · get-device-data`를 표시하고 입력은
`DeviceString`, `DataCount` 순서의 같은 너비 두 열이다. Tags는 기본 접힘이며 Tag
개수와 첫 이름~마지막 이름을 요약한다. Tags 영역의 좌우 경계는 입력 행과 같다.
DeviceString 팝오버는 해당 입력과 같은 너비이고 flow 밖에 배치해 카드와 Tags를
밀지 않는다. 팝오버 안에서는 Memory Area와 Data Type이 남은 너비를 똑같이
나눠 쓰고 Address만 고정 너비다. 바깥 DeviceString은 읽기 전용이고 변경은 팝오버의
세 부분 control 또는 완성 주소 입력에서만 확정한다. 다른 Call을 선택하면 Tags는
다시 접힌다. 선택 상태, 접힘 상태와 팝오버 상태는 저장하지 않는다.

Call 목록은 최대 8행 높이를 유지하고 9번째 Call부터 목록 내부에서 세로 스크롤한다.
추가하거나 선택한 Call은 보이는 범위로 이동하며 오른쪽 상세는 Call 개수 때문에
늘어나지 않는다. Tag Transform의 Bias와 Multiplier는 Address·DataCount와 같은
위·아래 화살표를 사용하고 기존 숫자 범위와 계산 규칙은 바꾸지 않는다.

실행 주기와 재시도 설정은 공통 화면과 같은 control을 사용한다. 반면 LS의 Database
Server는 하나의 공통 profile이다. 모든 LS Job은 이 profile의 server, Default Table,
Value Column과 String Value Column을 공유한다. Job Database 요약은 읽기 전용이며
개별 Job에서 server/table/column을 바꾸지 않는다. LS Database Server 목록에서는
추가·삭제·기본 서버 전환을 제공하지 않고 기존 profile만 수정한다. 실행 중인 logical
Job이 있으면 수정 확인 뒤 각 Job을 reload하며, pending writer rows는 stop 과정에서
flush한다. 공통 Backend의 Interface/Method/Job CRUD API 자체를 이 Profile이 막거나
삭제하지 않는다.

기존 Job을 LS 고정 Call로 바꾸는 migration은 제공하지 않는다. 고정 규칙에 맞는
기존 단일 Call Job은 같은 LS 전용 편집기를 사용한다. 고정 규칙을 위반하는 기존
Job을 자동 변환하지 않는다.
