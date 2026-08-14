# LS Tag CSV Import 설계

## 목적

LS Method Call의 DataCount로 이미 만들어진 Tag 이름과 숫자 Transform을 CSV 한
파일로 빠르게 바꾼다. CSV는 Tag 개수를 만들거나 DataCount를 바꾸는 입력이 아니다.

## 화면

- 현재 선택된 LS Method Call의 접힌/펼친 Tags 헤더 오른쪽에 `Import CSV` 버튼을 둔다.
- 버튼은 파일 선택기를 열고 `.csv` 파일 하나를 받는다.
- 파일을 선택하면 별도 미리보기 모달 없이 즉시 현재 Call의 Tag draft에 반영한다.
- 성공하면 기존 Tags 행에 바뀐 값이 바로 보인다.
- 실패하면 어떤 행과 열이 잘못됐는지 오류를 표시하고 기존 Tag draft는 그대로 둔다.
- generic 제품에는 버튼을 표시하지 않는다.

## CSV 계약

첫 행은 다음 헤더를 정확한 순서로 가진다.

```csv
name,bias,multiplier,order
MB0,0,1,0
MB1,10,2,1
MB2,,,
```

| 열 | 필수 | 빈 값 기본값 | 의미 |
|---|---:|---:|---|
| `name` | 예 | 없음 | 저장할 Tag 이름 |
| `bias` | 아니요 | `0` | 더할 값 |
| `multiplier` | 아니요 | `1` | 곱할 값 |
| `order` | 아니요 | `0` | Transform 적용 순서 |

- `order=0`: `(value + bias) * multiplier`
- `order=1`: `(value * multiplier) + bias`
- 빈 줄은 데이터 행에서 제외한다.
- UTF-8 BOM은 첫 헤더 앞에서 제거한다.
- `bias`와 `multiplier`는 유한한 숫자여야 한다.
- `order`는 `0` 또는 `1`만 허용한다.
- `name`과 각 값의 앞뒤 공백은 제거한다.

## 적용 알고리즘

1. 빈 줄을 제외한 CSV 데이터 행을 위에서부터 읽는다.
2. `min(CSV 행 수, DataCount, 현재 Tag 수)`만 적용 대상으로 정한다.
3. 적용 대상 각 행을 기존 Tag의 같은 index에 대응시킨다.
4. CSV 행이 부족하면 대응되지 않은 뒤쪽 Tag는 이름과 Transform을 모두 유지한다.
5. CSV 행이 많으면 DataCount 이후 행은 검증하지 않고 무시한다.
6. 적용 대상 전체를 먼저 검증한다.
7. 한 행이라도 잘못되면 아무 Tag도 바꾸지 않는다.
8. 모두 유효하면 한 번의 state 변경으로 적용한다.
9. 적용된 Tag 이름은 `nameMode:"manual"`로 표시해 이후 주소·개수 변경에도 같은
   위치에서 유지한다.

CSV의 `order`는 Job draft에서 기존 저장 형식으로 바꾼다.

| CSV | Job draft |
|---|---|
| `order=0` | `transformOrder:["bias","multiplier"]` |
| `order=1` | `transformOrder:["multiplier","bias"]` |

## 오류

Frontend import 오류는 저장 API를 호출하지 않는다. 최소한 다음 원인을 구분해 표시한다.

- 파일을 읽을 수 없음
- 헤더가 다름
- 적용할 데이터 행이 없음
- 적용 대상 행의 `name`이 비어 있음
- `bias` 또는 `multiplier`가 유한한 숫자가 아님
- `order`가 `0` 또는 `1`이 아님

기존 Job 저장 검증은 그대로 유지한다. 따라서 import 성공 후에도 Job 안의 Tag 이름
중복, 최대 길이, 다른 Job과의 이름 경고는 현재 흐름에서 다시 검사한다.

## 영향 범위

- 변경: LS Job form의 Tags UI, CSV parser/model helper, frontend tests
- 유지: DataCount, Tag 개수, Backend API, Job JSON schema, 수집 Transform 실행
- 제외: generic Job form, CSV export, drag-and-drop 업로드, 미리보기 모달

## 완료 기준

- 빈 선택이나 잘못된 CSV는 기존 Tag를 하나도 바꾸지 않는다.
- 선택된 Call에만 적용되고 다른 Call은 바뀌지 않는다.
- 부족 행은 뒤 Tag를 보존한다.
- 초과 행은 DataCount까지만 적용한다.
- 기본값과 두 order가 기존 Transform 저장 구조로 정확히 변환된다.
- CSV import 뒤 Job 저장/다시 열기와 LS product build가 정상 동작한다.

## 승인

2026-08-14 사용자 승인. 사용자는 헤더 이름을 내부 의미에 맞춘
`name,bias,multiplier,order`로 정했고, 부족 행 유지, 초과 행 무시, 미리보기 없는 즉시
반영, 오류 시 전체 취소를 확정했다.
