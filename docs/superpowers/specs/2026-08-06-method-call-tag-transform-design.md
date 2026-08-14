# Method Call Tag Transform 디자인

## 목적

Method Call 화면에서 중복 표시와 쓰이지 않는 Tag 정보를 제거하고, 숫자 출력의 계산 규칙을 한 가지 읽기 쉬운 형태로 보여 준다.

## 화면

- 각 Method Call 카드 상단의 `순서. Call Name` 표시를 제거한다. Call 이름은 폼의 `Call Name` 입력만 사용한다.
- Tag 표에서 `Source` 열을 제거한다.
- `Generate Tags`를 누르면 Prefix와 Count를 입력하는 모달을 연다. 평소 Tag 표에는 생성 입력을 표시하지 않는다.
- 숫자 출력 Tag 표에는 `Transform` 열을 둔다. 각 행은 `( value + Bias ) × Multiplier` 순서로 편집한다.
- 문자열, JSON, 복합 출력 Tag 표에는 Transform 열을 표시하지 않는다.

## 저장과 실행

- `sourceAddress`와 `calcOrder`는 새 Job 저장값에서 제거한다.
- 기존 Job의 두 필드는 읽을 수 있지만, Edit 후 Save하면 제거한다.
- 숫자 출력의 Transform은 항상 `(value + bias) * multiplier`다.
- 문자열·JSON·복합 출력은 Transform하지 않는다.
- Tag 배열 순서가 출력값과 Tag의 연결 순서다.

## 영향과 검증

- `sourceAddress`, `calcOrder`를 사용자 API·저장 형식·validator에서 제거한다.
- 기존 저장값의 두 필드를 호환 입력으로 받아 무시하고 새 저장 결과에는 넣지 않는다.
- 숫자 Transform, 문자열 Transform 미적용, Tag 생성 모달, 기존 Job 저장 시 필드 제거를 테스트한다.

## 확정 근거

사용자 승인: 2026-08-06. 제공한 화면 예시의 `(value + bias) × multiplier` Transform 형식을 사용한다.
