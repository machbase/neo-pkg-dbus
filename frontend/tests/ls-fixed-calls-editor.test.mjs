import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const vite = await createServer({
  configFile: false,
  root: new URL("..", import.meta.url).pathname,
  resolve: { alias: { "@product": new URL("../../products/ls/frontend/index.jsx", import.meta.url).pathname } },
  server: { middlewareMode: true, hmr: false },
  ssr: { external: ["react", "react-router"] },
  appType: "custom",
  logLevel: "error",
});
const { FixedProviderCallsEditor } = await vite.ssrLoadModule("/src/App.jsx");
const provider = JSON.parse(fs.readFileSync(new URL("../../products/ls/provider.json", import.meta.url), "utf8"));
const interfaceDefinition = JSON.parse(fs.readFileSync(new URL("../../products/ls/interfaces/ls-plc-device.json", import.meta.url), "utf8"));
const methodsByInterface = { "ls-plc-device": { interface: interfaceDefinition } };
const method = interfaceDefinition.methods[0];
const LS_CALL_DRAG_TYPE = "application/x-neo-ls-method-call-index";

after(async () => { await vite.close(); });

const buttonText = (root, text) => root.findAll((node) => node.type === "button" && node.children.join("").includes(text))[0];
const button = (root, label) => root.findAll((node) => node.type === "button" && node.props["aria-label"] === label)[0];
const input = (root, label) => root.findAllByProps({ "aria-label": label })[0];
const tagsSummary = (root) => root.findAll((node) => node.type === "button" && String(node.props.className || "").includes("neo-fixed-tags__summary"))[0];
const selectedCallButton = (root) => root.findAll((node) => node.type === "button" && String(node.props.className || "").includes("neo-fixed-calls__select") && node.props["aria-pressed"] === true)[0];

function dragTransfer() {
  const values = new Map();
  return {
    types: [],
    effectAllowed: "",
    dragImage: null,
    setData(type, value) {
      if (!this.types.includes(type)) this.types.push(type);
      values.set(type, value);
    },
    getData(type) { return values.get(type) || ""; },
    setDragImage(element, offsetX, offsetY) { this.dragImage = { element, offsetX, offsetY }; },
  };
}

function fixedCall(id, deviceString = "%MB3", dataCount = 1) {
  const address = deviceString.slice(1).replace(/\d+$/, "");
  const start = Number(deviceString.match(/\d+$/)?.[0] || 0);
  return {
    id,
    name: id,
    interfaceId: "ls-plc-device",
    methodId: "get-device-data",
    inputs: { DeviceString: deviceString, DataCount: dataCount },
    outputSelections: [{
      ...structuredClone(provider.outputSelections[0]),
      tags: Array.from({ length: dataCount }, (_, index) => ({
        name: `${address}${start + index}`,
        nameMode: "auto",
        bias: 0,
        multiplier: 1,
        transformOrder: ["bias", "multiplier"],
      })),
    }],
  };
}

async function renderCalls(initialCalls, onTest = () => {}, options = {}) {
  let currentCalls = structuredClone(initialCalls);
  let currentTestResult = options.testResult || null;
  let renderer;
  const rerender = () => renderer.update(React.createElement(FixedProviderCallsEditor, {
    calls: currentCalls,
    methodsByInterface,
    provider,
    testResult: currentTestResult,
    setCalls(update) {
      currentCalls = typeof update === "function" ? update(currentCalls) : update;
      rerender();
    },
    onTest,
    onClearTest() {
      currentTestResult = null;
      rerender();
    },
  }));
  await act(async () => {
    renderer = create(React.createElement(FixedProviderCallsEditor, {
      calls: currentCalls,
      methodsByInterface,
      provider,
      testResult: currentTestResult,
      setCalls(update) {
        currentCalls = typeof update === "function" ? update(currentCalls) : update;
        rerender();
      },
      onTest,
      onClearTest() {
        currentTestResult = null;
        rerender();
      },
    }));
  });
  return { renderer, calls: () => currentCalls, testResult: () => currentTestResult, rerender };
}

test("LS Test Call 결과는 실행한 Call 상세 안에만 보이고 Clear로 지운다", async () => {
  const result = {
    callId: "get-device-data-1",
    success: true,
    durationMs: 31,
    valueCount: 1,
    values: ['{"data":[11]}'],
    body: { ok: true },
  };
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB0", 1),
    fixedCall("get-device-data-2", "%MW10", 2),
  ], () => {}, { testResult: result });
  const { renderer } = harness;

  assert.equal(renderer.root.findAllByProps({ "aria-label": "get-device-data-1 Test Call result" }).length, 1);
  assert.equal(buttonText(renderer.root, "Clear").props.type, "button");

  await act(async () => button(renderer.root, "get-device-data-2 Select").props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-label": "get-device-data-1 Test Call result" }).length, 0);

  await act(async () => button(renderer.root, "get-device-data-1 Select").props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-label": "get-device-data-1 Test Call result" }).length, 1);
  await act(async () => buttonText(renderer.root, "Clear").props.onClick());
  assert.equal(harness.testResult(), null);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "get-device-data-1 Test Call result" }).length, 0);
  await act(async () => renderer.unmount());
});

test("LS Call 목록 shell은 Test Call로 늘어난 상세 높이를 함께 채운다", async () => {
  const result = {
    callId: "get-device-data-1",
    success: true,
    durationMs: 5,
    valueCount: 1,
    values: ['{"data":[11]}'],
  };
  const { renderer } = await renderCalls([
    fixedCall("get-device-data-1", "%MB0", 1),
  ], () => {}, { testResult: result });

  const shell = renderer.root.findAll((node) => String(node.props.className || "").includes("neo-fixed-calls__list-shell"))[0];
  const scrollList = shell.findAll((node) => String(node.props.className || "").split(" ").includes("neo-fixed-calls__list"))[0];
  assert.ok(shell);
  assert.ok(scrollList);
  assert.equal(scrollList.findAllByType("article").length, 1);
  await act(async () => renderer.unmount());
});

test("LS fixed 편집기는 Call을 추가하고 마지막 Call 한 개는 삭제하지 못하게 한다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1")]);
  const { renderer } = harness;

  assert.match(buttonText(renderer.root, "Add Call").props.className, /neo-button/);
  assert.doesNotMatch(buttonText(renderer.root, "Add Call").props.className, /neo-link-button/);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "DeviceString" }).length, 1);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "DataCount" }).length, 1);
  assert.ok(renderer.root.findAll((node) => node.children?.join("") === "ls-plc-device · get-device-data").length);
  assert.match(buttonText(renderer.root, "Test Call").props.className, /neo-button/);
  assert.doesNotMatch(buttonText(renderer.root, "Test Call").props.className, /neo-link-button/);

  await act(async () => buttonText(renderer.root, "Add Call").props.onClick());
  assert.equal(harness.calls().length, 2);
  assert.notEqual(harness.calls()[0].id, harness.calls()[1].id);
  assert.deepEqual(harness.calls()[1].outputSelections[0].tags.map((tag) => tag.name), ["MB0"]);
  assert.equal(selectedCallButton(renderer.root).props["aria-label"], `${harness.calls()[1].id} Select`);
  assert.equal(button(renderer.root, `${harness.calls()[1].id} Remove`).props.disabled, false);

  const first = harness.calls()[0];
  await act(async () => {
    renderer.update(React.createElement(FixedProviderCallsEditor, {
      calls: [first], methodsByInterface, provider, setCalls() {}, onTest() {},
    }));
  });
  assert.equal(button(renderer.root, `${first.id} Remove`).props.disabled, true);
  await act(async () => renderer.unmount());
});

test("LS fixed 편집기는 선택 Call만 보여 주고 선택을 바꾸면 Tags를 닫는다", async () => {
  const tested = [];
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB3", 1),
    fixedCall("get-device-data-2", "%MW10", 2),
  ], (...args) => tested.push(args));
  const { renderer } = harness;

  assert.equal(input(renderer.root, "DeviceString").props.value, "MB3");
  assert.equal(input(renderer.root, "DataCount").props.value, 1);
  assert.equal(tagsSummary(renderer.root).props["aria-expanded"], false);

  await act(async () => button(renderer.root, "get-device-data-2 Select").props.onClick());
  assert.equal(input(renderer.root, "DeviceString").props.value, "MW10");
  assert.equal(input(renderer.root, "DataCount").props.value, 2);
  assert.equal(tagsSummary(renderer.root).props["aria-expanded"], false);

  await act(async () => tagsSummary(renderer.root).props.onClick());
  assert.equal(tagsSummary(renderer.root).props["aria-expanded"], true);
  assert.equal(input(renderer.root, "MW10 Tag Name").props.value, "MW10");

  await act(async () => input(renderer.root, "MW10 Tag Name").props.onChange({ target: { value: "MANUAL_MW10" } }));
  assert.equal(harness.calls()[1].outputSelections[0].tags[0].name, "MANUAL_MW10");
  assert.equal(harness.calls()[1].outputSelections[0].tags[0].nameMode, "manual");
  assert.equal(harness.calls()[0].outputSelections[0].tags[0].name, "MB3");

  await act(async () => button(renderer.root, "get-device-data-1 Select").props.onClick());
  assert.equal(tagsSummary(renderer.root).props["aria-expanded"], false);
  await act(async () => button(renderer.root, "get-device-data-2 Select").props.onClick());
  await act(async () => buttonText(renderer.root, "Test Call").props.onClick());
  assert.equal(tested.length, 1);
  assert.equal(tested[0][0].id, "get-device-data-2");
  assert.equal(tested[0][1].id, method.id);
  await act(async () => renderer.unmount());
});

test("LS fixed 입력 변경은 선택 Call의 자동 Tag만 다시 만든다", async () => {
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB3", 1),
    fixedCall("get-device-data-2", "%MW10", 2),
  ]);
  const { renderer } = harness;

  await act(async () => button(renderer.root, "get-device-data-2 Select").props.onClick());
  await act(async () => button(renderer.root, "Toggle DeviceString address picker").props.onClick());
  await act(async () => input(renderer.root, "DeviceString address preview").props.onChange({ target: { value: "%MD100" } }));
  await act(async () => buttonText(renderer.root, "Apply").props.onClick());
  await act(async () => input(renderer.root, "DataCount").props.onChange({ target: { value: "3" } }));

  assert.equal(harness.calls()[0].inputs.DeviceString, "%MB3");
  assert.deepEqual(harness.calls()[0].outputSelections[0].tags.map((tag) => tag.name), ["MB3"]);
  assert.equal(harness.calls()[1].inputs.DeviceString, "%MD100");
  assert.equal(harness.calls()[1].inputs.DataCount, 3);
  assert.deepEqual(harness.calls()[1].outputSelections[0].tags.map((tag) => tag.name), ["MD100", "MD101", "MD102"]);
  await act(async () => renderer.unmount());
});

test("LS DeviceString은 바깥 값을 읽기 전용으로 표시하고 팝오버에서 전체 주소를 편집한다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1", "%MB3", 1)]);
  const { renderer } = harness;

  assert.equal(input(renderer.root, "DeviceString").props.readOnly, true);
  assert.equal(input(renderer.root, "DeviceString").props.value, "MB3");
  assert.equal(input(renderer.root, "DeviceString").props.onClick instanceof Function, true);
  assert.equal(button(renderer.root, "Toggle DeviceString address picker").props["aria-expanded"], false);
  await act(async () => input(renderer.root, "DeviceString").props.onClick());
  assert.equal(button(renderer.root, "Toggle DeviceString address picker").props["aria-expanded"], true);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "DeviceString address picker" }).length, 1);
  assert.notEqual(input(renderer.root, "DeviceString address preview").props.readOnly, true);
  assert.match(buttonText(renderer.root, "Apply").props.className, /\bneo-button\b/);
  assert.match(buttonText(renderer.root, "Apply").props.className, /\bneo-button--primary\b/);
  assert.doesNotMatch(buttonText(renderer.root, "Apply").props.className, /\bneo-link-button\b/);

  await act(async () => input(renderer.root, "DeviceString address preview").props.onChange({ target: { value: "%MD100" } }));
  await act(async () => buttonText(renderer.root, "Apply").props.onClick());

  assert.equal(harness.calls()[0].inputs.DeviceString, "%MD100");
  assert.equal(input(renderer.root, "DeviceString").props.value, "MD100");
  assert.equal(button(renderer.root, "Toggle DeviceString address picker").props["aria-expanded"], false);
  await act(async () => renderer.unmount());
});

test("LS DeviceString 선택기는 숫자 스피너와 세 부분 선택을 제공한다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1", "%MB3", 1)]);
  const { renderer } = harness;
  await act(async () => button(renderer.root, "Toggle DeviceString address picker").props.onClick());

  assert.equal(input(renderer.root, "DeviceString address").props.type, "number");
  assert.equal(input(renderer.root, "DeviceString address").props.min, "0");
  assert.equal(input(renderer.root, "DeviceString address").props.step, "1");
  assert.equal(input(renderer.root, "DeviceString address").props.value, "3");
  assert.ok(button(renderer.root, "DeviceString address Increase"));
  assert.ok(button(renderer.root, "DeviceString address Decrease"));

  await act(async () => input(renderer.root, "DeviceString memory area").props.onChange({ target: { value: "M" } }));
  await act(async () => input(renderer.root, "DeviceString data type").props.onChange({ target: { value: "W" } }));
  await act(async () => input(renderer.root, "DeviceString address").props.onChange({ target: { value: "10" } }));
  await act(async () => buttonText(renderer.root, "Apply").props.onClick());

  assert.equal(harness.calls()[0].inputs.DeviceString, "%MW10");
  assert.equal(input(renderer.root, "DeviceString").props.value, "MW10");
  assert.equal(button(renderer.root, "Toggle DeviceString address picker").props["aria-expanded"], false);
  await act(async () => renderer.unmount());
});

test("LS 빈 DeviceString Address는 0이고 DataCount는 1 아래로 내려가지 않는다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1", "%", 1)]);
  const { renderer } = harness;
  await act(async () => button(renderer.root, "Toggle DeviceString address picker").props.onClick());

  assert.equal(input(renderer.root, "DeviceString address").props.value, "0");
  assert.equal(input(renderer.root, "DataCount").props.min, "1");
  assert.ok(button(renderer.root, "DataCount Increase"));
  assert.ok(button(renderer.root, "DataCount Decrease"));
  await act(async () => button(renderer.root, "DataCount Decrease").props.onClick());
  assert.equal(harness.calls()[0].inputs.DataCount, 1);
  await act(async () => renderer.unmount());
});

test("LS DeviceString 선택기는 Memory Area와 Data Type 목록을 하나만 연다", async () => {
  const { renderer } = await renderCalls([fixedCall("get-device-data-1", "%MB3", 1)]);
  await act(async () => button(renderer.root, "Toggle DeviceString address picker").props.onClick());

  await act(async () => button(renderer.root, "Toggle DeviceString memory area options").props.onClick());
  const areaOptions = renderer.root.findAllByProps({ "aria-label": "DeviceString memory area options" });
  assert.equal(areaOptions.length, 1);
  assert.deepEqual(areaOptions[0].findAllByType("button").map((item) => item.props.children), ["A", "F", "I", "Q", "M", "K", "R", "W"]);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "DeviceString data type options" }).length, 0);

  await act(async () => button(renderer.root, "Toggle DeviceString data type options").props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-label": "DeviceString memory area options" }).length, 0);
  const typeOptions = renderer.root.findAllByProps({ "aria-label": "DeviceString data type options" });
  assert.equal(typeOptions.length, 1);
  assert.deepEqual(typeOptions[0].findAllByType("button").map((item) => item.props.children), ["X", "B", "W", "D", "L"]);
  await act(async () => renderer.unmount());
});

test("LS fixed Call은 handle만 drag source이고 drop하면 실제 순서가 바뀐다", async () => {
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB3", 1),
    fixedCall("get-device-data-2", "%MW10", 2),
  ]);
  const { renderer } = harness;
  const articles = () => renderer.root.findAll((node) => node.type === "article" && String(node.props.className || "").includes("neo-fixed-calls__item"));
  const handle = renderer.root.findAllByProps({ "aria-label": "get-device-data-1 Drag to reorder" })[0];

  assert.equal(articles()[0].props.draggable, undefined);
  assert.equal(handle.props.draggable, true);
  const dataTransfer = dragTransfer();
  const row = { getBoundingClientRect: () => ({ left: 100, top: 40, width: 280, height: 64 }) };
  await act(async () => handle.props.onDragStart({
    currentTarget: { closest: () => row },
    clientX: 112,
    clientY: 54,
    dataTransfer,
    stopPropagation() {},
  }));
  assert.deepEqual(dataTransfer.types, [LS_CALL_DRAG_TYPE]);
  assert.deepEqual(dataTransfer.dragImage, { element: row, offsetX: 12, offsetY: 14 });
  let prevented = 0;
  await act(async () => articles()[1].props.onDragOver({ dataTransfer, preventDefault() { prevented += 1; } }));
  await act(async () => articles()[1].props.onDrop({ dataTransfer, preventDefault() { prevented += 1; } }));

  assert.equal(prevented, 2);
  assert.deepEqual(harness.calls().map((call) => call.id), ["get-device-data-2", "get-device-data-1"]);
  assert.equal(selectedCallButton(renderer.root).props["aria-label"], "get-device-data-1 Select");
  await act(async () => renderer.unmount());
});

test("LS fixed Call은 외부 text/plain dragover와 drop을 무시한다", async () => {
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB3", 1),
    fixedCall("get-device-data-2", "%MW10", 2),
  ]);
  const { renderer } = harness;
  const articles = renderer.root.findAll((node) => node.type === "article" && String(node.props.className || "").includes("neo-fixed-calls__item"));
  const dataTransfer = dragTransfer();
  dataTransfer.setData("text/plain", "0");
  let prevented = 0;

  await act(async () => articles[1].props.onDragOver({ dataTransfer, preventDefault() { prevented += 1; } }));
  await act(async () => articles[1].props.onDrop({ dataTransfer, preventDefault() { prevented += 1; } }));

  assert.equal(prevented, 0);
  assert.deepEqual(harness.calls().map((call) => call.id), ["get-device-data-1", "get-device-data-2"]);
  await act(async () => renderer.unmount());
});

test("LS fixed 중간 Call을 삭제하면 이전 Call을 선택한다", async () => {
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB3", 1),
    fixedCall("get-device-data-2", "%MW10", 2),
    fixedCall("get-device-data-3", "%MD100", 3),
  ]);
  const { renderer } = harness;

  await act(async () => button(renderer.root, "get-device-data-2 Select").props.onClick());
  await act(async () => button(renderer.root, "get-device-data-2 Remove").props.onClick());

  assert.deepEqual(harness.calls().map((call) => call.id), ["get-device-data-1", "get-device-data-3"]);
  assert.equal(selectedCallButton(renderer.root).props["aria-label"], "get-device-data-1 Select");
  await act(async () => renderer.unmount());
});

test("LS fixed 첫 Call을 삭제하면 다음 Call을 선택한다", async () => {
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB3", 1),
    fixedCall("get-device-data-2", "%MW10", 2),
  ]);
  const { renderer } = harness;

  await act(async () => button(renderer.root, "get-device-data-1 Remove").props.onClick());

  assert.deepEqual(harness.calls().map((call) => call.id), ["get-device-data-2"]);
  assert.equal(selectedCallButton(renderer.root).props["aria-label"], "get-device-data-2 Select");
  await act(async () => renderer.unmount());
});

test("LS fixed 빈 Tags 요약은 0 tags로 표시한다", async () => {
  const empty = fixedCall("get-device-data-1", "%MB3", 1);
  empty.outputSelections[0].tags = [];
  const { renderer } = await renderCalls([empty]);

  assert.match(JSON.stringify(renderer.toJSON()), /0 tags/);
  await act(async () => renderer.unmount());
});

test("LS Tag Transform은 공통 숫자 Stepper로 Bias와 Multiplier를 변경한다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1", "%MB0", 1)]);
  const { renderer } = harness;

  await act(async () => tagsSummary(renderer.root).props.onClick());
  assert.ok(button(renderer.root, "MB0 Bias Increase"));
  assert.ok(button(renderer.root, "MB0 Bias Decrease"));
  assert.ok(button(renderer.root, "MB0 Multiplier Increase"));
  assert.ok(button(renderer.root, "MB0 Multiplier Decrease"));

  await act(async () => button(renderer.root, "MB0 Bias Decrease").props.onClick());
  await act(async () => button(renderer.root, "MB0 Multiplier Increase").props.onClick());
  assert.equal(harness.calls()[0].outputSelections[0].tags[0].bias, -1);
  assert.equal(harness.calls()[0].outputSelections[0].tags[0].multiplier, 2);
  await act(async () => renderer.unmount());
});

test("LS Import CSV는 접힌 Tags에서 선택 Call만 즉시 치환하고 부족한 뒤 Tag를 유지한다", async () => {
  const harness = await renderCalls([
    fixedCall("get-device-data-1", "%MB0", 3),
    fixedCall("get-device-data-2", "%MW10", 2),
  ]);
  const { renderer } = harness;
  const importButton = buttonText(renderer.root, "Import CSV");
  const fileInput = input(renderer.root, "Import Tags CSV");

  assert.equal(tagsSummary(renderer.root).props["aria-expanded"], false);
  assert.match(importButton.props.className, /neo-button/);
  assert.equal(fileInput.props.type, "file");
  assert.match(fileInput.props.accept, /\.csv/);

  const tagsHeader = renderer.root.findAll((node) => String(node.props.className || "").includes("neo-fixed-tags__header"))[0];
  const visibleControls = tagsHeader.findAll((node) => node.type === "button");
  assert.equal(visibleControls[0].props.className, "neo-fixed-tags__summary");
  assert.equal(visibleControls[1].children.join(""), "Import CSV");
  assert.equal(visibleControls[2].props["aria-label"], "Toggle Tags");

  const target = {
    files: [{ text: async () => "name,bias,multiplier,order\nCUSTOM,2,3,1\n" }],
    value: "tags.csv",
  };
  await act(async () => fileInput.props.onChange({ currentTarget: target, target }));

  const first = harness.calls()[0].outputSelections[0].tags;
  assert.equal(first[0].name, "CUSTOM");
  assert.equal(first[0].nameMode, "manual");
  assert.equal(first[0].bias, 2);
  assert.equal(first[0].multiplier, 3);
  assert.deepEqual(first[0].transformOrder, ["multiplier", "bias"]);
  assert.deepEqual(first.slice(1).map((tag) => tag.name), ["MB1", "MB2"]);
  assert.deepEqual(harness.calls()[1].outputSelections[0].tags.map((tag) => tag.name), ["MW10", "MW11"]);
  assert.equal(target.value, "");
  await act(async () => renderer.unmount());
});

test("LS Import CSV 오류는 Tag를 바꾸지 않고 오류를 표시한다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1", "%MB0", 1)]);
  const { renderer } = harness;
  const before = structuredClone(harness.calls());
  const fileInput = input(renderer.root, "Import Tags CSV");
  const target = {
    files: [{ text: async () => "name,bias,multiplier,order\n,0,1,0\n" }],
    value: "bad.csv",
  };

  await act(async () => fileInput.props.onChange({ currentTarget: target, target }));

  assert.deepEqual(harness.calls(), before);
  assert.match(renderer.root.findAllByProps({ role: "alert" })[0].children.join(""), /name/i);
  assert.equal(target.value, "");
  await act(async () => renderer.unmount());
});

test("LS Import CSV 파일 읽기 실패는 Tag를 바꾸지 않고 오류를 표시한다", async () => {
  const harness = await renderCalls([fixedCall("get-device-data-1", "%MB0", 1)]);
  const { renderer } = harness;
  const before = structuredClone(harness.calls());
  const fileInput = input(renderer.root, "Import Tags CSV");
  const target = {
    files: [{ text: async () => { throw new Error("CSV file could not be read."); } }],
    value: "broken.csv",
  };

  await act(async () => fileInput.props.onChange({ currentTarget: target, target }));

  assert.deepEqual(harness.calls(), before);
  assert.match(renderer.root.findAllByProps({ role: "alert" })[0].children.join(""), /could not be read/i);
  assert.equal(target.value, "");
  await act(async () => renderer.unmount());
});
