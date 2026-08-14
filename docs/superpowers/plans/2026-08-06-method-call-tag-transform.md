# Method Call Tag Transform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Method Call 화면의 중복·미사용 Tag 필드를 없애고, 숫자 출력에만 사진과 같은 고정 Transform 편집기를 제공한다.

**Architecture:** Tag 배열의 순서가 출력값 연결 순서이므로 `sourceAddress`와 `calcOrder`를 새 저장 형식에서 제거한다. collector는 숫자만 `(value + bias) * multiplier`로 변환하고, 문자열·JSON·복합 출력은 변환하지 않는다. 기존 Job은 두 필드를 받아 읽되 validation 결과와 다음 저장에서 제거한다.

**Tech Stack:** React, Node.js CommonJS, Machbase Neo JSH, node:test.

## Global Constraints

- UI는 `DESIGN.md`의 기존 dark operations 토큰과 4px control radius를 유지한다.
- 공개 계약은 `docs/specs/DBUS_SDD.md`, `FE_DESIGN.md`, `BE_DESIGN.md`와 임시 출력 계약을 함께 갱신한다.
- 새 Tag 저장 필드는 `name`, `bias`, `multiplier`만 포함하며 `sourceAddress`, `calcOrder`, `outputIndex`는 넣지 않는다.
- 기존 Job의 제거 대상 필드는 실행을 막지 않고 다음 저장에서 사라진다.
- 문자열·JSON·복합 출력은 `VALUE=0`, `STR_VALUE`에 문자열을 저장한다.

---

### Task 1: Tag 저장 형식과 collector 정리

**Files:**
- Modify: `cgi-bin/src/jobs/validator.js`
- Modify: `cgi-bin/src/collector/cycle.js`
- Modify: `cgi-bin/src/tag/transform.js`
- Test: `cgi-bin/tests/job-validator-repository.test.cjs`
- Test: `cgi-bin/tests/collector-runtime.test.cjs`

**Interfaces:**
- Consumes: Tag `{ name, bias, multiplier }`와 기존 Tag의 선택 필드 `sourceAddress`, `calcOrder`, `outputIndex`.
- Produces: validator가 반환하는 새 Tag `{ name, bias, multiplier }`; 숫자용 `transformValue(value, tag)`.

- [ ] **Step 1: 실패하는 validator·collector 테스트 작성**

```js
assert.deepEqual(valid.methodCalls[0].tags[0], {
  name: '%MB3', bias: 0, multiplier: 1,
});
assert.equal(transformValue(3, { bias: 2, multiplier: 4 }), 20);
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `node --test cgi-bin/tests/job-validator-repository.test.cjs cgi-bin/tests/collector-runtime.test.cjs`

Expected: 기존 Tag에 `sourceAddress` 또는 `calcOrder`가 남아 실패한다.

- [ ] **Step 3: 최소 구현 작성**

```js
function validateTag(tag, names) {
  // 기존 세 필드는 허용 입력으로 읽되 반환 객체에는 넣지 않는다.
  return { name: tag.name, bias: tag.bias, multiplier: tag.multiplier };
}

function transformValue(value, tag) {
  if (typeof value !== 'number') return value;
  return (value + tag.bias) * tag.multiplier;
}
```

`rowsFor()`에서 `sourceAddress`를 반환하지 않고, 숫자값에만 Transform을 호출한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test cgi-bin/tests/job-validator-repository.test.cjs cgi-bin/tests/collector-runtime.test.cjs`

Expected: PASS.

### Task 2: Method Call·Tag UI 변경

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/model.js`
- Test: `frontend/tests/model-contract.test.mjs`
- Test: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: Tag `{ name, bias, multiplier }`.
- Produces: Tag 생성 모달과 숫자 출력 전용 Transform 편집 UI.

- [ ] **Step 1: 실패하는 UI·직렬화 테스트 작성**

```js
assert.doesNotMatch(source, /<strong>\{index \+ 1\}\. \{call\.name\}<\/strong>/);
assert.match(source, /Generate Tags/);
assert.doesNotMatch(JSON.stringify(serializedTag), /sourceAddress|calcOrder/);
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `node --test frontend/tests/model-contract.test.mjs frontend/tests/app-contract.test.mjs`

Expected: 상단 번호·이름, inline 생성 입력, 기존 Tag 필드 때문에 실패한다.

- [ ] **Step 3: 최소 구현 작성**

```jsx
<button type="button" onClick={() => setGeneratorOpen(true)}>Generate Tags</button>
{numeric ? <span>( value + <Input /> ) × <Input /></span> : null}
```

- Method Call 카드의 상단 번호·이름 `<strong>`를 제거한다.
- 생성 버튼은 Prefix·Count 모달을 연다. 확인하면 `TAG1`부터 순서대로 생성한다.
- `Source`, `Order` 열을 제거한다.
- 숫자 출력만 Transform 열을 보이고, 문자열·JSON·복합 출력에는 보이지 않는다.
- `serializeJobConfig()`은 새 Tag 필드만 보낸다.

- [ ] **Step 4: 테스트와 빌드 통과 확인**

Run: `npm --prefix frontend test && npm --prefix frontend run build:root -- --with-ls-interface`

Expected: PASS.

### Task 3: 계약 문서과 회귀 검증

**Files:**
- Modify: `docs/specs/DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`
- Modify: `docs/specs/DBUS_SDD.md`
- Modify: `docs/specs/BE_DESIGN.md`
- Modify: `docs/specs/FE_DESIGN.md`

- [ ] **Step 1: 계약 문서 갱신**

Tag 예시와 필드 표에서 `sourceAddress`, `calcOrder`, `outputIndex`를 제거한다. 숫자 Transform은 `(value + bias) * multiplier`만 지원하며 문자열·JSON·복합 출력은 Transform하지 않음을 적는다. 화면 규칙에 Tag 생성 모달과 숫자 출력 전용 Transform을 적는다.

- [ ] **Step 2: 전체 회귀 테스트 실행**

Run: `node --test cgi-bin/tests/*.test.cjs && npm --prefix frontend test && git diff --check`

Expected: 모든 테스트 PASS, 공백 오류 없음.

- [ ] **Step 3: 원격 배포와 해시 확인**

프론트 `index.html`, `main.html`, `side.html` 및 수정한 CGI 파일을 `/home/machbase/neo-pkg-dbus-deploy`에 SFTP로 올린다. SFTP server는 `/home/machbase/bin/sftp-server`, SSH port는 `2022`를 사용한다. 이후 `5ce84a85d69d` 컨테이너의 `/file/public/neo-pkg-dbus`로 `docker cp`하고 로컬·원격 SHA-256을 비교한다.
