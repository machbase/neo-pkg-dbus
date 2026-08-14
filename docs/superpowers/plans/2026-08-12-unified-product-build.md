# Unified Product Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 한 저장소에서 같은 `neo-pkg-dbus`를 generic 또는 LS로 선택 빌드하고, 기본 build와 Git 완성 산출물은 항상 generic이 되게 한다.

**Architecture:** 공통 source는 현재 `frontend/`와 `cgi-bin/src/`에 유지하고 제품 차이만 `products/generic`, `products/ls`에 둔다. 루트 build script는 target을 고른 뒤 임시 staging에서 Frontend와 제품 Backend·Profile·Interface를 준비하고, 검증 성공 뒤 생성 영역만 교체한다.

**Tech Stack:** Node.js CommonJS/ESM, Vite 6, React 19, Machbase Neo JSH CommonJS, Node test runner

## Global Constraints

- package 이름은 모든 target에서 `neo-pkg-dbus`, version은 루트와 CGI가 같은 `1.0.0`이다.
- 최소 Neo version은 `8.5.6`이다.
- 인자 없는 `npm run build`는 `generic`이다.
- Git에는 generic 완성 산출물만 둔다.
- build는 `frontend/src`, `cgi-bin/src`, `products`, `scripts`, `docs`, `cgi-bin/conf.d`를 바꾸지 않는다.
- 기존 DataViewer와 `frontend/neo-proxy.json` 미커밋 변경은 수정하거나 이 작업 커밋에 넣지 않는다.

---

### Task 1: Target parser와 manifest identity

**Files:**
- Create: `scripts/product-build.js`
- Create: `tests/product-build.test.cjs`
- Modify: `package.json`
- Modify: `cgi-bin/package.json`

**Interfaces:**
- Produces: `parseTarget(args): "generic" | "ls"`
- Produces: `assertManifestIdentity(root): {name, version, minServerVersion}`

- [x] **Step 1: Write the failing test**

```js
test('인자 없는 build는 generic이고 package identity는 하나다', () => {
  assert.equal(parseTarget([]), 'generic');
  assert.equal(parseTarget(['--target=ls']), 'ls');
  assert.equal(rootManifest.name, 'neo-pkg-dbus');
  assert.deepEqual(pick(rootManifest), pick(cgiManifest));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test tests/product-build.test.cjs`
Expected: FAIL because `scripts/product-build.js` does not exist and manifests still use the LS package name.

- [x] **Step 3: Write minimal implementation**

```js
function parseTarget(args) {
  if (!args.length || args[0] === '--target=generic') return 'generic';
  if (args.length === 1 && args[0] === '--target=ls') return 'ls';
  throw new Error(`Unsupported build target: ${args.join(' ')}`);
}
```

Add root scripts `build` and `test:products`; synchronize both manifests to `neo-pkg-dbus`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test tests/product-build.test.cjs`
Expected: PASS.

---

### Task 2: Product source boundary and generated Backend assets

**Files:**
- Create: `products/generic/backend/index.js`
- Create: `products/ls/backend/index.js`
- Create: `products/generic/frontend/index.jsx`
- Create: `products/ls/frontend/index.jsx`
- Move source: `build-assets/providers/ls/profile.json` → `products/ls/provider.json`
- Move source: `build-assets/interfaces/ls-plc-device.json` → `products/ls/interfaces/ls-plc-device.json`
- Modify: `scripts/product-build.js`
- Modify: `tests/product-build.test.cjs`
- Modify: `frontend/vite.config.js`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/model.js`

**Interfaces:**
- Frontend modules export `productTarget`, `showsInterfaceManagement(provider)`, `createInitialMethodCalls(provider)`, `reconcileProductTags(inputs,tags,provider)`.
- Backend modules export `target` and `validateProductConfig(config)`.
- Build copies exactly one Backend module to `cgi-bin/product/index.js`.

- [x] **Step 1: Write failing target-boundary tests**

```js
test('generic output contains no LS asset and LS output contains only LS assets', () => {
  buildTarget(fixture, 'ls');
  assert.equal(readProductTarget(fixture), 'ls');
  assert.equal(readProvider(fixture).id, 'ls');
  buildTarget(fixture, 'generic');
  assert.equal(readProductTarget(fixture), 'generic');
  assert.equal(existsProvider(fixture), false);
  assert.deepEqual(readInterfaces(fixture), []);
});
```

- [x] **Step 2: Verify RED**

Run: `node --test tests/product-build.test.cjs`
Expected: FAIL because `products/` and `cgi-bin/product/` do not exist.

- [x] **Step 3: Implement product modules and asset generation**

Build in a staging directory, validate source files first, then replace only:

```js
const GENERATED = ['cgi-bin/product', 'cgi-bin/provider.json', 'cgi-bin/interfaces.d'];
prepareProductBackend({ root, target, staging });
installGeneratedBackend({ root, staging, generated: GENERATED });
```

Vite resolves `@product` to `products/<target>/frontend/index.jsx`. Common App delegates target decisions to that module instead of comparing an LS ID.

- [x] **Step 4: Verify GREEN**

Run: `node --test tests/product-build.test.cjs frontend/tests/model-contract.test.mjs`
Expected: PASS.

---

### Task 3: Root Frontend build and failure-safe replacement

**Files:**
- Modify: `scripts/product-build.js`
- Modify: `frontend/scripts/build-root.mjs`
- Modify: `frontend/tests/build-ls-interface.test.mjs`
- Modify: `tests/product-build.test.cjs`

**Interfaces:**
- `buildPackage({root,target,runFrontend})` returns after all generated files are installed.
- `npm run build` invokes `buildPackage` with target `generic`.

- [x] **Step 1: Write failing end-to-end build tests**

```js
test('failed build preserves the previous generated package', () => {
  writePreviousOutputs(root);
  assert.throws(() => buildPackage({ root, target: 'ls', runFrontend() { throw new Error('fail'); } }));
  assert.equal(readMain(root), 'previous');
  assert.equal(readProductTarget(root), 'previous');
});
```

Also run real generic and LS builds in a disposable copied fixture and assert all three HTML files and target assets.

- [x] **Step 2: Verify RED**

Run: `node --test tests/product-build.test.cjs`
Expected: FAIL because the current build mutates Provider assets before Frontend succeeds.

- [x] **Step 3: Implement staging and atomic-per-file replacement**

```js
buildFrontendTo(stagingRoot, target);
prepareProductBackend({ root, stagingRoot, target });
validateStaging(stagingRoot, identity, target);
replaceGeneratedOutputs(root, stagingRoot);
```

The old `--with-provider=ls` aliases are removed from the public build contract.

- [x] **Step 4: Verify GREEN**

Run: `node --test tests/product-build.test.cjs frontend/tests/build-ls-interface.test.mjs`
Expected: PASS.

---

### Task 4: Full verification and generic commit state

**Files:**
- Modify: `README.md`
- Modify: approved design/contract files already changed in this workspace

**Interfaces:**
- Consumes: root `npm run build` and target builds from Tasks 1–3.
- Produces: repository root in verified generic state.

- [x] **Step 1: Document exact commands**

Document that `npm run build` is generic, `npm run build -- --target=ls` is deployment-only, and a default build is mandatory before commit.

- [x] **Step 2: Run target and regression verification**

Run:

```bash
npm run test:products
node --test cgi-bin/tests/*.test.cjs
npm --prefix frontend test
npm run build -- --target=ls
npm run build
```

Expected: all tests/builds pass; final root has generic HTML, generic Backend module, no `cgi-bin/provider.json`, and empty `cgi-bin/interfaces.d`.

- [x] **Step 3: Verify source and staging boundaries**

Run: `git diff --check` and inspect `git status --short`.
Expected: DataViewer/proxy changes remain untouched; no temporary directory or LS generated artifact is staged.

- [x] **Step 4: Commit one coherent change**

Stage only architecture, build, product source, tests, generic generated outputs, and approved docs. Commit with:

```bash
git commit -m "feat: unify generic and LS product builds"
```
