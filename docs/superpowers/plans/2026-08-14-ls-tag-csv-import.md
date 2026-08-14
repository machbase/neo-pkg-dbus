# LS Tag CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 선택된 LS Method Call의 기존 Tag를 `name,bias,multiplier,order` CSV로 원자적으로 치환한다.

**Architecture:** CSV 해석과 Tag 치환은 LS 제품 전용 순수 모듈에 둔다. 공통 Job Form은 build가 주입한 `tagCsvImporter`가 있을 때만 `Import CSV`를 표시하고, 성공한 새 Tag 배열만 현재 선택 Call의 output selection에 한 번에 반영한다. Backend API와 Job JSON schema는 그대로 유지한다.

**Tech Stack:** React 19, JavaScript ES modules, Node test runner, react-test-renderer, Vite product alias

## Global Constraints

- 공개 계약은 `docs/specs/DBUS_SDD.md` CCR-068과 `docs/superpowers/specs/2026-08-14-ls-tag-csv-import-design.md`를 따른다.
- CSV Import는 LS 제품에만 보이고 generic 제품에는 보이지 않는다.
- CSV Import는 DataCount, Tag 수, Backend API와 저장 schema를 바꾸지 않는다.
- 적용 대상 오류 하나라도 있으면 기존 Tag 배열을 하나도 바꾸지 않는다.
- 초과 행은 DataCount 이후부터 무시하고, 부족 행은 뒤 Tag를 유지한다.
- 새 의존성은 추가하지 않고 quoted cell, escaped quote, CRLF, UTF-8 BOM을 지원하는 작은 parser를 제품 모듈에 둔다.
- 기존 미커밋 DataViewer, Database, proxy와 생성 이미지 변경은 수정·스테이징·커밋하지 않는다.
- 각 커밋 직전에 인자 없는 `npm run build`를 실행해 generic 기본 build를 확인한다.

---

### Task 1: LS CSV parser와 원자 Tag 치환

**Files:**
- Create: `products/ls/frontend/tagCsv.mjs`
- Create: `frontend/tests/ls-tag-csv-import.test.mjs`
- Modify: `products/ls/frontend/model.mjs`
- Modify: `products/generic/frontend/model.mjs`
- Modify: `frontend/package.json`

**Interfaces:**
- Produces: `applyLsTagCsv(text: string, currentTags: Tag[], dataCount: number): Tag[]`
- Produces: LS `tagCsvImporter = { apply: applyLsTagCsv }`
- Produces: generic `tagCsvImporter = null`
- Error: `Error` with `code`, optional `row` and `column`; 호출자는 메시지를 화면에 표시한다.

- [ ] **Step 1: 순수 parser의 실패 테스트를 작성한다**

`frontend/tests/ls-tag-csv-import.test.mjs`에 다음 케이스를 작성한다.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { applyLsTagCsv } from "../../products/ls/frontend/tagCsv.mjs";
import { tagCsvImporter as genericImporter } from "../../products/generic/frontend/model.mjs";
import { tagCsvImporter as lsImporter } from "../../products/ls/frontend/model.mjs";

const tags = [
  { name: "MB0", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
  { name: "MB1", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
  { name: "MB2", nameMode: "auto", bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] },
];

test("LS CSV 기본값과 order를 기존 Tag 저장 구조로 바꾼다", () => {
  const result = applyLsTagCsv(
    "name,bias,multiplier,order\nTAG_A,,,\nTAG_B,10,2,1\n",
    tags,
    3,
  );
  assert.deepEqual(result[0], {
    ...tags[0], name: "TAG_A", nameMode: "manual", bias: 0, multiplier: 1,
    transformOrder: ["bias", "multiplier"],
  });
  assert.deepEqual(result[1], {
    ...tags[1], name: "TAG_B", nameMode: "manual", bias: 10, multiplier: 2,
    transformOrder: ["multiplier", "bias"],
  });
  assert.deepEqual(result[2], tags[2]);
});

test("LS CSV는 DataCount 초과 행을 검증하지 않고 무시한다", () => {
  const result = applyLsTagCsv(
    "name,bias,multiplier,order\nFIRST,1,2,0\nIGNORED,broken,broken,9\n",
    tags,
    1,
  );
  assert.equal(result[0].name, "FIRST");
  assert.deepEqual(result.slice(1), tags.slice(1));
});

test("LS CSV 적용 대상 오류는 원본을 바꾸지 않는다", () => {
  const before = structuredClone(tags);
  assert.throws(
    () => applyLsTagCsv("name,bias,multiplier,order\n,0,1,0\n", tags, 3),
    (error) => error.code === "TAG_CSV_NAME_REQUIRED" && error.row === 2,
  );
  assert.deepEqual(tags, before);
});

test("LS CSV는 BOM, CRLF, quote와 escaped quote를 읽는다", () => {
  const result = applyLsTagCsv("\uFEFFname,bias,multiplier,order\r\n\"TAG\"\"A\",0,1,0\r\n", tags, 3);
  assert.equal(result[0].name, 'TAG"A');
});

test("제품 경계는 LS에만 importer를 제공한다", () => {
  assert.equal(genericImporter, null);
  assert.equal(lsImporter.apply, applyLsTagCsv);
});
```

같은 파일에 잘못된 헤더, 데이터 행 없음, 유한하지 않은 `bias`/`multiplier`, `0|1`이 아닌 `order`, CSV quote 미종료 테스트를 각각 추가한다.

- [ ] **Step 2: parser 테스트가 RED인지 확인한다**

Run:

```bash
node --test frontend/tests/ls-tag-csv-import.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` 또는 `applyLsTagCsv` 미정의로 FAIL.

- [ ] **Step 3: CSV parser와 Tag 치환을 최소 구현한다**

`products/ls/frontend/tagCsv.mjs`에 다음 공개 함수와 오류 helper를 구현한다.

```js
function csvError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function applyLsTagCsv(text, currentTags, dataCount) {
  const limit = Math.min(Math.max(0, Number(dataCount) || 0), currentTags.length);
  const rows = parseCsvRows(String(text ?? ""));
  const header = rows.shift() || [];
  if (header[0]?.replace(/^\uFEFF/, "") !== "name"
    || header[1] !== "bias" || header[2] !== "multiplier" || header[3] !== "order"
    || header.length !== 4) {
    throw csvError("TAG_CSV_HEADER_INVALID", "CSV header must be name,bias,multiplier,order.", { row: 1 });
  }
  const sourceRows = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  if (!sourceRows.length || limit === 0) throw csvError("TAG_CSV_EMPTY", "CSV has no applicable Tag rows.");
  const applicable = sourceRows.slice(0, limit);
  const replacements = applicable.map((row, index) => csvRowToTag(row, index + 2));
  return currentTags.map((tag, index) => index < replacements.length
    ? { ...tag, ...replacements[index], nameMode: "manual" }
    : tag);
}
```

`parseCsvRows`는 상태 머신으로 comma, `"..."`, `""`, CRLF를 처리한다. 전체 CSV 구조는 검사하지만 `sourceRows.slice(0, limit)` 뒤의 초과 행은 이름·숫자·order 의미 검증을 하지 않는다. `csvRowToTag`는 cell 앞뒤 공백을 제거하고 빈 기본값과 두 `transformOrder` 배열을 만든다. 숫자는 `Number.isFinite(Number(cell))`로 검증한다.

제품 모델 export를 다음처럼 연결한다.

```js
// products/ls/frontend/model.mjs
import { applyLsTagCsv } from "./tagCsv.mjs";
export const tagCsvImporter = Object.freeze({ apply: applyLsTagCsv });

// products/generic/frontend/model.mjs
export const tagCsvImporter = null;
```

`frontend/package.json`의 `test:layout`에 `node --test tests/ls-tag-csv-import.test.mjs`를 추가한다.

- [ ] **Step 4: parser와 제품 경계가 GREEN인지 확인한다**

Run:

```bash
node --test frontend/tests/ls-tag-csv-import.test.mjs
npm run test:products
```

Expected: 모든 테스트 PASS.

- [ ] **Step 5: 기본 build 후 parser 단위를 커밋한다**

Run:

```bash
npm run build
git add products/ls/frontend/tagCsv.mjs products/ls/frontend/model.mjs products/generic/frontend/model.mjs frontend/tests/ls-tag-csv-import.test.mjs frontend/package.json
git commit -m "feat: parse LS tag CSV imports"
```

Expected: generic build 성공. 기존 미커밋 파일과 root HTML은 이 커밋에 포함하지 않는다.

---

### Task 2: 선택된 LS Call의 Tags 헤더에 Import 연결

**Files:**
- Modify: `frontend/src/App.jsx:5-7,605-699`
- Modify: `frontend/src/styles.css:302-330`
- Modify: `frontend/tests/ls-fixed-calls-editor.test.mjs`
- Modify: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Consumes: `tagCsvImporter: null | { apply(text, tags, dataCount): ImportResult }`
- Consumes: Task 1이 반환한 완성 `Tag[]`
- Produces: 현재 선택 Call의 selection만 바꾸는 `importTags(file)` UI handler

- [ ] **Step 1: LS UI의 실패 테스트를 작성한다**

`frontend/tests/ls-fixed-calls-editor.test.mjs`에 다음 상호작용을 추가한다.

```js
test("LS Import CSV는 선택 Call만 즉시 치환하고 부족한 뒤 Tag를 유지한다", async () => {
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB0", 3),
    fixedCall("get-device-data-2", "%MW10", 2),
  ]);
  const { renderer } = harness;
  const importButton = buttonText(renderer.root, "Import CSV");
  const fileInput = renderer.root.findAllByProps({ "aria-label": "Import Tags CSV" })[0];

  assert.match(importButton.props.className, /neo-button/);
  assert.equal(fileInput.props.type, "file");
  assert.match(fileInput.props.accept, /\.csv/);

  await act(async () => fileInput.props.onChange({ target: {
    files: [{ text: async () => "name,bias,multiplier,order\nCUSTOM,2,3,1\n" }],
    value: "tags.csv",
  } }));

  const first = harness.calls()[0].outputSelections[0].tags;
  assert.equal(first[0].name, "CUSTOM");
  assert.equal(first[0].nameMode, "manual");
  assert.deepEqual(first[0].transformOrder, ["multiplier", "bias"]);
  assert.deepEqual(first.slice(1).map((tag) => tag.name), ["MB1", "MB2"]);
  assert.deepEqual(harness.calls()[1].outputSelections[0].tags.map((tag) => tag.name), ["MW10", "MW11"]);
});

test("LS Import CSV 오류는 Tag를 바꾸지 않고 alert를 표시한다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1", "%MB0", 1)]);
  const { renderer } = harness;
  const before = structuredClone(harness.calls());
  const fileInput = renderer.root.findAllByProps({ "aria-label": "Import Tags CSV" })[0];

  await act(async () => fileInput.props.onChange({ target: {
    files: [{ text: async () => "name,bias,multiplier,order\n,0,1,0\n" }],
    value: "bad.csv",
  } }));

  assert.deepEqual(harness.calls(), before);
  assert.match(renderer.root.findAllByProps({ role: "alert" })[0].children.join(""), /name/i);
});
```

같은 파일에 파일 읽기 reject, 같은 파일 재선택을 위해 `event.target.value === ""`로 초기화, Tags가 접힌 상태에서도 버튼이 보이는지 검사를 추가한다.

`frontend/tests/app-contract.test.mjs`에는 `.neo-fixed-tags__header`, 숨김 file input, 표준 `.neo-button` 사용과 generic 모델의 null importer를 고정하는 정적 검사를 추가한다.

- [ ] **Step 2: UI 테스트가 RED인지 확인한다**

Run:

```bash
node frontend/tests/ls-fixed-calls-editor.test.mjs
node frontend/tests/app-contract.test.mjs
```

Expected: `Import CSV` 버튼과 file input이 없어 FAIL.

- [ ] **Step 3: 공통 화면에 제품 주입형 CSV Import UI를 구현한다**

`frontend/src/App.jsx`의 제품 import에 alias를 추가한다.

```js
import { tagCsvImporter as productTagCsvImporter } from "@product";
```

`FixedProviderCallsEditor`에 다음 state/ref/handler를 둔다.

```js
const tagCsvInputRef = useRef(null);
const [tagCsvError, setTagCsvError] = useState(null);

const importTags = async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  try {
    if (!file || !productTagCsvImporter || !selection) return;
    const text = await file.text();
    const tags = productTagCsvImporter.apply(text, selection.tags || [], Number(fixedCallInput(call, "DataCount")));
    updateSelection({ ...selection, tags });
    setTagCsvError(null);
  } catch (failure) {
    setTagCsvError(failure);
  } finally {
    input.value = "";
  }
};
```

Call을 바꾸거나 삭제할 때 `tagCsvError`도 비운다. Tags summary는 버튼 하나가 전체 폭을 독점하지 않도록 header wrapper로 바꾼다.

```jsx
<section className={`neo-fixed-tags${tagsOpen ? " is-open" : ""}`}>
  <div className="neo-fixed-tags__header">
    <button type="button" className="neo-fixed-tags__summary" ...>...</button>
    {productTagCsvImporter ? <>
      <input ref={tagCsvInputRef} className="neo-visually-hidden" aria-label="Import Tags CSV"
        type="file" accept=".csv,text/csv" onChange={importTags} />
      <button type="button" className="neo-button" onClick={() => tagCsvInputRef.current?.click()}>Import CSV</button>
    </> : null}
  </div>
  {tagCsvError ? <p className="neo-message neo-message--error" role="alert">{tagCsvError.message}</p> : null}
  {tagsOpen && selection ? <FixedProviderTagsEditor ... /> : null}
</section>
```

`frontend/src/styles.css`는 기존 토큰만 사용해 header를 flex로 배치한다. summary는 남은 너비를 차지하고 Import 버튼은 고정 크기로 오른쪽에 둔다. 기존 Tags 좌우 경계와 접힘 높이는 유지한다.

```css
.neo-fixed-tags__header { display: flex; min-width: 0; align-items: center; gap: 8px; }
.neo-fixed-tags__header > .neo-fixed-tags__summary { min-width: 0; flex: 1; }
.neo-fixed-tags__header > .neo-button { margin-right: 16px; flex: 0 0 auto; }
.neo-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
```

`8px`은 `DESIGN.md`의 `small-gap`, `16px`은 `grid-gap` 값이다. 다른 spacing이나 색을 추가하지 않는다.

- [ ] **Step 4: 선택 Call/원자 반영 UI가 GREEN인지 확인한다**

Run:

```bash
node frontend/tests/ls-fixed-calls-editor.test.mjs
node frontend/tests/app-contract.test.mjs
npm --prefix frontend test
```

Expected: 전체 frontend 테스트 PASS.

- [ ] **Step 5: 기본 build 후 UI 단위를 커밋한다**

Run:

```bash
npm run build
git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/ls-fixed-calls-editor.test.mjs frontend/tests/app-contract.test.mjs
git commit -m "feat: import LS method call tags from CSV"
```

Expected: generic build 성공. 기존 DataViewer/Database/proxy 변경과 root HTML은 스테이징하지 않는다.

---

### Task 3: LS build와 저장 회귀 검증

**Files:**
- Test only: `frontend/tests/ls-tag-csv-import.test.mjs`
- Test only: `frontend/tests/ls-fixed-calls-editor.test.mjs`
- Test only: `frontend/tests/model-contract.test.mjs`
- Test only: `tests/product-build.test.cjs`

**Interfaces:**
- Consumes: Task 1의 parser와 Task 2의 UI
- Produces: LS 전용 노출, generic 미노출, 기존 Job 직렬화 호환의 검증 근거

- [ ] **Step 1: CSV 적용 후 기존 직렬화 형식을 검사한다**

`frontend/tests/ls-tag-csv-import.test.mjs`에 CSV 결과를 기존 `serializeJobConfig`에 넣어 `name`, `bias`, `multiplier`, `transformOrder`만 저장되고 `nameMode`가 제거되는 테스트를 추가한다.

```js
const imported = applyLsTagCsv("name,bias,multiplier,order\nCUSTOM,2,3,1\n", tags, 1);
const serialized = serializeJobConfig({ ...config, methodCalls: [{ ...call, outputSelections: [{ ...selection, tags: imported }] }] });
assert.deepEqual(serialized.methodCalls[0].outputSelections[0].tags[0], {
  name: "CUSTOM", bias: 2, multiplier: 3, transformOrder: ["multiplier", "bias"],
});
```

- [ ] **Step 2: 관련 회귀 테스트 전체를 실행한다**

Run:

```bash
npm --prefix frontend test
npm run test:products
```

Expected: 모든 테스트 PASS.

- [ ] **Step 3: LS 산출물을 검증한 뒤 generic 산출물로 복원한다**

Run:

```bash
npm run build -- --target=ls
npm run build
```

Expected: 두 build 모두 성공하고, 마지막 root 산출물은 generic이다. `cgi-bin/provider.json`이 없고 `cgi-bin/interfaces.d`가 비어 있어야 한다.

- [ ] **Step 4: 커밋 범위와 worktree를 확인한다**

Run:

```bash
git diff --check
git status --short
git log -3 --oneline
```

Expected: CSV 구현 커밋에는 계획에 적은 제품/frontend/test 파일만 포함된다. 기존 DataViewer, Database, `frontend/neo-proxy.json`, 생성 이미지는 그대로 미커밋 상태다.

- [ ] **Step 5: 필요하면 마지막 테스트 보완만 커밋한다**

Task 3에서 새 직렬화 테스트가 추가된 경우에만 실행한다.

```bash
npm run build
git add frontend/tests/ls-tag-csv-import.test.mjs
git commit -m "test: cover LS tag CSV serialization"
```

Expected: generic build 성공, 테스트 파일만 커밋됨.
