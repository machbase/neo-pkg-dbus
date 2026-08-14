import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import React from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const previousWindow = globalThis.window;
const listeners = new Map();
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener(type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  },
  removeEventListener(type, listener) {
    listeners.get(type)?.delete(listener);
  },
};

async function dispatchWindow(type, event = {}) {
  await act(async () => {
    for (const listener of [...(listeners.get(type) || [])]) listener(event);
  });
}

const vite = await createServer({
  configFile: false,
  root: new URL("..", import.meta.url).pathname,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { external: ["react"] },
  appType: "custom",
  logLevel: "error",
});
const { default: LiveLogs } = await vite.ssrLoadModule("/src/live-logs/LiveLogs.jsx");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

after(async () => {
  await vite.close();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const cancelled = [];
  return {
    schedule(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    cancelSchedule(id) {
      cancelled.push(id);
      pending.delete(id);
    },
    async runNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, "실행할 polling timer가 있어야 한다");
      const [id, timer] = entry;
      pending.delete(id);
      assert.equal(timer.delay, 1000);
      await act(async () => {
        timer.callback();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    pending,
    cancelled,
  };
}

function nodeText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return (node?.children || []).map(nodeText).join("");
}

function buttonText(root, text) {
  return root.findAll((node) => node.type === "button" && nodeText(node).includes(text))[0];
}

function bodyText(root) {
  return nodeText(root.findByProps({ "aria-label": "Live log lines" }));
}

function statusText(root) {
  return nodeText(root.findByProps({ className: "neo-live-logs__meta neo-live-logs__status" }));
}

function cssBlock(selector) {
  const ruleStart = styles.indexOf(selector);
  assert.notEqual(ruleStart, -1, `${selector} CSS 규칙이 있어야 한다`);
  const bodyStart = styles.indexOf("{", ruleStart);
  let depth = 0;
  for (let index = bodyStart; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") depth -= 1;
    if (depth === 0) return styles.slice(bodyStart + 1, index);
  }
  assert.fail(`${selector} CSS 규칙이 닫혀 있어야 한다`);
}

async function renderLive(logsApi, timers, props = {}) {
  const panelRect = { left: 540, top: 384, width: 460, height: 360 };
  const panelNode = { getBoundingClientRect: () => ({ ...panelRect }) };
  const bodyNode = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(LiveLogs, {
      jobName: "line-a",
      open: true,
      onClose() {},
      logsApi,
      schedule: timers.schedule,
      cancelSchedule: timers.cancelSchedule,
      ...props,
    }), {
      createNodeMock(element) {
        if (element.type === "section") return panelNode;
        if (element.props?.["aria-label"] === "Live log lines") return bodyNode;
        return {};
      },
    });
  });
  return { renderer, panelNode, panelRect, bodyNode };
}

test("open 시 active file을 찾아 tail을 읽고 unmount 시 timer와 요청을 정리한다", async () => {
  const timers = fakeTimers();
  const tailCalls = [];
  let requestSignal;
  let closed = 0;
  const logsApi = {
    list: async (_name, options) => {
      requestSignal = options.signal;
      return { files: [{ name: "old.log", active: false }, { name: "job.log", active: true }] };
    },
    tail: async (_name, file, options) => {
      tailCalls.push(file);
      requestSignal = options.signal;
      return { name: "line-a", file, lines: ["[INFO] ready"], totalLines: 1 };
    },
  };

  const { renderer } = await renderLive(logsApi, timers, { onClose: () => { closed += 1; } });
  await flush();

  assert.deepEqual(tailCalls, ["job.log"]);
  assert.equal(bodyText(renderer.root), "[INFO] ready");
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs__level neo-live-logs__level--info" }).children.join(""), "[INFO]");
  assert.equal(timers.pending.size, 1);
  assert.equal(requestSignal.aborted, false);

  await act(async () => buttonText(renderer.root, "Close").props.onClick());
  assert.equal(closed, 1);
  assert.equal(timers.pending.size, 0);
  assert.equal(requestSignal.aborted, true);

  await act(async () => renderer.unmount());
  assert.equal(timers.pending.size, 0);
  assert.ok(timers.cancelled.length > 0);
  assert.equal(requestSignal.aborted, true);
});

test("빠른 Pause와 Resume은 옛 요청을 abort하고 즉시 새 요청 하나만 시작한다", async () => {
  const timers = fakeTimers();
  const firstTail = deferred();
  const secondTail = deferred();
  const thirdTail = deferred();
  const signals = [];
  let tailCount = 0;
  const logsApi = {
    list: async () => ({ files: [{ name: "job.log", active: true }] }),
    tail: async (_name, _file, options) => {
      tailCount += 1;
      signals.push(options.signal);
      if (tailCount === 1) return firstTail.promise;
      if (tailCount === 2) return secondTail.promise;
      return thirdTail.promise;
    },
  };

  const { renderer } = await renderLive(logsApi, timers);
  await flush();
  assert.equal(tailCount, 1);

  await act(async () => buttonText(renderer.root, "Pause").props.onClick());
  assert.equal(signals[0].aborted, true);
  await act(async () => buttonText(renderer.root, "Resume").props.onClick());
  assert.equal(tailCount, 2);
  assert.equal(signals[1].aborted, false);

  await act(async () => buttonText(renderer.root, "Pause").props.onClick());
  assert.equal(signals[1].aborted, true);
  await act(async () => buttonText(renderer.root, "Resume").props.onClick());
  assert.equal(tailCount, 3);
  assert.equal(signals[2].aborted, false);

  await act(async () => {
    firstTail.resolve({ name: "line-a", file: "job.log", lines: ["[INFO] skipped"], totalLines: 1 });
    secondTail.resolve({ name: "line-a", file: "job.log", lines: ["[INFO] skipped too"], totalLines: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.doesNotMatch(bodyText(renderer.root), /skipped/);
  assert.equal(tailCount, 3);
  assert.equal(timers.pending.size, 0);

  await act(async () => {
    thirdTail.resolve({ name: "line-a", file: "job.log", lines: ["[INFO] resumed"], totalLines: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(tailCount, 3);
  assert.match(bodyText(renderer.root), /resumed/);
  assert.equal(timers.pending.size, 1);

  await act(async () => renderer.unmount());
});

test("Pause 뒤 늦은 list의 active와 active 없음 결과를 모두 무시한다", async () => {
  for (const files of [[{ name: "job.log", active: true }], []]) {
    const timers = fakeTimers();
    const waitingList = deferred();
    let tailCount = 0;
    const logsApi = {
      list: async () => waitingList.promise,
      tail: async () => {
        tailCount += 1;
        return { file: "job.log", lines: ["unexpected"], totalLines: 1 };
      },
    };

    const { renderer } = await renderLive(logsApi, timers);
    assert.equal(statusText(renderer.root), "DISCONNECTED");
    await act(async () => buttonText(renderer.root, "Pause").props.onClick());
    await act(async () => {
      waitingList.resolve({ files });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(statusText(renderer.root), "DISCONNECTED");
    assert.equal(tailCount, 0);
    assert.equal(timers.pending.size, 0);
    await act(async () => renderer.unmount());
  }
});

test("진행 중인 list와 무관하게 Resume은 새 list를 즉시 시작한다", async () => {
  const timers = fakeTimers();
  const firstList = deferred();
  const secondList = deferred();
  const signals = [];
  let listCount = 0;
  let tailCount = 0;
  const logsApi = {
    list: async (_name, options) => {
      listCount += 1;
      signals.push(options.signal);
      return listCount === 1 ? firstList.promise : secondList.promise;
    },
    tail: async () => {
      tailCount += 1;
      return { file: "job.log", lines: ["current"], totalLines: 1 };
    },
  };
  const { renderer } = await renderLive(logsApi, timers);
  assert.equal(listCount, 1);
  await act(async () => buttonText(renderer.root, "Pause").props.onClick());
  assert.equal(signals[0].aborted, true);
  await act(async () => buttonText(renderer.root, "Resume").props.onClick());
  assert.equal(listCount, 2);
  assert.equal(signals[1].aborted, false);

  await act(async () => {
    firstList.resolve({ files: [{ name: "old.log", active: true }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(tailCount, 0);
  await act(async () => {
    secondList.resolve({ files: [{ name: "job.log", active: true }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(tailCount, 1);
  assert.equal(bodyText(renderer.root), "current");
  assert.equal(timers.pending.size, 1);
  await act(async () => renderer.unmount());
});

test("Pause 뒤 늦은 active 없음과 list 오류는 CONNECTED 상태를 바꾸지 않는다", async () => {
  for (const lateResult of ["empty", "error"]) {
    const timers = fakeTimers();
    const nextList = deferred();
    let listCount = 0;
    const logsApi = {
      list: async () => {
        listCount += 1;
        if (listCount === 1) return { files: [] };
        return nextList.promise;
      },
      tail: async () => ({ file: "", lines: [], totalLines: 0 }),
    };
    const { renderer } = await renderLive(logsApi, timers);
    await flush();
    assert.equal(statusText(renderer.root), "CONNECTED");

    await timers.runNext();
    await act(async () => buttonText(renderer.root, "Pause").props.onClick());
    await act(async () => {
      if (lateResult === "empty") nextList.resolve({ files: [] });
      else nextList.reject(new Error("late list failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(statusText(renderer.root), "CONNECTED");
    assert.equal(timers.pending.size, 0);
    await act(async () => renderer.unmount());
  }
});

test("Pause 뒤 늦은 tail 오류는 CONNECTED 상태와 기존 줄을 보존한다", async () => {
  const timers = fakeTimers();
  const nextTail = deferred();
  let tailCount = 0;
  const logsApi = {
    list: async () => ({ files: [{ name: "job.log", active: true }] }),
    tail: async () => {
      tailCount += 1;
      if (tailCount === 1) return { file: "job.log", lines: ["stable"], totalLines: 1 };
      return nextTail.promise;
    },
  };
  const { renderer } = await renderLive(logsApi, timers);
  await flush();
  assert.equal(statusText(renderer.root), "CONNECTED");
  assert.equal(bodyText(renderer.root), "stable");

  await timers.runNext();
  await act(async () => buttonText(renderer.root, "Pause").props.onClick());
  await act(async () => {
    nextTail.reject(new Error("late tail failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(statusText(renderer.root), "CONNECTED");
  assert.equal(bodyText(renderer.root), "stable");
  assert.equal(timers.pending.size, 0);
  await act(async () => renderer.unmount());
});

test("Clear는 서버를 바꾸지 않고 clear 이후에 추가된 줄만 표시한다", async () => {
  const timers = fakeTimers();
  let tailCount = 0;
  const logsApi = {
    list: async () => ({ files: [{ name: "job.log", active: true }] }),
    tail: async () => {
      tailCount += 1;
      return tailCount === 1
        ? { name: "line-a", file: "job.log", lines: ["one", "two"], totalLines: 2 }
        : { name: "line-a", file: "job.log", lines: ["one", "two", "three", "four"], totalLines: 4 };
    },
  };

  const { renderer } = await renderLive(logsApi, timers);
  await flush();
  assert.equal(bodyText(renderer.root), "onetwo");

  await act(async () => buttonText(renderer.root, "Clear").props.onClick());
  assert.match(bodyText(renderer.root), /Waiting for logs/);

  await timers.runNext();
  assert.equal(bodyText(renderer.root), "threefour");

  await act(async () => renderer.unmount());
});

test("polling 오류는 기존 줄을 보존하고 다음 주기에 재시도해 연결을 복구한다", async () => {
  const timers = fakeTimers();
  let tailCount = 0;
  const logsApi = {
    list: async () => ({ files: [{ name: "job.log", active: true }] }),
    tail: async () => {
      tailCount += 1;
      if (tailCount === 2) throw new Error("temporary failure");
      return {
        name: "line-a",
        file: "job.log",
        lines: tailCount === 1 ? ["stable"] : ["stable", "recovered"],
        totalLines: tailCount === 1 ? 1 : 2,
      };
    },
  };

  const { renderer } = await renderLive(logsApi, timers);
  await flush();
  assert.equal(statusText(renderer.root), "CONNECTED");
  assert.equal(bodyText(renderer.root), "stable");

  await timers.runNext();
  assert.equal(statusText(renderer.root), "DISCONNECTED");
  assert.equal(bodyText(renderer.root), "stable");

  await timers.runNext();
  assert.equal(tailCount, 3);
  assert.equal(statusText(renderer.root), "CONNECTED");
  assert.equal(bodyText(renderer.root), "stablerecovered");

  await act(async () => renderer.unmount());
});

test("drag와 resize는 양쪽 경계로 clamp되고 listener를 unmount에서 정리한다", async () => {
  listeners.clear();
  const timers = fakeTimers();
  const waitingList = deferred();
  const logsApi = {
    list: async () => waitingList.promise,
    tail: async () => ({ file: "", lines: [], totalLines: 0 }),
  };
  const { renderer, panelRect } = await renderLive(logsApi, timers);
  const panel = renderer.root.findByProps({ className: "neo-live-logs" });
  assert.deepEqual(panel.props.style, { left: 540, top: 384, width: 460, height: 360 });

  const header = renderer.root.findByProps({ className: "neo-live-logs__header" });
  await act(async () => header.props.onMouseDown({
    clientX: 600,
    clientY: 400,
    target: { closest: () => ({}) },
  }));
  assert.equal(listeners.get("mousemove")?.size || 0, 0);

  await act(async () => header.props.onMouseDown({
    clientX: 600,
    clientY: 400,
    target: { closest: () => null },
  }));
  assert.equal(listeners.get("mousemove")?.size, 1);
  assert.equal(listeners.get("mouseup")?.size, 1);

  await dispatchWindow("mousemove", { clientX: -1000, clientY: -1000 });
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.left, 24);
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.top, 24);
  await dispatchWindow("mousemove", { clientX: 3000, clientY: 3000 });
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.left, 540);
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.top, 384);
  await dispatchWindow("mouseup");

  panelRect.left = 24;
  panelRect.top = 24;
  panelRect.width = 320;
  panelRect.height = 220;

  for (const className of [
    "neo-live-logs__resize neo-live-logs__resize--e",
    "neo-live-logs__resize neo-live-logs__resize--s",
    "neo-live-logs__resize neo-live-logs__resize--se",
  ]) {
    const handle = renderer.root.findByProps({ className });
    await act(async () => handle.props.onMouseDown({
      clientX: 1000,
      clientY: 744,
      preventDefault() {},
      stopPropagation() {},
    }));
  }
  assert.equal(listeners.get("mousemove")?.size, 1);
  assert.equal(listeners.get("mouseup")?.size, 1);

  await dispatchWindow("mousemove", { clientX: 0, clientY: 0 });
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.width, 320);
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.height, 220);
  await dispatchWindow("mousemove", { clientX: 3000, clientY: 3000 });
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.width, 976);
  assert.equal(renderer.root.findByProps({ className: "neo-live-logs" }).props.style.height, 720);

  await act(async () => renderer.unmount());
  assert.equal(listeners.get("mousemove")?.size || 0, 0);
  assert.equal(listeners.get("mouseup")?.size || 0, 0);
});

test("320px 최소 폭은 상태와 줄 수를 보이고 compact control을 Close와 분리한다", async () => {
  listeners.clear();
  window.innerWidth = 368;
  window.innerHeight = 268;
  const timers = fakeTimers();
  const waitingList = deferred();
  const { renderer } = await renderLive({
    list: async () => waitingList.promise,
    tail: async () => ({ file: "", lines: [], totalLines: 0 }),
  }, timers);
  const panel = renderer.root.findByProps({ className: "neo-live-logs" });
  assert.equal(panel.props.style.width, 320);
  assert.equal(statusText(renderer.root), "DISCONNECTED");
  assert.equal(nodeText(renderer.root.findByProps({ className: "neo-live-logs__meta neo-live-logs__count" })), "0/100");

  const header = renderer.root.findByProps({ className: "neo-live-logs__header" });
  const actions = renderer.root.findByProps({ className: "neo-live-logs__actions" });
  const closeButton = renderer.root.findByProps({ className: "neo-icon-button neo-live-logs__close" });
  assert.equal(actions.parent, header);
  assert.equal(closeButton.parent, header);
  assert.ok(renderer.root.findByProps({ "aria-label": "Pause live logs" }));
  assert.ok(renderer.root.findByProps({ "aria-label": "Clear live logs" }));

  assert.match(styles, /\.neo-live-logs__header\s*\{[^}]*position:\s*relative;[^}]*padding-right:\s*calc\(16px \+ 28px \+ 8px\)/);
  assert.match(styles, /\.neo-live-logs__close\s*\{[^}]*position:\s*absolute;[^}]*top:\s*12px;[^}]*right:\s*16px;/);
  const compactRule = cssBlock("@container (max-width: 320px)");
  assert.doesNotMatch(compactRule, /\.neo-live-logs__status[^{}]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(compactRule, /\.neo-live-logs__count[^{}]*\{[^}]*display:\s*none/);
  assert.match(compactRule, /\.neo-live-logs__header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(compactRule, /\.neo-live-logs__title > \.material-symbols-outlined,[\s\S]*\.neo-live-logs__name,[\s\S]*\.neo-live-logs__dot\s*\{[^}]*display:\s*none/);
  assert.match(compactRule, /\.neo-live-logs__actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2, 28px\)/);
  assert.match(compactRule, /\.neo-live-logs__action-label\s*\{[^}]*display:\s*none/);

  await act(async () => renderer.unmount());
  window.innerWidth = 1024;
  window.innerHeight = 768;
});

test("좁은 viewport에서도 안전 크기로 clamp한 Close를 실제로 누를 수 있다", async () => {
  listeners.clear();
  window.innerWidth = 1024;
  window.innerHeight = 768;
  const timers = fakeTimers();
  const waitingList = deferred();
  let closed = 0;
  const { renderer } = await renderLive({
    list: async () => waitingList.promise,
    tail: async () => ({ file: "", lines: [], totalLines: 0 }),
  }, timers, { onClose: () => { closed += 1; } });
  assert.equal(listeners.get("resize")?.size, 1);

  window.innerWidth = 280;
  window.innerHeight = 180;
  await dispatchWindow("resize");
  const style = renderer.root.findByProps({ className: "neo-live-logs" }).props.style;
  assert.deepEqual(style, { left: 24, top: 24, width: 232, height: 132 });
  assert.ok(style.left + style.width <= window.innerWidth);
  assert.ok(style.top + style.height <= window.innerHeight);
  let closeButton = renderer.root.findByProps({ className: "neo-icon-button neo-live-logs__close" });
  assert.equal(closeButton.props["aria-label"], "Close live logs");

  window.innerWidth = 72;
  window.innerHeight = 60;
  await dispatchWindow("resize");
  const tinyStyle = renderer.root.findByProps({ className: "neo-live-logs" }).props.style;
  assert.deepEqual(tinyStyle, { left: 6, top: 4, width: 60, height: 52 });
  assert.ok(tinyStyle.left + tinyStyle.width <= window.innerWidth);
  assert.ok(tinyStyle.top + tinyStyle.height <= window.innerHeight);

  window.innerWidth = 48;
  window.innerHeight = 40;
  await dispatchWindow("resize");
  const smallerThanSafeStyle = renderer.root.findByProps({ className: "neo-live-logs" }).props.style;
  assert.deepEqual(smallerThanSafeStyle, { left: 0, top: 0, width: 48, height: 40 });
  closeButton = renderer.root.findByProps({ className: "neo-icon-button neo-live-logs__close" });
  await act(async () => closeButton.props.onClick());
  assert.equal(closed, 1);

  await act(async () => renderer.unmount());
  assert.equal(listeners.get("resize")?.size || 0, 0);
  window.innerWidth = 1024;
  window.innerHeight = 768;
});
