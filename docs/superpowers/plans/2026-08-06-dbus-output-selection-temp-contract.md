# DBus Output Selection Temporary Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job의 Method Call마다 여러 DBus 출력 선택과 Tags를 저장·검증·호출할 수 있게 만든다.

**Architecture:** 출력 Type은 저장된 Interface Method의 `outputs`에서 읽고, Job Call은 `outputSelections[]`로 Neo `body`의 출력 인자와 JSON Pointer를 선택한다. 기본 해석은 DBus Type 그대로이며, string 출력만 `interpretation: "json"`으로 JSON을 해석할 수 있다. Backend decoder가 선택값과 Tag 수를 실행 때 검증하고, FE는 Call별 Interface/Method와 출력 선택 UI를 만든다.

**Tech Stack:** React/Vite, Node.js `node:test`, Neo JSH CommonJS CGI.

## Global Constraints

- 이 구현의 계약 기준은 `docs/specs/DBUS_OUTPUT_SELECTION_TEMP_CONTRACT.md`다.
- Neo DBus module은 수정하지 않는다.
- 예상 반환 개수와 LS 전용 Tag 생성 규칙을 사용하지 않는다.
- Job 저장은 최소 한 Method Call을 요구한다.

---

### Task 1: Output selection backend model and decoder

**Files:**
- Modify: `cgi-bin/src/jobs/validator.js`, `cgi-bin/src/output/decoder.js`, `cgi-bin/src/collector/cycle.js`, `cgi-bin/src/dbus/test-call.js`
- Test: `cgi-bin/tests/collector-primitives.test.cjs`, `cgi-bin/tests/jobs-validator.test.cjs`

- [x] Write failing tests for one `single` selection, one array `each` selection, JSON Pointer failure, and mismatched Tag count.
- [x] Replace Method Call `tags` validation with `outputSelections` validation, including unique IDs and continuous Tag indexes per selection.
- [x] Decode `body[sourceIndex]`, apply JSON Pointer, return one value for `single` or array values for `each`.
- [x] Build collector rows from every output selection and append only after all selections decode successfully.
- [x] Remove the LS-specific `outputDefinition`, `expectedCount`, and generated Tag logic from Test Call and collector paths.
- [x] Run `node --test cgi-bin/tests/*.test.cjs`.

### Task 2: Call-level Interface/Method and output selection UI

**Files:**
- Modify: `frontend/src/App.jsx`, `frontend/src/model.js`
- Test: `frontend/tests/app-contract.test.mjs`, `frontend/tests/model-contract.test.mjs`

- [x] Write failing tests for an empty new Job draft, two Calls with different Interface IDs, and output selection Tag generation/deletion.
- [x] Start new Job drafts with no Method Calls and create a blank Call from `Add Call`.
- [x] Load Interface details by Interface ID and make every Call select its own Interface and Method.
- [x] Replace `Add Output Tag` with output selection controls and a `Tags` generator using Prefix/Count.
- [x] Use the selected stored Method output as the `sourceIndex`; selector input and value type do not depend on Test Call preview (CCR-039).
- [x] Run `npm test` and `npm run build:root` in `frontend`.

### Task 3: Temporary contract linkage and migration boundary

**Files:**
- Modify: `docs/specs/DBUS_SDD.md`, `docs/specs/FE_DESIGN.md`, `docs/specs/BE_DESIGN.md`
- Test: existing contract tests

- [x] Add a temporary-contract reference and explicit removal of LS expected-count behavior.
- [x] State that legacy `tags` Jobs remain readable but are not editable under this temporary contract.
- [x] Run the affected frontend and CGI test suites.

### Task 4: String JSON interpretation

**Files:**
- Modify: `cgi-bin/src/jobs/validator.js`, `cgi-bin/src/output/decoder.js`, `frontend/src/model.js`, `frontend/src/App.jsx`
- Test: `cgi-bin/tests/collector-primitives.test.cjs`, `frontend/tests/model-contract.test.mjs`

- [x] Write failing tests proving that a native string stays a string and that `interpretation: "json"` selects `/data` from a JSON string.
- [x] Add `interpretation: "native"|"json"` to every new output selection; accept `json` only for an Introspection string output.
- [x] Decode JSON only after selecting a string body value, then apply the existing JSON Pointer and array/Tag count rules.
- [x] Show `Native string` / `Parse as JSON` only for a selected string output. CCR-039 then replaced the Test Call JSON value selector with direct selector input.
- [x] Run `node --test cgi-bin/tests/*.test.cjs`, `npm --prefix frontend test`, and `npm --prefix frontend run build:root -- --with-ls-interface`.

### Task 5: Direct selector and storage type

**Files:**
- Modify: `cgi-bin/src/jobs/validator.js`, `cgi-bin/src/output/decoder.js`, `frontend/src/model.js`, `frontend/src/App.jsx`
- Test: `cgi-bin/tests/collector-primitives.test.cjs`, `frontend/tests/model-contract.test.mjs`

- [x] Write failing tests for a JSON selector with numeric array elements and for the new serialized selection fields.
- [x] Replace `path`/`mode` in newly saved selections with `selector`/`valueType`/`elementType`, while retaining legacy selections only for reading old Jobs.
- [x] Validate and decode numeric, string, JSON, and array selection values before Tag rows are created.
- [x] Remove the Test Call-dependent JSON value selector and `Store` control; show direct Selector, Value type, and Array element type inputs instead.
- [x] Run the complete CGI and frontend regression suites and frontend build.
