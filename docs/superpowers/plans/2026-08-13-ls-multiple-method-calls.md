# LS Multiple Method Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LS 제품의 고정 `GetDeviceData` Call을 한 Job에 여러 개 추가·선택·정렬·삭제하고, 확정된 master-detail 화면에서 Call별 입력과 Tag를 독립적으로 편집한다.

**Architecture:** 제품별 고정값 생성과 검증은 `products/ls` 모듈에 유지하고, 공통 `App.jsx`에는 LS 제품에서만 호출되는 master-detail editor를 둔다. Job의 `methodCalls` 배열이 유일한 저장 상태이며 선택 Call과 Tags 접힘 여부는 component local state로만 관리한다. Backend는 배열의 첫 Call만 보지 않고 모든 Call을 동일한 LS 고정 규칙으로 검증한다.

**Tech Stack:** React 19, Vite 6, JavaScript ESM/CommonJS, Node `node:test`, React Test Renderer, 기존 CSS Design System

## Global Constraints

- LS Job은 `ls-plc-device/get-device-data` 고정 Method Call을 하나 이상 가진다.
- 모든 LS Call의 Output은 `Return → JSON → /data → array(numeric)` 한 개다.
- generic 제품의 Method Call 화면과 검증은 바꾸지 않는다.
- `DeviceString` 저장·호출값은 `%` 정규형이고 화면에서는 수정 불가 `%` 접두사를 사용한다.
- DeviceString과 DataCount는 같은 너비의 두 열이며 순서는 DeviceString, DataCount다.
- Tags disclosure의 바깥 좌우 경계는 입력 행과 정확히 같고 기본 접힘이다.
- 새 색상·간격·radius를 만들지 않고 `DESIGN.md`의 `grid-gap`, `card-padding`, `border`, `input-surface`, `rounded.control`만 사용한다.
- Git에 남는 생성 산출물은 인자 없는 `npm run build`의 generic 결과여야 한다.
- `frontend/neo-proxy.json`은 사용자 로컬 변경이므로 수정·스테이징·커밋하지 않는다.

---

### Task 1: LS 제품 모델과 Backend 다중 Call 계약

**Files:**
- Modify: `products/ls/frontend/model.mjs:22-45`
- Modify: `products/generic/frontend/model.mjs`
- Modify: `products/ls/backend/index.js:10-27`
- Test: `tests/product-modules.test.mjs:20-58`
- Test: `frontend/tests/defaults-contract.test.mjs:25-60`

**Interfaces:**
- Produces: `appendProductMethodCall(calls: MethodCall[], provider: ProviderProfile): MethodCall[]`
- Produces: `resolveJobFormMode({ settings, settingsLoading, settingsError, editing }): "blocked"|"fixed"|"generic"`
- Preserves: `createInitialMethodCalls(provider): MethodCall[]`
- Consumes: Provider의 `interfaceId`, `methodId`, `outputSelections`

- [ ] **Step 1: Frontend 제품 모델 실패 테스트 작성**

`tests/product-modules.test.mjs`와 `frontend/tests/defaults-contract.test.mjs`에 다음 동작을 추가한다.

```js
const initial = ls.createInitialMethodCalls(provider);
const twoCalls = ls.appendProductMethodCall(initial, provider);
assert.equal(twoCalls.length, 2);
assert.equal(twoCalls[0], initial[0]);
assert.notEqual(twoCalls[1].id, twoCalls[0].id);
assert.notEqual(twoCalls[1].outputSelections, twoCalls[0].outputSelections);
twoCalls[1].outputSelections[0].tags.push({ name: "MW10" });
assert.deepEqual(twoCalls[0].outputSelections[0].tags, []);

assert.equal(ls.resolveJobFormMode({ settings: { provider }, editing: true }), "fixed");
assert.deepEqual(generic.appendProductMethodCall(initial, provider), initial);
```

- [ ] **Step 2: 제품 모델 테스트가 실패하는지 확인**

Run: `node --test tests/product-modules.test.mjs frontend/tests/defaults-contract.test.mjs`

Expected: `appendProductMethodCall is not a function`과 LS Edit mode의 `generic !== fixed`로 FAIL.

- [ ] **Step 3: 고유 ID를 만드는 최소 제품 helper 구현**

`products/ls/frontend/model.mjs`에 아래 helper를 추가하고 초기 Call 생성도 같은 helper를 사용한다.

```js
function nextCallId(calls, methodId) {
  const used = new Set((calls || []).map((call) => call.id));
  let sequence = 1;
  while (used.has(`${methodId}-${sequence}`)) sequence += 1;
  return `${methodId}-${sequence}`;
}

export function appendProductMethodCall(calls = [], provider) {
  if (provider?.jobMode !== 'fixed') return [...calls];
  return [...calls, {
    id: nextCallId(calls, provider.methodId),
    name: provider.methodId,
    interfaceId: provider.interfaceId,
    methodId: provider.methodId,
    inputs: {},
    outputSelections: clone(provider.outputSelections || []),
  }];
}

export function createInitialMethodCalls(provider) {
  return provider?.jobMode === 'fixed' ? appendProductMethodCall([], provider) : [];
}
```

LS `resolveJobFormMode`는 Provider가 fixed이면 `editing`과 관계없이 `fixed`를 반환한다. Generic 모듈에는 빌드 시 같은 named export가 존재하도록 입력 배열을 복사해 반환하는 no-op을 추가한다.

```js
export function appendProductMethodCall(calls = []) {
  return [...calls];
}
```

- [ ] **Step 4: Backend 다중 Call 실패 테스트 작성**

`tests/product-modules.test.mjs`의 LS Backend 테스트를 다음 검증으로 바꾼다.

```js
const second = structuredClone(config.methodCalls[0]);
second.id = 'get-device-data-2';
second.inputs = { DataCount: 1, DeviceString: '%MW10' };
second.outputSelections[0].tags = [{ name: 'MW10', bias: 0, multiplier: 1 }];
const multiple = { ...config, methodCalls: [config.methodCalls[0], second] };
assert.equal(lsBackend.validateProductConfig(multiple), multiple);
assert.throws(() => lsBackend.validateProductConfig({ ...config, methodCalls: [] }), /at least one Method Call/);

const invalidSecond = structuredClone(multiple);
invalidSecond.methodCalls[1].outputSelections[0].selector = '/other';
assert.throws(() => lsBackend.validateProductConfig(invalidSecond), /fixed output/);
```

- [ ] **Step 5: Backend가 모든 Call을 검증하도록 최소 구현**

`products/ls/backend/index.js`에서 exact-one 검사를 최소-one 검사와 배열 순회로 바꾼다.

```js
function validateProductConfig(config) {
  const calls = config && config.methodCalls;
  if (!Array.isArray(calls) || calls.length < 1) invalid('LS jobs require at least one Method Call.');
  calls.forEach((call, callIndex) => {
    if (call.interfaceId !== 'ls-plc-device' || call.methodId !== 'get-device-data') {
      invalid('LS jobs require the fixed GetDeviceData Method.', { callIndex, interfaceId: call.interfaceId, methodId: call.methodId });
    }
    const selections = call.outputSelections;
    const selection = Array.isArray(selections) && selections.length === 1 ? selections[0] : null;
    if (!selection || selection.sourceIndex !== 0 || selection.interpretation !== 'json'
      || selection.selector !== '/data' || selection.valueType !== 'array' || selection.elementType !== 'numeric') {
      invalid('LS jobs require the fixed output mapping.', { callIndex });
    }
    if (!Array.isArray(selection.tags) || selection.tags.length !== call.inputs.DataCount) {
      invalid('LS job Tag count must match DataCount.', { callIndex, dataCount: call.inputs.DataCount });
    }
  });
  return config;
}
```

- [ ] **Step 6: 제품 단위 테스트 통과 확인**

Run: `node --test tests/product-modules.test.mjs frontend/tests/defaults-contract.test.mjs`

Expected: 모든 테스트 PASS.

- [ ] **Step 7: 기본 Generic build 후 Task 1 커밋**

Run: `npm run build`

Expected: exit 0이고 root 생성 산출물이 generic target임.

```bash
git add products/ls/frontend/model.mjs products/generic/frontend/model.mjs products/ls/backend/index.js tests/product-modules.test.mjs frontend/tests/defaults-contract.test.mjs
git commit -m "feat: allow multiple fixed LS method calls"
```

---

### Task 2: LS master-detail Method Calls 편집기

**Files:**
- Modify: `frontend/src/App.jsx:5-6,486-530,575-677,892-894,1347`
- Modify: `frontend/src/styles.css:253-328`
- Create: `frontend/tests/ls-fixed-calls-editor.test.mjs`
- Modify: `frontend/tests/app-contract.test.mjs:145-170`
- Modify: `frontend/package.json:scripts.test:layout`

**Interfaces:**
- Consumes: `appendProductMethodCall(calls, provider)` from Task 1
- Produces: `FixedProviderCallsEditor({ calls, methodsByInterface, provider, setCalls, onTest })`
- Preserves: `reconcileProductTags`, `productInputPrefix`, `productDisplayInputValue`, `productStoreInputValue`
- State boundary: `selectedCallId: string`와 `tagsOpen: boolean`은 React local state이며 payload에 포함하지 않는다.

- [ ] **Step 1: LS 편집기 상호작용 실패 테스트 작성**

`frontend/tests/ls-fixed-calls-editor.test.mjs`는 Vite SSR alias를 LS 제품으로 지정하고 export된 editor를 React Test Renderer로 렌더한다.

```js
const vite = await createServer({
  configFile: false,
  root: new URL('..', import.meta.url).pathname,
  resolve: { alias: { '@product': new URL('../../products/ls/frontend/index.jsx', import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false },
  ssr: { external: ['react', 'react-router'] },
  appType: 'custom',
  logLevel: 'error',
});
const { FixedProviderCallsEditor } = await vite.ssrLoadModule('/src/App.jsx');
const buttonText = (root, text) => root.findAll((node) => node.type === 'button' && node.children.join('').includes(text))[0];
const button = (root, label) => root.findAll((node) => node.type === 'button' && node.props['aria-label'] === label)[0];
```

`currentCalls`, LS Profile, `ls-plc-device`의 GetDeviceData Method fixture를 만들고
`setCalls`가 함수형 update와 배열 교체를 모두 처리한 뒤 renderer를 갱신하게 한다.
다음 내용을 각각 검증한다.

```js
assert.ok(buttonText(renderer.root, 'Add Call'));
assert.equal(renderer.root.findAllByProps({ 'aria-label': 'DeviceString' }).length, 1);
assert.equal(renderer.root.findAllByProps({ 'aria-label': 'DataCount' }).length, 1);
assert.ok(renderer.root.findAll((node) => node.children?.join('') === 'ls-plc-device · get-device-data').length);

await act(async () => buttonText(renderer.root, 'Add Call').props.onClick());
assert.equal(currentCalls.length, 2);
assert.notEqual(currentCalls[0].id, currentCalls[1].id);

assert.equal(button(renderer.root, `${currentCalls[0].id} Remove`).props.disabled, false);
currentCalls = [currentCalls[0]];
rerender();
assert.equal(button(renderer.root, `${currentCalls[0].id} Remove`).props.disabled, true);
```

두 번째 행 선택 후 첫 행과 다른 입력이 표시되는지, Tags summary가 기본 닫힘인지,
선택 변경 뒤 다시 닫히는지, Test Call이 선택 Call을 받는지도 검증한다.

- [ ] **Step 2: 새 LS 편집기 테스트가 실패하는지 확인**

Run: `node --test frontend/tests/ls-fixed-calls-editor.test.mjs`

Expected: `FixedProviderCallsEditor` export 또는 `Add Call`을 찾지 못해 FAIL.

- [ ] **Step 3: 단일 Call editor를 master-detail editor로 교체**

`frontend/src/App.jsx`의 `FixedProviderCallEditor`를 `FixedProviderCallsEditor`로 바꾼다. 선택은 ID로 추적해 reorder 뒤에도 같은 Call을 유지한다.

```jsx
function FixedProviderCallsEditor({ calls, methodsByInterface, provider, setCalls, onTest }) {
  const [selectedCallId, setSelectedCallId] = useState(calls[0]?.id || '');
  const [tagsOpen, setTagsOpen] = useState(false);
  const selectedIndex = Math.max(0, calls.findIndex((call) => call.id === selectedCallId));
  const call = calls[selectedIndex];
  const method = (methodsByInterface[call?.interfaceId]?.interface?.methods || [])
    .find((item) => item.id === call?.methodId);

  useEffect(() => {
    if (!calls.some((item) => item.id === selectedCallId)) setSelectedCallId(calls[0]?.id || '');
  }, [calls, selectedCallId]);

  const selectCall = (id) => {
    setSelectedCallId(id);
    setTagsOpen(false);
  };
  const updateCall = (index, nextCall) => setCalls((current) => current.map((item, itemIndex) => itemIndex === index ? nextCall : item));
  const addCall = () => setCalls((current) => appendProductMethodCall(current, provider));
  const moveCall = (from, to) => setCalls((current) => reorder(current, from, to));
  const removeSelected = () => {
    if (calls.length === 1) return;
    const nextSelectedId = calls[selectedIndex - 1]?.id || calls[selectedIndex + 1]?.id || '';
    setCalls((current) => current.filter((item) => item.id !== call.id));
    setSelectedCallId(nextSelectedId);
    setTagsOpen(false);
  };
}
```

`Add Call`은 `appendProductMethodCall`, reorder는 기존 `reorder`를 사용한다. 삭제는
Call이 둘 이상일 때만 허용하고 선택 Call 삭제 뒤 이전 Call, 첫 Call 삭제 뒤 다음
Call을 선택한다. drag는 각 목록 행의 `.neo-drag`에서만 시작한다.

- [ ] **Step 4: 선택 상세의 입력과 Tag 편집 구현**

상세 상단에 아래 고정 식별자와 action을 둔다.

```jsx
<p className="neo-fixed-calls__method neo-mono">{call.interfaceId} · {call.methodId}</p>
<span className="neo-actions">
  <button type="button" className="neo-link-button" onClick={() => onTest(call, method)}>Test Call</button>
  <IconButton icon="delete" label={`${call.id} Remove`} disabled={calls.length === 1} onClick={removeSelected} />
</span>
```

Method 입력 순서와 관계없이 `DeviceString`, `DataCount` 순으로 정렬하고 같은 2열
grid에 표시한다. Call input 변경은 선택 Call 하나만 바꾸고, 기존 자동·수동 Tag
보존 로직을 그 Call에만 적용한다.

Tags summary와 펼친 editor는 아래 구조를 사용한다.

```jsx
<section className={`neo-fixed-tags${tagsOpen ? ' is-open' : ''}`}>
  <button type="button" className="neo-fixed-tags__summary" aria-expanded={tagsOpen} onClick={() => setTagsOpen((open) => !open)}>
    <strong>TAGS</strong><span>{tagSummary(tags)}</span><Icon name={tagsOpen ? 'expand_less' : 'expand_more'} />
  </button>
  {tagsOpen ? <FixedProviderTagsEditor selection={selection} onChange={updateSelection} /> : null}
</section>
```

`FixedProviderTagsEditor`는 `#`, `TAG NAME`, `TRANSFORM` 열을 제공한다. 이름 변경은
`nameMode:"manual"`을 기록하고, 숫자 Transform은 기존 `bias`, `multiplier`,
`transformOrder` drag 로직을 재사용한다. LS 자동 Tag 수를 사용자가 깨뜨리지 않도록
Tag 삭제 버튼은 만들지 않는다.

- [ ] **Step 5: JobForm이 전체 LS Call 배열을 읽고 쓰도록 연결**

첫 Call만 보정하던 effect를 모든 Call에 적용한다.

```js
return {
  ...current,
  methodCalls: current.methodCalls.map((call) => {
    const method = (interfaceDetails[call.interfaceId]?.interface?.methods || []).find((item) => item.id === call.methodId);
    if (!method) return call;
    const defaults = createMethodCall({ ...method, inputs: (method.inputs || []).map((input) => ({ ...input, id: input.id || input.name })) }, call.id, call.interfaceId).inputs;
    return { ...call, inputs: { ...defaults, ...(call.inputs || {}) } };
  }),
};
```

렌더 분기는 전체 배열과 setter를 전달한다.

```jsx
fixedNewJob ? <FixedProviderCallsEditor
  calls={config.methodCalls}
  methodsByInterface={interfaceDetails}
  provider={provider}
  setCalls={(update) => setConfig((current) => ({ ...current, methodCalls: typeof update === 'function' ? update(current.methodCalls) : update }))}
  onTest={testCall}
/> : <MethodCallsEditor
  calls={config.methodCalls}
  interfaces={loaded.data?.[0] || []}
  interfaceDetails={interfaceDetails}
  testResult={testResult}
  setCalls={(update) => setConfig((current) => ({ ...current, methodCalls: typeof update === 'function' ? update(current.methodCalls) : update }))}
  onTest={testCall}
/>
```

- [ ] **Step 6: 확정 시안에 맞는 CSS 작성**

`DESIGN.md` 값만 사용해 다음 핵심 geometry를 만든다.

```css
.neo-fixed-calls { padding: 0; overflow: hidden; }
.neo-fixed-calls__header { padding: 32px; border-bottom: 1px solid var(--neo-border); }
.neo-fixed-calls__body { display: grid; min-height: calc(var(--neo-row-height) * 16); grid-template-columns: minmax(calc(var(--neo-row-height) * 10), .34fr) minmax(0, 1fr); }
.neo-fixed-calls__list { min-width: 0; border-right: 1px solid var(--neo-border); }
.neo-fixed-calls__detail { min-width: 0; padding: 24px 32px 32px; }
.neo-fixed-calls__inputs { display: grid; width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.neo-fixed-tags { width: 100%; margin: 24px 0 0; border: 1px solid var(--neo-border); border-radius: var(--neo-radius); }
```

Tags에 음수 margin을 주지 않는다. `neo-fixed-calls__inputs`와 `neo-fixed-tags`는 같은
`.neo-fixed-calls__detail` 직계 영역에서 `width:100%`를 사용해 좌우 경계를 맞춘다.
작은 화면에서는 master-detail을 한 열로 쌓고, 640px 이하에서는 입력도 한 열로
바꾼다.

- [ ] **Step 7: Frontend 계약 테스트와 test script 갱신**

`frontend/tests/app-contract.test.mjs`는 다음 source/CSS 경계를 확인한다.

```js
assert.match(source, /function FixedProviderCallsEditor/);
assert.match(source, /appendProductMethodCall/);
assert.match(source, /fixedNewJob \? <FixedProviderCallsEditor/);
assert.match(styles, /\.neo-fixed-calls__inputs[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(styles, /\.neo-fixed-tags \{[^}]*width: 100%;[^}]*margin: 24px 0 0;/);
assert.doesNotMatch(styles, /\.neo-fixed-tags \{[^}]*margin-left:\s*-/);
```

`frontend/package.json`의 `test:layout`에
`node tests/ls-fixed-calls-editor.test.mjs`를 추가한다.

- [ ] **Step 8: Frontend 전체 테스트 통과 확인**

Run: `npm --prefix frontend test`

Expected: 기존 generic UI 테스트와 새 LS editor 테스트가 모두 PASS.

- [ ] **Step 9: 기본 Generic build 후 Task 2 커밋**

Run: `npm run build`

Expected: exit 0이고 root 생성 산출물은 generic target이며 `frontend/neo-proxy.json`은 stage되지 않음.

```bash
git add frontend/src/App.jsx frontend/src/styles.css frontend/tests/ls-fixed-calls-editor.test.mjs frontend/tests/app-contract.test.mjs frontend/package.json
git commit -m "feat: add LS method call master detail editor"
```

---

### Task 3: 제품 회귀·LS build·시각 QA

**Files:**
- Modify if P0/P1/P2 mismatch is found: `frontend/src/App.jsx`
- Modify if P0/P1/P2 mismatch is found: `frontend/src/styles.css`
- Create: `design-qa.md`

**Interfaces:**
- Consumes: Task 1의 다중 Call 모델·validator와 Task 2의 `FixedProviderCallsEditor`
- Produces: `design-qa.md` with `final result: passed`
- Reference image: `/Users/trycatch/.codex/generated_images/019fcf6b-8066-7a13-b989-003aa0197687/exec-898d503b-922c-49dd-84fe-7c132d96aa4c.png`

- [ ] **Step 1: 전체 자동 테스트 실행**

Run: `node --test cgi-bin/tests/*.test.cjs`

Expected: 전체 Backend 테스트 PASS.

Run: `npm --prefix frontend test`

Expected: 전체 Frontend 테스트 PASS.

Run: `npm run test:products`

Expected: generic/LS 제품 모듈과 build 경계 테스트 PASS.

- [ ] **Step 2: LS 완성 package build 확인**

Run: `npm run build -- --target=ls`

Expected: exit 0, `cgi-bin/product/index.js`의 target은 `ls`, `cgi-bin/provider.json`은 `id:"ls"`, 세 HTML에 `Add Call`과 LS master-detail editor가 포함됨.

- [ ] **Step 3: 사용자가 선택한 in-app Browser에서 실제 상호작용 확인**

LS build를 로컬 dev server로 열고 다음을 확인한다.

1. 새 Job에 Call 하나가 선택된 상태로 표시된다.
2. `Add Call`을 두 번 눌러 세 Call이 되고 ID와 Tag가 서로 공유되지 않는다.
3. 목록 drag handle에서만 순서가 바뀌고 선택 Call은 유지된다.
4. DeviceString 변경은 선택 Call의 자동 Tag만 바꾼다.
5. 수동 Tag 이름과 Transform은 같은 Call·index에서 유지된다.
6. 마지막 Call 삭제가 비활성화된다.
7. Test Call은 선택 Call의 ID를 요청한다.
8. Tags를 펼친 뒤 다른 Call을 선택하면 다시 접힌다.

- [ ] **Step 4: 확정 이미지와 같은 viewport로 Design QA 수행**

Product Design `design-qa` 절차로 reference와 실제 캡처를 같은 viewport·상태에서
비교한다. `design-qa.md`에는 최소한 아래 항목을 판정한다.

```markdown
- Method identity: ls-plc-device · get-device-data is visible
- Input order: DeviceString, DataCount
- Input geometry: equal widths and 16px gap
- Tags geometry: same left and right outer edges as the input row
- Tags initial state: collapsed
- Master-detail: selected list row and right detail are visually connected
- final result: passed
```

P0/P1/P2가 있으면 `App.jsx` 또는 `styles.css`만 최소 수정하고 실제 캡처와 비교를
반복한다. P3는 문서에 후속 사항으로 남겨도 된다.

- [ ] **Step 5: 최종 Generic build와 작업 트리 경계 확인**

Run: `npm run build`

Expected: exit 0이고 Git에 남는 생성 산출물은 generic target이다.

Run: `git status --short`

Expected: Task 3 수정 파일과 `design-qa.md`만 표시되며 `frontend/neo-proxy.json`은 기존 사용자 변경으로 unstaged 상태를 유지한다.

- [ ] **Step 6: Task 3 QA 결과 커밋**

Generic build 성공 뒤 `design-qa.md`와 실제로 수정된 UI 파일만 커밋한다. UI 수정이
없으면 QA 파일만 커밋한다.

```bash
git add design-qa.md frontend/src/App.jsx frontend/src/styles.css
git commit -m "fix: align LS method call editor with approved design"
```
