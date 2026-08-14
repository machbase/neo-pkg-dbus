# LS DeviceString Fixed Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LS Job 사용자는 주소 본문만 입력하고, 패키지는 저장·Test Call·수집 호출에 유효한 `%` 포함 `DeviceString`을 사용한다.

**Architecture:** 공통 Job 화면은 제품 모듈이 제공하는 입력 표시값·저장값·고정 접두사를 사용한다. generic 모듈은 항등 변환을 유지하고 LS 모듈만 `DeviceString`을 `MB3` ↔ `%MB3`으로 변환한다. Backend는 LS Interface asset의 한 정규식으로 Job 저장, Test Call, collector 호출을 동일하게 검증한다.

**Tech Stack:** React 19, JavaScript ES modules, Node.js test runner, Machbase Neo package product build

## Global Constraints

- generic 제품의 입력과 동작은 바꾸지 않는다.
- LS 화면의 `%`는 수정할 수 없는 고정 접두사다.
- Job 저장값, Test Call과 collector 호출값은 `%`가 포함된 정규형이다.
- `%MB3`, `%AREA.X09`는 허용하고 `%3`, `MB3`, `%MB`, `%%MB3`는 거부한다.
- 기존 Job migration은 제공하지 않는다.
- 새 디자인 값은 추가하지 않고 `DESIGN.md`의 input surface, border, 32px 높이, 4px radius를 사용한다.
- 커밋 직전에 인자 없는 `npm run build`를 실행하고 generic 산출물만 유지한다.

---

### Task 1: 제품 입력 경계와 고정 접두사 화면

**Files:**
- Modify: `products/generic/frontend/model.mjs`
- Modify: `products/ls/frontend/model.mjs`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/tests/defaults-contract.test.mjs`
- Test: `frontend/tests/app-contract.test.mjs`

**Interfaces:**
- Produces: `inputPrefix(name): string`, `displayInputValue(name, storedValue): unknown`, `storeInputValue(name, displayValue): unknown`
- Consumes: `FixedProviderCallEditor`의 Method input 이름·저장값과 기존 `reconcileProductTags(inputs, tags, provider)`

- [x] **Step 1: 제품 변환 실패 테스트 작성**

  `frontend/tests/defaults-contract.test.mjs`에 generic 항등 변환과 LS `DeviceString` 변환을 추가한다. LS 기대값은 `inputPrefix("DeviceString") === "%"`, `displayInputValue("DeviceString", "%MB3") === "MB3"`, `storeInputValue("DeviceString", "MB3") === "%MB3"`이다. DataCount와 generic 값은 그대로여야 한다.

- [x] **Step 2: 실패 확인**

  Run: `node --test frontend/tests/defaults-contract.test.mjs`

  Expected: 새 export가 없어 import 또는 함수 호출이 실패한다.

- [x] **Step 3: 최소 제품 변환 구현**

  generic 모듈은 빈 접두사와 항등 변환을 반환한다. LS 모듈은 정규화한 input key가 `devicestring` 또는 `memoryaddress`일 때만 `%`를 반환하고, 저장값의 첫 `%`를 화면에서 제외하며, 화면값 앞에 `%`를 붙여 저장값을 만든다. 다른 input은 그대로 반환한다.

- [x] **Step 4: 고정 접두사 렌더링 실패 테스트 작성**

  `frontend/tests/app-contract.test.mjs`에서 `FixedProviderCallEditor`가 제품의 세 함수를 사용하고, 접두사가 있을 때 `neo-input-prefix` wrapper와 읽기 전용 `%` 표시를 렌더하도록 요구한다. 입력 변경은 화면값을 `storeInputValue`로 바꾼 뒤 기존 `updateInputs`와 Tag 재계산으로 전달해야 한다.

- [x] **Step 5: 실패 확인**

  Run: `node --test frontend/tests/app-contract.test.mjs`

  Expected: 제품 변환 import와 접두사 wrapper가 없어 실패한다.

- [x] **Step 6: 공통 화면과 스타일 최소 구현**

  `frontend/src/App.jsx`의 제품 import에 세 함수를 추가한다. `FixedProviderCallEditor`에서 Method input별 표시값과 접두사를 계산하고, 접두사가 있으면 `%` span과 기존 input을 하나의 32px control처럼 렌더한다. `frontend/src/styles.css`에는 `--neo-input-surface`, `--neo-border`, `--neo-radius`, 32px 높이만 사용해 wrapper·prefix·내부 input 경계를 정의한다.

- [x] **Step 7: Frontend GREEN 확인**

  Run: `node --test frontend/tests/defaults-contract.test.mjs frontend/tests/app-contract.test.mjs`

  Expected: 모두 PASS.

### Task 2: LS 정규형 검증과 전체 회귀

**Files:**
- Modify: `products/ls/interfaces/ls-plc-device.json`
- Modify: `cgi-bin/src/dbus/arguments.js`
- Test: `frontend/tests/build-ls-interface.test.mjs`
- Test: `cgi-bin/tests/collector-primitives.test.cjs`

**Interfaces:**
- Consumes: Interface input `validation.pattern`
- Produces: `%`로 시작하고 숫자로 끝나며 중간 본문이 있고 추가 `%`가 없는 `DeviceString` 계약

- [x] **Step 1: Interface 검증 실패 테스트 작성**

  두 테스트의 기대 pattern을 `^%[^%]+[0-9]+$`로 바꾸고, `buildTypedArguments`가 Interface input의 `validation.pattern`을 적용해 `%MB3`과 `%AREA.X09`는 허용하지만 `%3`, `MB3`, `%MB`, `%%MB3`는 거부하는 사례를 추가한다.

- [x] **Step 2: 실패 확인**

  Run: `node --test frontend/tests/build-ls-interface.test.mjs cgi-bin/tests/collector-primitives.test.cjs`

  Expected: asset의 기존 `^%.*[0-9]+$` 때문에 pattern 기대값과 잘못된 입력 거부 사례가 실패한다.

- [x] **Step 3: LS Interface pattern 최소 수정**

  `products/ls/interfaces/ls-plc-device.json`의 `DeviceString.validation.pattern`을 `^%[^%]+[0-9]+$`로 바꾼다. `cgi-bin/src/dbus/arguments.js`는 type 인코딩 전에 input의 pattern이 문자열 값과 맞는지 검사하고 `DBUS_ARGUMENT_INVALID`을 반환한다. 별도 보정 로직이나 LS 전용 Backend 분기는 추가하지 않는다.

- [x] **Step 4: Backend·asset GREEN 확인**

  Run: `node --test frontend/tests/build-ls-interface.test.mjs cgi-bin/tests/collector-primitives.test.cjs`

  Expected: 모두 PASS.

- [x] **Step 5: 전체 회귀 테스트**

  Run: `node --test cgi-bin/tests/*.test.cjs`

  Run: `npm --prefix frontend test`

  Run: `npm run test:products`

  Expected: 모든 테스트 PASS.

- [x] **Step 6: generic 기본 빌드와 LS 임시 빌드 확인**

  Run: `node scripts/product-build.js --target=ls`

  LS 산출물의 `cgi-bin/interfaces.d/ls-plc-device.json` pattern과 `cgi-bin/product/index.js` target을 확인한다.

  Run: `npm run build`

  Expected: 두 build 모두 성공하고, 마지막 generic build 뒤 Git 작업 루트에는 `provider.json`이 없고 `interfaces.d`가 비어 있으며 product target이 `generic`이다.

- [x] **Step 7: 구현 커밋**

  승인된 문서, 제품 모듈, 공통 화면·스타일, LS Interface asset과 관련 테스트만 스테이징한다. 기존 `frontend/neo-proxy.json`과 DataViewer 변경은 제외한다.

  Commit: `feat: add fixed LS DeviceString prefix`
