# DBus Method Display Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide internal DBus Method IDs and show English source and required-state badges in the Method detail modal.

**Architecture:** `App.jsx` renders the Method name and parameter details. Add a small presentational badge helper there, then use it for `Discovered`, `Required`, and `Optional`. Reuse the existing method-card styles and only add the compact badge style required by the design tokens.

**Tech Stack:** React, Vite, node:test, react-test-renderer.

## Global Constraints

- Do not expose a Method `id` in the Interface Method detail modal.
- Use English badge text: `Discovered`, `Required`, `Optional`.
- A missing `required` value means `Required`; only explicit `false` means `Optional`.
- Keep DBus API payloads and stored data unchanged.

---

### Task 1: Method detail display

**Files:**
- Modify: `frontend/tests/app-contract.test.mjs`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: Method `{id, member, source, inputs, outputs}` and Parameter `{name, type, required?}`.
- Produces: Method detail UI with no `id` text and English badges.

- [x] **Step 1: Write the failing UI test**

Add a discovered Method with one omitted `required` input and one `required: false` output. Assert the rendered text includes `Discovered`, `Required`, and `Optional`, and does not include the Method ID or `required: omitted`.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `node --test frontend/tests/app-contract.test.mjs`

Expected: FAIL because the modal currently renders the Method ID and technical required text.

- [x] **Step 3: Write the minimal implementation**

Add a badge element with class `neo-dbus-method-badge`. Replace the detail-only Method ID/source line with a `Discovered` badge when `source === "discovered"`. Replace technical required text with a `Required` badge unless `required === false`, then render `Optional`.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `node --test frontend/tests/app-contract.test.mjs`

Expected: PASS.

- [x] **Step 5: Build the deployable HTML**

Run: `cd frontend && npm run build:root`

Expected: PASS and refresh `index.html` and `main.html`.
