import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import React from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";

const expectSide = true;
const isSingle = "jobs" === "single";
const expectedPackageName = "neo-pkg-dbus";
const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root: frontendRoot, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });

function jsonResponse(data, status = 200, ok = true) {
  return { ok, status, async json() { return data; } };
}

function textOf(node) {
  if (typeof node === "string") return node;
  if (!node) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children || []);
}

function hasClass(node, className) {
  return typeof node?.props?.className === "string"
    && node.props.className.split(/\s+/).includes(className);
}

function copyJobs(jobs) {
  return jobs.map((job) => ({
    ...job,
    config: { ...job.config },
    result: job.result ? { ...job.result } : null,
  }));
}

const original = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  BroadcastChannel: globalThis.BroadcastChannel,
  actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
};
const intervals = [];
const clearedIntervals = [];
const channels = [];

class FakeChannel {
  constructor(name) {
    this.name = name;
    this.sent = [];
    this.listeners = new Set();
    channels.push(this);
  }
  postMessage(message) {
    this.sent.push(message);
    for (const channel of channels) {
      if (channel === this || channel.name !== this.name) continue;
      if (channel.onmessage) channel.onmessage({ data: message });
      for (const listener of channel.listeners) listener({ data: message });
    }
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }
  close() { this.closed = true; }
}

try {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = {
    setInterval(callback, milliseconds) { intervals.push({ callback, milliseconds }); return intervals.length; },
    clearInterval(id) { clearedIntervals.push(id); },
  };
  globalThis.BroadcastChannel = FakeChannel;

  const {
    StatusBadge,
    StatusMessages,
    Metric,
    ResultJson,
  } = await server.ssrLoadModule("/src/components/CommonView.jsx");

  let controllerMessages;
  await act(async () => {
    controllerMessages = create(React.createElement(StatusMessages, {
      view: { phase: "controller-error", error: { kind: "controller", status: 503, message: "controller unavailable" } },
      actionError: null,
    }));
  });
  assert.match(
    textOf(controllerMessages.toJSON()),
    /Controller error \(HTTP 503\): controller unavailable/,
    "Controller 오류는 공통 상태 메시지에서 Controller 오류로 보여야 합니다.",
  );

  let transportMessages;
  await act(async () => {
    transportMessages = create(React.createElement(StatusMessages, {
      view: { phase: "network-error", error: { kind: "network", status: null, message: "offline" } },
      actionError: { kind: "cgi", status: 500, message: "bad gateway" },
    }));
  });
  const transportText = textOf(transportMessages.toJSON());
  assert.match(transportText, /Network error: offline/, "network 오류는 별도 문구여야 합니다.");
  assert.match(transportText, /CGI error \(HTTP 500\): bad gateway/, "CGI 오류는 별도 문구여야 합니다.");

  for (const [status, label] of [
    ["running", "RUNNING"],
    ["starting", "STARTING"],
    ["stopping", "STOPPING"],
    ["stopped", "STOPPED"],
    ["failed", "FAILED"],
    ["error", "ERROR"],
    ["not_installed", "NOT INSTALLED"],
  ]) {
    let badge;
    await act(async () => {
      badge = create(React.createElement(StatusBadge, { status, running: status === "running" }));
    });
    const node = badge.toJSON();
    assert.equal(textOf(node), label, `${status} 상태는 읽을 수 있는 이름으로 표시해야 합니다.`);
    assert.match(node.props.className, new RegExp(`neo-status-badge--${status}`), `${status} 상태는 구분 가능한 class를 가져야 합니다.`);
  }

  for (const status of ["PAUSED", "UNKNOWN", ""]) {
    let unknownBadge;
    await act(async () => {
      unknownBadge = create(React.createElement(StatusBadge, { status, running: false }));
    });
    const node = unknownBadge.toJSON();
    assert.equal(textOf(node), "UNKNOWN", `${status || "빈"} 상태를 STOPPED로 표시하면 안 됩니다.`);
    assert.match(
      node.props.className,
      /neo-status-badge--unknown/,
      `${status || "빈"} 상태는 UNKNOWN 전용 class를 가져야 합니다.`,
    );
  }

  let metrics;
  await act(async () => {
    metrics = create(React.createElement(React.Fragment, null,
      React.createElement(Metric, { label: "0", value: 0 }),
      React.createElement(Metric, { label: "null", value: null }),
      React.createElement(Metric, { label: "undefined", value: undefined }),
    ));
  });
  assert.match(textOf(metrics.toJSON()), /0.*0.*null.*—.*undefined.*—/, "Metric은 0을 보존하고 null/undefined만 대시로 표시해야 합니다.");

  let resultJson;
  await act(async () => {
    resultJson = create(React.createElement(ResultJson, { result: { count: 0, ok: true } }));
  });
  const resultPre = resultJson.root.findByType("pre");
  assert.match(resultPre.props.className, /neo-result-json/, "결과 JSON은 전용 pre class를 사용해야 합니다.");
  assert.match(resultPre.props.className, /neo-mono/, "결과 JSON은 D2Coding용 monospace class를 사용해야 합니다.");
  assert.equal(textOf(resultPre), '{\n  "count": 0,\n  "ok": true\n}', "결과 객체는 읽기 좋은 JSON으로 표시해야 합니다.");

  if (!isSingle) {
    const {
      JobsMain,
      JobsSide,
      resolveSelectedJob,
    } = await server.ssrLoadModule("/src/components/JobsView.jsx");
    const { healthFromJobs } = await server.ssrLoadModule("/src/StarterView.jsx");
    const jobs = [{ name: "alpha" }, { name: "example" }, { name: "omega" }];
    assert.equal(resolveSelectedJob(jobs, null, null), "example", "첫 로드는 example을 먼저 선택해야 합니다.");
    assert.equal(resolveSelectedJob([{ name: "alpha" }, { name: "omega" }], null, null), "alpha", "example이 없으면 첫 Job을 선택해야 합니다.");
    assert.equal(resolveSelectedJob(jobs, "omega", null), "omega", "현재 선택이 남아 있으면 유지해야 합니다.");
    assert.equal(resolveSelectedJob(jobs, "example", "example"), "omega", "선택 Job 삭제 뒤 원래 순서의 다음 Job을 선택해야 합니다.");
    assert.equal(resolveSelectedJob(jobs, "omega", "omega"), "example", "마지막 Job 삭제 뒤 이전 Job을 선택해야 합니다.");
    assert.equal(resolveSelectedJob([{ name: "example" }], "example", "example"), null, "마지막 Job 삭제 뒤에는 선택이 없어야 합니다.");
    assert.equal(resolveSelectedJob([], null, null), null, "Job이 없으면 null을 반환해야 합니다.");
    const degraded = healthFromJobs([
      { name: "controller-broken", running: false, error: "worker failed", errorKind: "controller" },
      { name: "result-broken", running: true, error: "", errorKind: "", resultError: "invalid JSON" },
    ]);
    assert.equal(degraded.healthy, false, "Controller 오류나 결과 오류가 있으면 jobs 요약은 정상으로 표시하면 안 됩니다.");
    assert.deepEqual(
      degraded.service_summary.errors,
      ["controller-broken: Controller error: worker failed", "result-broken: Result error: invalid JSON"],
      "jobs 요약은 Controller 오류와 결과 오류를 모두 보존해야 합니다.",
    );
    const brokenConfigHealth = healthFromJobs([{
      name: "config-broken",
      running: true,
      status: "RUNNING",
      error: "Unexpected token in JSON",
      errorKind: "config",
      configError: "Unexpected token in JSON",
      controllerError: "",
      resultError: "",
    }]);
    assert.equal(
      brokenConfigHealth.service_summary.running,
      1,
      "설정 오류가 있어도 실제 RUNNING 상태는 요약에 반영해야 합니다.",
    );

    const uiStatusCases = [
      { status: "RUNNING", statusKnown: true, registered: true, running: true, edit: false, remove: false, toggleDisabled: false, toggleLabel: "Stop", togglePressed: true },
      { status: "STARTING", statusKnown: true, registered: true, running: true, edit: false, remove: false, toggleDisabled: true, toggleLabel: "Stop", togglePressed: true },
      { status: "STOPPING", statusKnown: true, registered: true, running: false, edit: false, remove: false, toggleDisabled: true, toggleLabel: "Stop", togglePressed: true },
      { status: "STOPPED", statusKnown: true, registered: true, running: false, edit: true, remove: true, toggleDisabled: false, toggleLabel: "Start", togglePressed: false },
      { status: "FAILED", statusKnown: true, registered: true, running: false, edit: false, remove: true, toggleDisabled: false, toggleLabel: "Start", togglePressed: false },
      { status: "NOT_INSTALLED", statusKnown: true, registered: false, running: false, edit: true, remove: true, toggleDisabled: false, toggleLabel: "Start", togglePressed: false },
      { status: "ERROR", statusKnown: false, registered: null, running: false, edit: false, remove: false, toggleDisabled: true, toggleLabel: "Start", togglePressed: false },
      { status: "UNKNOWN", statusKnown: false, registered: null, running: false, edit: false, remove: false, toggleDisabled: true, toggleLabel: "Start", togglePressed: false },
      { status: "PAUSED", statusKnown: false, registered: null, running: false, edit: false, remove: false, toggleDisabled: true, toggleLabel: "Start", togglePressed: false },
    ];
    for (const expected of uiStatusCases) {
      const name = `state-${expected.status.toLowerCase()}`;
      const job = {
        name,
        config: { intervalMs: 1000 },
        result: null,
        service: `neo-pkg-self-test-${name}`,
        error: "",
        errorKind: "",
        configError: "",
        controllerError: "",
        resultError: "",
        ...expected,
      };
      const state = {
        view: { phase: "ready-data", snapshot: { jobs: [job] } },
        isPending: () => false,
        runAction: async () => true,
        refresh: async () => {},
        packageChannel: null,
      };
      let statusRenderer;
      await act(async () => {
        statusRenderer = create(React.createElement(React.Fragment, null,
          React.createElement(JobsMain, { state, hasSide: expectSide }),
          expectSide ? React.createElement(JobsSide, { state }) : null,
        ));
      });
      assert.equal(
        statusRenderer.root.findByProps({ "aria-label": `${name} Edit` }).props.disabled,
        !expected.edit,
        `${expected.status} 상태의 Edit 허용표가 backend update 계약과 같아야 합니다.`,
      );
      assert.equal(
        statusRenderer.root.findByProps({ "aria-label": `${name} Delete` }).props.disabled,
        !expected.remove,
        `${expected.status} 상태의 Delete는 알려진 비실행 상태에서만 허용해야 합니다.`,
      );
      if (expectSide) {
        assert.equal(
          statusRenderer.root.findByProps({ "aria-label": `${name} ${expected.toggleLabel}` }).props.disabled,
          expected.toggleDisabled,
          `${expected.status} 상태의 Side toggle 허용표가 고정되어야 합니다.`,
        );
        assert.equal(
          statusRenderer.root.findByProps({ "aria-label": `${name} ${expected.toggleLabel}` }).props["aria-pressed"],
          expected.togglePressed,
          `${expected.status} 상태의 Side toggle 시각 상태와 접근성 상태가 같아야 합니다.`,
        );
      } else {
        assert.equal(
          statusRenderer.root.findByProps({ "aria-label": `${name} Start` }).props.disabled,
          expected.toggleDisabled || expected.toggleLabel !== "Start",
          `${expected.status} 상태의 Main Start 허용표가 고정되어야 합니다.`,
        );
        assert.equal(
          statusRenderer.root.findByProps({ "aria-label": `${name} Stop` }).props.disabled,
          expected.toggleDisabled || expected.toggleLabel !== "Stop",
          `${expected.status} 상태의 Main Stop 허용표가 고정되어야 합니다.`,
        );
      }
      if (expected.status === "UNKNOWN" || expected.status === "PAUSED") {
        assert.equal(
          textOf(statusRenderer.root.find((node) => hasClass(node, "neo-status-badge"))),
          "UNKNOWN",
          `${expected.status} 상태의 badge는 STOPPED와 구분해야 합니다.`,
        );
      }
      await act(async () => { statusRenderer.unmount(); });
    }

    const detailedErrorJob = {
      name: "all-errors",
      config: { intervalMs: 1000 },
      result: null,
      service: "neo-pkg-self-test-all-errors",
      status: "STOPPED",
      statusKnown: true,
      registered: true,
      running: false,
      error: "shared detail",
      errorKind: "controller",
      configError: "shared detail",
      controllerError: "shared detail",
      resultError: "shared detail",
    };
    const detailedErrorState = {
      view: { phase: "ready-data", snapshot: { jobs: [detailedErrorJob] } },
      isPending: () => false,
      runAction: async () => true,
      refresh: async () => {},
      packageChannel: null,
    };
    let detailedErrors;
    await act(async () => {
      detailedErrors = create(React.createElement(JobsMain, { state: detailedErrorState, hasSide: expectSide }));
    });
    const detailedErrorText = textOf(detailedErrors.toJSON());
    for (const message of ["Config error: shared detail", "Controller error: shared detail", "Result error: shared detail"]) {
      assert.equal(
        detailedErrorText.split(message).length - 1,
        1,
        `세부 오류 ${message}는 Job 상세에서 한 번만 보여야 합니다.`,
      );
    }
    assert.equal(
      detailedErrorText.split("shared detail").length - 1,
      3,
      "같은 문구의 세부 오류는 출처별로 표시하고 대표 error만 중복 제거해야 합니다.",
    );
    assert.equal(
      detailedErrors.root.findByProps({ "aria-label": "all-errors Edit" }).props.disabled,
      true,
      "configError가 있으면 Edit를 막아야 합니다.",
    );
    assert.equal(
      detailedErrors.root.findByProps({ "aria-label": "all-errors Delete" }).props.disabled,
      false,
      "configError가 있어도 알려진 STOPPED Job은 Delete할 수 있어야 합니다.",
    );
    if (!expectSide) {
      assert.equal(
        detailedErrors.root.findByProps({ "aria-label": "all-errors Start" }).props.disabled,
        true,
        "configError가 있으면 Start를 막아야 합니다.",
      );
    }
    await act(async () => { detailedErrors.unmount(); });

    const runningConfigErrorJob = { ...detailedErrorJob, name: "running-config-error", status: "RUNNING", running: true };
    const runningConfigErrorState = {
      ...detailedErrorState,
      view: { phase: "ready-data", snapshot: { jobs: [runningConfigErrorJob] } },
    };
    let runningConfigError;
    await act(async () => {
      runningConfigError = create(React.createElement(React.Fragment, null,
        React.createElement(JobsMain, { state: runningConfigErrorState, hasSide: expectSide }),
        expectSide ? React.createElement(JobsSide, { state: runningConfigErrorState }) : null,
      ));
    });
    if (expectSide) {
      const switchNode = runningConfigError.root.findByProps({ "aria-label": "running-config-error Stop" });
      assert.equal(switchNode.props.disabled, false, "configError가 있어도 실행 중 Side Job은 Stop할 수 있어야 합니다.");
      assert.equal(switchNode.props["aria-pressed"], true, "실행 중인 configError Job의 Side 스위치는 켜진 모양이어야 합니다.");
    } else {
      assert.equal(
        runningConfigError.root.findByProps({ "aria-label": "running-config-error Stop" }).props.disabled,
        false,
        "configError가 있어도 실행 중 Main Job은 Stop할 수 있어야 합니다.",
      );
    }
    await act(async () => { runningConfigError.unmount(); });
  }

  const { StarterView } = await server.ssrLoadModule("/src/StarterView.jsx");
  const requests = [];
  let renderer;

  if (isSingle) {
    const { SingleMain, SingleSide } = await server.ssrLoadModule("/src/components/SingleView.jsx");
    const singleState = (status, error = "") => ({
      view: { snapshot: { health: { status, error, result: null } } },
      isPending: () => false,
      runAction: () => {},
    });
    for (const [status, label] of [["starting", "STARTING"], ["stopping", "STOPPING"]]) {
      let transition;
      await act(async () => {
        transition = create(React.createElement(SingleMain, { state: singleState(status) }));
      });
      const transitionText = textOf(transition.toJSON());
      assert.match(transitionText, new RegExp(label), `${status} 상태를 별도 badge로 보여야 합니다.`);
      assert.equal(transition.root.findByType("button").props.disabled, true, `${status} 중에는 반대 동작 버튼을 누를 수 없어야 합니다.`);
    }
    for (const [status, label, disabled] of [
      ["stopped", "Start service", false],
      ["failed", "Start service", false],
      ["not_installed", "Start service", false],
      ["running", "Stop service", false],
      ["starting", "Start service", true],
      ["stopping", "Start service", true],
      ["unknown", "Start service", true],
      ["error", "Start service", true],
    ]) {
      let view;
      await act(async () => {
        view = create(React.createElement(SingleMain, { state: singleState(status) }));
      });
      assert.equal(
        view.root.findByProps({ "aria-label": label }).props.disabled,
        disabled,
        `${status} 상태의 single 버튼 허용 여부가 계약과 같아야 합니다.`,
      );
      await act(async () => { view.unmount(); });
    }

    const noHealthState = {
      view: { snapshot: { health: null } },
      isPending: () => false,
      runAction: () => {},
    };
    let loadingView;
    await act(async () => {
      loadingView = create(React.createElement(SingleMain, { state: noHealthState }));
    });
    assert.equal(
      loadingView.root.findByProps({ "aria-label": "Start service" }).props.disabled,
      true,
      "첫 health 응답 전에는 Start를 누를 수 없어야 합니다.",
    );
    await act(async () => { loadingView.unmount(); });
    let failedService;
    await act(async () => {
      failedService = create(React.createElement(SingleMain, { state: singleState("failed") }));
    });
    assert.match(textOf(failedService.toJSON()), /The service failed to run/, "failed 상태는 오류 설명을 보여야 합니다.");

    const sideState = (health) => ({
      view: { snapshot: { health } },
      isPending: () => false,
      runAction: () => {},
    });
    let controllerErrorSide;
    await act(async () => {
      controllerErrorSide = create(React.createElement(SingleSide, {
        state: sideState({
          healthy: false,
          status: "failed",
          error: "worker exploded",
          resultError: "",
          result: null,
        }),
      }));
    });
    assert.match(textOf(controllerErrorSide.toJSON()), /worker exploded/, "single Side는 Controller 오류를 보여야 합니다.");

    let resultErrorSide;
    await act(async () => {
      resultErrorSide = create(React.createElement(SingleSide, {
        state: sideState({
          healthy: false,
          status: "running",
          error: "",
          resultError: "invalid result JSON",
          result: null,
        }),
      }));
    });
    assert.match(textOf(resultErrorSide.toJSON()), /Result error: invalid result JSON/, "single Side는 결과 읽기 오류를 보여야 합니다.");

    let prioritizedErrorSide;
    await act(async () => {
      prioritizedErrorSide = create(React.createElement(SingleSide, {
        state: sideState({
          healthy: false,
          status: "failed",
          error: "controller wins",
          resultError: "result loses",
          result: null,
        }),
      }));
    });
    const sideErrors = prioritizedErrorSide.root.findAllByProps({
      className: "neo-single-side__error",
    });
    assert.equal(sideErrors.length, 1, "single Side는 오류 요소를 하나만 보여야 합니다.");
    assert.match(textOf(sideErrors[0]), /controller wins/, "두 오류가 함께 있으면 Controller 오류를 먼저 보여야 합니다.");
    assert.doesNotMatch(textOf(sideErrors[0]), /result loses/, "Controller 오류가 있으면 결과 오류를 함께 표시하면 안 됩니다.");
    assert.equal(prioritizedErrorSide.root.findAllByType("button").length, 0, "오류가 있어도 single Side에 버튼을 추가하면 안 됩니다.");

    let serviceStatus = "stopped";
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/health")) {
        return jsonResponse({
          ok: true,
          data: {
            healthy: false,
            status: serviceStatus,
            pid: 0,
            exit_code: 0,
            error: "",
            resultError: "generated result is unreadable",
            result: { count: 0, updatedAt: "2026-07-28T01:02:03.000Z" },
          },
        });
      }
      if (String(url).endsWith("/service/start")) {
        serviceStatus = "running";
        return jsonResponse({ ok: true, data: { status: "running" } });
      }
      if (String(url).endsWith("/service/stop")) {
        serviceStatus = "stopped";
        return jsonResponse({ ok: true, data: { status: "stopped" } });
      }
      throw new Error(`예상하지 못한 요청: ${url}`);
    };
    await act(async () => {
      renderer = create(React.createElement(React.Fragment, null,
        React.createElement(StarterView, { surface: "main" }),
        expectSide ? React.createElement(StarterView, { surface: "side" }) : null,
      ));
    });
    assert.equal(intervals.length, expectSide ? 2 : 1, "실제 StarterView mount는 각 화면에 2초 polling을 설치해야 합니다.");
    assert.equal(channels.length, expectSide ? 2 : 0, "side=no에서는 실제 StarterView가 BroadcastChannel을 만들면 안 됩니다.");
    const singleText = textOf(renderer.toJSON());
    assert.match(singleText, /count0/, "single Main은 count 0을 숨기지 않아야 합니다.");
    assert.match(singleText, /PID0/, "single Main은 PID 0을 숨기지 않아야 합니다.");
    assert.match(singleText, /exit code0/, "single Main은 exit code 0을 숨기지 않아야 합니다.");
    assert.match(singleText, /packageService\.managedtrue/, "single Main은 관리 모델을 명시해야 합니다.");
    assert.match(singleText, /cgi-bin\/data\/service\.counter\.json/, "single Main은 결과 파일 경로를 보여야 합니다.");
    assert.match(singleText, /"count": 0/, "single Main은 최신 결과 JSON을 보여야 합니다.");
    const mainSingle = renderer.root.findByProps({ "aria-label": "Service details" });
    assert.match(textOf(mainSingle), /Start/, "중지된 single Main은 시작 버튼만 보여야 합니다.");
    assert.doesNotMatch(textOf(mainSingle), /Stop/, "중지된 single Main은 중지 버튼을 보이면 안 됩니다.");
    if (expectSide) {
      const sideSingle = renderer.root.findByProps({ "aria-label": "Service summary" });
      const sideText = textOf(sideSingle);
      assert.match(sideText, /Service/, "single Side는 서비스 이름을 보여야 합니다.");
      assert.match(sideText, /Status.*STOPPED/, "single Side는 상태 badge를 보여야 합니다.");
      assert.match(sideText, /Count0/, "single Side는 count만 요약해야 합니다.");
      assert.match(sideText, /Updated2026-07-28T01:02:03.000Z/, "single Side는 마지막 갱신 시각을 보여야 합니다.");
      assert.match(sideText, /Result error: generated result is unreadable/, "HTTP 200 degraded health는 StarterView를 거쳐 single Side에 보여야 합니다.");
      assert.equal(sideSingle.findAllByType("button").length, 0, "single Side에는 시작/중지 제어 버튼이 없어야 합니다.");
    }
    const healthBefore = requests.filter((request) => request.url.endsWith("/health")).length;
    const start = renderer.root.findByProps({ "aria-label": "Start service" });
    await act(async () => { await start.props.onClick(); });
    const healthAfter = requests.filter((request) => request.url.endsWith("/health")).length;
    const startRequest = requests.find((request) => request.url.endsWith("/service/start"));
    assert.equal(startRequest && startRequest.options.method, "POST", "중지된 single Main의 시작 버튼은 start POST를 호출해야 합니다.");
    if (expectSide) {
      assert.deepEqual(channels[0].sent.at(-1), { type: "refresh" }, "Main 성공 조작은 실제 BroadcastChannel에 refresh를 보내야 합니다.");
      assert.equal(healthAfter >= healthBefore + 2, true, "Main refresh와 Side 수신 refresh는 즉시 새 health 요청을 시작해야 합니다.");
    }
    assert.equal(healthAfter >= healthBefore + 1, true, "single Main 성공 조작은 즉시 새 health 요청을 시작해야 합니다.");
    assert.match(textOf(mainSingle), /Stop/, "실행 중인 single Main은 중지 버튼만 보여야 합니다.");
    assert.doesNotMatch(textOf(mainSingle), /Start/, "실행 중인 single Main은 시작 버튼을 보이면 안 됩니다.");
    const stopHealthBefore = requests.filter((request) => request.url.endsWith("/health")).length;
    const stop = renderer.root.findByProps({ "aria-label": "Stop service" });
    await act(async () => { await stop.props.onClick(); });
    const stopHealthAfter = requests.filter((request) => request.url.endsWith("/health")).length;
    const stopRequest = requests.find((request) => request.url.endsWith("/service/stop"));
    assert.equal(stopRequest && stopRequest.options.method, "POST", "실행 중인 single Main의 중지 버튼은 stop POST를 호출해야 합니다.");
    if (expectSide) {
      assert.deepEqual(channels[0].sent.at(-1), { type: "refresh" }, "Main stop 성공은 실제 BroadcastChannel에 refresh를 보내야 합니다.");
      assert.equal(stopHealthAfter >= stopHealthBefore + 2, true, "Main stop refresh와 Side 수신 refresh는 즉시 새 health 요청을 시작해야 합니다.");
    }
    assert.equal(stopHealthAfter >= stopHealthBefore + 1, true, "single Main stop 성공은 즉시 새 health 요청을 시작해야 합니다.");
    assert.match(textOf(mainSingle), /Start/, "중지 성공 뒤 single Main은 시작 버튼으로 돌아와야 합니다.");
    assert.doesNotMatch(textOf(mainSingle), /Stop/, "중지 성공 뒤 single Main은 중지 버튼을 보이면 안 됩니다.");
  } else {
    let jobs = expectSide
      ? [
          {
            name: "example",
            config: {},
            status: "RUNNING",
            statusKnown: true,
            registered: true,
            running: true,
            service: "neo-pkg-self-test-example",
            error: "Unexpected token in JSON",
            errorKind: "config",
            configError: "Unexpected token in JSON",
            controllerError: "",
            resultError: "",
            result: { count: 7, updatedAt: "2026-07-28T01:02:03.000Z" },
          },
          {
            name: "second",
            config: { intervalMs: 2000 },
            status: "STOPPED",
            statusKnown: true,
            registered: true,
            running: false,
            service: "neo-pkg-self-test-second",
            error: "",
            errorKind: "",
            configError: "",
            controllerError: "",
            resultError: "",
            result: { count: 2, updatedAt: "2026-07-28T02:03:04.000Z" },
          },
        ]
      : [{
          name: "alpha",
          config: { intervalMs: 1500 },
          status: "RUNNING",
          statusKnown: true,
          registered: true,
          running: true,
          service: "neo-pkg-self-test-alpha",
          error: "",
          errorKind: "",
          resultError: "",
          result: { count: 7, updatedAt: "2026-07-28T01:02:03.000Z" },
        }];
    let releaseCreate = null;
    let deferCreate = false;
    let failRefreshAfterCreate = false;
    let failedListRequests = 0;
    let createShouldFail = false;
    let listShouldHaveControllerError = false;
    let initialListPending = !expectSide;
    let releaseInitialList = null;
    const createBodies = [];
    const updateBodies = [];

    globalThis.fetch = async (url, options = {}) => {
      const path = String(url);
      requests.push({ url: path, options });
      if (path.endsWith("/jobs/list")) {
        if (initialListPending) {
          initialListPending = false;
          return new Promise((resolve) => {
            releaseInitialList = () => resolve(jsonResponse({ ok: true, data: copyJobs(jobs) }));
          });
        }
        if (listShouldHaveControllerError) {
          return jsonResponse({ ok: false, kind: "controller", error: "polling controller failure" }, 503, false);
        }
        if (failedListRequests > 0) {
          failedListRequests -= 1;
          return jsonResponse({ ok: false, error: "목록 조회 실패" }, 500, false);
        }
        return jsonResponse({ ok: true, data: copyJobs(jobs) });
      }
      if (path.includes("/jobs/start?")) {
        const name = new URL(path, "http://local").searchParams.get("name");
        jobs = jobs.map((job) => job.name === name ? { ...job, running: true, status: "RUNNING" } : job);
        return jsonResponse({ ok: true, data: { name, status: "RUNNING" } });
      }
      if (path.includes("/jobs/stop?")) {
        const name = new URL(path, "http://local").searchParams.get("name");
        jobs = jobs.map((job) => job.name === name ? { ...job, running: false, status: "STOPPED" } : job);
        return jsonResponse({ ok: true, data: { name } });
      }
      if (path.includes("/jobs/delete?")) {
        const name = new URL(path, "http://local").searchParams.get("name");
        jobs = jobs.filter((job) => job.name !== name);
        return jsonResponse({
          ok: true,
          data: name === "third" ? { name, cleanupError: "result removal failed" } : { name },
        });
      }
      if (path.endsWith("/jobs/create")) {
        const body = JSON.parse(options.body);
        createBodies.push(body);
        if (createShouldFail) return jsonResponse({ ok: false, error: "작업 생성 실패" }, 400, false);
        const finish = () => {
          jobs = [...jobs, {
            name: body.name,
            config: body.config,
            status: "STOPPED",
            statusKnown: true,
            registered: true,
            running: false,
            service: `neo-pkg-self-test-${body.name}`,
            error: "",
            errorKind: "",
            resultError: "",
            result: null,
          }];
          if (failRefreshAfterCreate) {
            failedListRequests = expectSide ? 2 : 1;
            failRefreshAfterCreate = false;
          }
          return jsonResponse({ ok: true, data: { name: body.name } });
        };
        if (deferCreate) {
          return new Promise((resolve) => {
            releaseCreate = () => resolve(finish());
          });
        }
        return finish();
      }
      if (path.endsWith("/jobs/update")) {
        const body = JSON.parse(options.body);
        updateBodies.push(body);
        jobs = jobs.map((job) => job.name === body.name
          ? { ...job, config: { ...body.config } }
          : job);
        return jsonResponse({ ok: true, data: { name: body.name, config: body.config } });
      }
      throw new Error(`예상하지 못한 요청: ${path}`);
    };

    await act(async () => {
      renderer = create(React.createElement(React.Fragment, null,
        React.createElement(StarterView, { surface: "main" }),
        expectSide ? React.createElement(StarterView, { surface: "side" }) : null,
      ));
    });

    if (!expectSide) {
      const loadingText = textOf(renderer.toJSON());
      assert.match(loadingText, /Loading status/, "지연된 첫 조회 중에는 loading 상태를 보여야 합니다.");
      assert.doesNotMatch(loadingText, /Restore example/, "지연된 첫 조회 중에는 example 복구 버튼을 보여주면 안 됩니다.");
      await act(async () => {
        releaseInitialList();
      });
    }

    assert.equal(intervals.length, expectSide ? 2 : 1, "실제 StarterView mount는 각 화면에 2초 polling을 설치해야 합니다.");
    assert.equal(channels.length, expectSide ? 2 : 0, "side=no에서는 BroadcastChannel을 만들면 안 됩니다.");
    assert.equal(
      requests.filter((request) => request.url.endsWith("/jobs/list")).length,
      expectSide ? 2 : 1,
      "jobs Main과 Side는 각각 jobs/list에서 실제 Job 목록을 읽어야 합니다.",
    );
    assert.equal(
      requests.filter((request) => request.url.endsWith("/health")).length,
      0,
      "jobs 화면은 별도 health 요약을 요청하면 안 됩니다.",
    );

    if (expectSide) {
      const sideHeader = renderer.root.find((node) => hasClass(node, "neo-jobs-side__header"));
      const sectionHeader = renderer.root.find((node) => hasClass(node, "neo-job-list__header"));
      assert.equal(textOf(sideHeader.findByType("h2")), expectedPackageName, "Side 상단에는 생성된 패키지 이름을 보여야 합니다.");
      assert.equal(textOf(sectionHeader.findByType("h3")), "Jobs", "패키지 헤더 아래에 별도 Jobs 섹션 제목이 있어야 합니다.");
      const rows = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      assert.deepEqual(rows.map((row) => textOf(row.find((node) => hasClass(node, "neo-job-name")))), ["example", "second"], "Side는 jobs/list의 모든 Job을 순서대로 보여야 합니다.");
      assert.equal(rows.every((row) => row.type === "div" && row.props.role === undefined), true, "Side 행 컨테이너 자체를 버튼으로 만들면 안 됩니다.");
      const selectors = rows.map((row) => row.find((node) => hasClass(node, "neo-job-select")));
      assert.equal(selectors.every((selector) => selector.type === "button"), true, "Job 선택은 스위치와 분리된 실제 버튼이어야 합니다.");
      assert.equal(
        rows.every((row) => {
          const selectButton = row.find((node) => hasClass(node, "neo-job-select"));
          const switchButton = row.find((node) => hasClass(node, "neo-switch"));
          return row.children.length === 2
            && row.children[0] === selectButton
            && row.children[1] === switchButton
            && selectButton.parent === row
            && switchButton.parent === row
            && selectButton !== switchButton;
        }),
        true,
        "선택 버튼과 스위치는 행의 서로 다른 직접 자식이어야 합니다.",
      );
      assert.equal(rows[0].props["data-selected"], true, "첫 준비 완료에서 Side도 example을 선택해야 합니다.");
      assert.equal(selectors[0].props["aria-pressed"], true, "선택 버튼은 현재 선택 상태를 알려야 합니다.");
      assert.match(rows[0].props.className, /neo-job-row--selected/, "선택한 Side 행은 선택 상태 class를 가져야 합니다.");
      assert.equal(rows[1].props["data-selected"], false, "선택하지 않은 Side 행은 선택 상태가 아니어야 합니다.");
      assert.equal(
        rows[0].find((node) => hasClass(node, "neo-switch")).props["aria-pressed"],
        true,
        "설정 오류가 있는 RUNNING Job도 Side 스위치를 켠 상태로 보여야 합니다.",
      );
      const brokenConfigDetail = renderer.root.findByProps({ "aria-label": "example details" });
      assert.equal(
        textOf(brokenConfigDetail.find((node) => hasClass(node, "neo-status-badge"))),
        "RUNNING",
        "설정 오류가 있는 RUNNING Job도 실제 RUNNING badge를 보여야 합니다.",
      );
      assert.match(
        textOf(brokenConfigDetail),
        /Unexpected token in JSON/,
        "실행 상태와 함께 설정 오류 문구도 보여야 합니다.",
      );

      await act(async () => {
        selectors[0].props.onClick();
      });
      assert.deepEqual(channels[1].sent.at(-1), { type: "select-job", name: "example" }, "실제 선택 버튼은 Job 선택 메시지를 보내야 합니다.");

      await act(async () => { selectors[1].props.onClick(); });
      assert.deepEqual(channels[1].sent.at(-1), { type: "select-job", name: "second" }, "Side 행 클릭은 선택 메시지를 보내야 합니다.");
      const selectedRows = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      assert.equal(selectedRows[0].props["data-selected"], false, "다른 Job을 누르면 이전 Side 행 선택을 해제해야 합니다.");
      assert.equal(selectedRows[1].props["data-selected"], true, "Side 행 클릭은 local 선택도 바로 바꿔야 합니다.");
      assert.match(selectedRows[1].props.className, /neo-job-row--selected/, "새로 누른 Side 행에 선택 상태 class를 줘야 합니다.");
      assert.match(
        selectedRows[1].find((node) => hasClass(node, "neo-job-name")).props.title,
        /STOPPED/,
        "오류가 없는 Side Job은 현재 상태를 이름 도움말에서 확인할 수 있어야 합니다.",
      );
      assert.equal(
        selectedRows[1].findAll((node) => hasClass(node, "neo-status-dot")).length,
        0,
        "기존 패키지와 같이 Side Job에는 별도 상태 점을 추가하지 않아야 합니다.",
      );
      assert.equal(textOf(renderer.root.find((node) => node.props && node.props.className === "neo-job-detail__title")), "second", "선택 메시지를 받은 Main은 해당 Job 상세를 보여야 합니다.");
      const secondDetail = renderer.root.find((node) => (
        node.props && node.props["aria-label"] === "second details"
      ));
      assert.equal(
        secondDetail.findAllByProps({ "aria-label": "second Start" }).length,
        0,
        "side=yes Main은 Side 스위치와 중복되는 Start 버튼을 보여주면 안 됩니다.",
      );
      assert.equal(
        secondDetail.findAllByProps({ "aria-label": "second Stop" }).length,
        0,
        "side=yes Main은 Side 스위치와 중복되는 Stop 버튼을 보여주면 안 됩니다.",
      );

      const editSecond = renderer.root.findByProps({ "aria-label": "second Edit" });
      assert.equal(editSecond.props.disabled, false, "멈춘 Job은 Edit할 수 있어야 합니다.");
      await act(async () => { editSecond.props.onClick(); });
      const editName = renderer.root.findByProps({ name: "job-name" });
      const editInterval = renderer.root.findByProps({ name: "interval-ms" });
      assert.equal(editName.props.value, "second", "Edit 화면은 현재 Job 이름을 채워야 합니다.");
      assert.equal(editName.props.disabled, true, "Edit 중에는 서비스 식별자인 Job 이름을 바꿀 수 없어야 합니다.");
      assert.equal(editInterval.props.value, "2000", "Edit 화면은 현재 intervalMs를 채워야 합니다.");
      await act(async () => {
        editInterval.props.onChange({ target: { value: "2500" } });
      });
      await act(async () => {
        await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
      });
      assert.deepEqual(
        updateBodies.at(-1),
        { name: "second", config: { intervalMs: 2500 } },
        "Edit 저장은 이름과 수정한 config만 update API로 보내야 합니다.",
      );
      assert.match(textOf(renderer.toJSON()), /intervalMs2500/, "Update 성공 뒤 수정된 Job 상세를 다시 보여야 합니다.");

      const removedSecond = jobs[1];
      jobs = jobs.filter((job) => job.name !== "second");
      await act(async () => {
        await Promise.all(intervals.map(({ callback }) => callback()));
      });
      const rowsAfterPollingRemoval = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      assert.equal(rowsAfterPollingRemoval[0].props["data-selected"], true, "선택 Job이 polling에서 사라지면 Side는 기본 Job을 안전하게 선택해야 합니다.");
      assert.equal(textOf(rowsAfterPollingRemoval[0].find((node) => hasClass(node, "neo-job-name"))), "example", "사라진 Side 선택은 example 우선 규칙으로 복구해야 합니다.");
      jobs = [...jobs, removedSecond];
      await act(async () => {
        await Promise.all(intervals.map(({ callback }) => callback()));
      });
      const rowsAfterRestore = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      await act(async () => {
        rowsAfterRestore[1].find((node) => hasClass(node, "neo-job-select")).props.onClick();
      });

      const refreshedRows = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      const secondRow = refreshedRows[1];
      const secondSwitch = secondRow.findByProps({ "aria-label": "second Start" });
      assert.equal(Object.hasOwn(secondRow.props, "onClick"), false, "행 컨테이너는 스위치 클릭을 선택으로 처리하면 안 됩니다.");
      assert.equal(secondRow.props["data-selected"], true, "스위치를 누르기 전 second가 선택되어 있어야 합니다.");
      const selectCountBeforeToggle = channels[1].sent.filter((message) => message.type === "select-job").length;
      const listCountBeforeToggle = requests.filter((request) => request.url.endsWith("/jobs/list")).length;
      await act(async () => {
        await secondSwitch.props.onClick();
      });
      const rowsAfterSecondSwitch = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      assert.equal(rowsAfterSecondSwitch[1].props["data-selected"], true, "Side 스위치 클릭은 현재 선택을 바꾸면 안 됩니다.");
      assert.equal(rowsAfterSecondSwitch[0].props["data-selected"], false, "Side 스위치 클릭은 다른 Job을 선택하면 안 됩니다.");
      assert.equal(channels[1].sent.filter((message) => message.type === "select-job").length, selectCountBeforeToggle, "Side 스위치 클릭은 Job 선택을 바꾸면 안 됩니다.");
      assert.equal(requests.some((request) => request.url.includes("/jobs/start?name=second")), true, "중지된 Side Job 스위치는 start를 호출해야 합니다.");
      assert.equal(
        requests.filter((request) => request.url.endsWith("/jobs/list")).length > listCountBeforeToggle,
        true,
        "Start 성공 뒤 즉시 refresh를 유지해야 합니다.",
      );
      assert.deepEqual(
        channels[1].sent.at(-1),
        { type: "refresh" },
        "Start 성공 뒤 BroadcastChannel refresh를 유지해야 합니다.",
      );

      const exampleSwitch = renderer.root.findAll((node) => hasClass(node, "neo-job-row"))[0]
        .findByProps({ "aria-label": "example Stop" });
      await act(async () => {
        await exampleSwitch.props.onClick();
      });
      assert.equal(requests.some((request) => request.url.includes("/jobs/stop?name=example")), true, "실행 중인 Side Job 스위치는 stop을 호출해야 합니다.");

      const addButton = renderer.root.findByProps({ "aria-label": "New Job" });
      assert.equal(addButton.props.title, "New Job", "icon-only New Job 버튼은 기존 패키지처럼 tooltip 제목을 제공해야 합니다.");
      await act(async () => { addButton.props.onClick(); });
      assert.deepEqual(channels[1].sent.at(-1), { type: "new-job" }, "New Job 버튼은 new-job 메시지를 보내야 합니다.");
      assert.equal(
        renderer.root.findAll((node) => hasClass(node, "neo-job-select") && node.props["aria-pressed"] === true).length,
        0,
        "새 Job form을 열면 Side의 기존 선택을 비워야 합니다.",
      );
      const form = renderer.root.findByType("form");
      const nameInput = renderer.root.findByProps({ name: "job-name" });
      const intervalInput = renderer.root.findByProps({ name: "interval-ms" });
      assert.deepEqual(
        { min: intervalInput.props.min, max: intervalInput.props.max, step: intervalInput.props.step },
        { min: "1000", max: "60000", step: "1" },
        "intervalMs 입력은 backend의 1000~60000 정수 계약을 그대로 써야 합니다.",
      );
      await act(async () => {
        nameInput.props.onChange({ target: { value: "third" } });
        intervalInput.props.onChange({ target: { value: "2500" } });
      });

      deferCreate = true;
      let createPromise;
      act(() => {
        createPromise = form.props.onSubmit({ preventDefault() {} });
      });
      let createButton = renderer.root.findByProps({ "aria-label": "Create Job" });
      assert.equal(createButton.props.disabled, true, "생성 요청 중에는 생성 버튼이 잠겨야 합니다.");
      const sideToggleDuringCreate = renderer.root.findAll((node) => hasClass(node, "neo-job-row"))[0]
        .findByProps({ "aria-label": "example Start" });
      await act(async () => {
        await sideToggleDuringCreate.props.onClick();
      });
      createButton = renderer.root.findByProps({ "aria-label": "Create Job" });
      assert.equal(createButton.props.disabled, true, "다른 action이 끝나도 진행 중인 생성 버튼은 잠겨 있어야 합니다.");
      await act(async () => {
        releaseCreate();
        await createPromise;
      });
      deferCreate = false;
      assert.equal(textOf(renderer.root.find((node) => node.props && node.props.className === "neo-job-detail__title")), "third", "생성 성공 뒤 새 Job을 선택해야 합니다.");
      assert.deepEqual(
        channels[0].sent.slice(-2),
        [{ type: "refresh" }, { type: "select-job", name: "third" }],
        "생성 성공은 refresh 뒤 새 Job 선택을 Side에 알려야 합니다.",
      );
      const rowsAfterCreate = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      const selectedAfterCreate = rowsAfterCreate.find((row) => row.props["data-selected"] === true);
      assert.equal(selectedAfterCreate && textOf(selectedAfterCreate.find((node) => hasClass(node, "neo-job-name"))), "third", "Main 생성 성공 뒤 Side도 새 Job을 선택해야 합니다.");

      const deleteThird = renderer.root.findByProps({ "aria-label": "third Delete" });
      const listCountBeforeDelete = requests.filter((request) => request.url.endsWith("/jobs/list")).length;
      await act(async () => { await deleteThird.props.onClick(); });
      assert.equal(
        requests.filter((request) => request.url.endsWith("/jobs/list")).length > listCountBeforeDelete,
        true,
        "Delete 성공 뒤 즉시 jobs/list를 다시 읽어야 합니다.",
      );
      const deleteWarning = renderer.root.find((node) => hasClass(node, "neo-status-message--warning"));
      assert.match(textOf(deleteWarning), /result removal failed/, "Delete 성공의 결과 파일 정리 경고를 화면에 보여야 합니다.");
      assert.equal(hasClass(deleteWarning, "neo-status-message--error"), false, "Delete 성공의 정리 경고를 오류 스타일로 표시하면 안 됩니다.");
      assert.equal(textOf(renderer.root.find((node) => node.props && node.props.className === "neo-job-detail__title")), "second", "마지막으로 선택한 Job 삭제 뒤 이전 Job을 보여야 합니다.");
      assert.deepEqual(
        channels[0].sent.slice(-2),
        [{ type: "refresh" }, { type: "select-job", name: "second" }],
        "Delete 성공은 refresh 뒤 다음 Job 선택을 Side에 알려야 합니다.",
      );
      assert.deepEqual(
        channels[0].sent.at(-1),
        { type: "select-job", name: "second" },
        "Main에서 선택 Job을 삭제하면 다음 선택을 Side에 알려야 합니다.",
      );
      const rowsAfterDelete = renderer.root.findAll((node) => hasClass(node, "neo-job-row"));
      assert.equal(
        rowsAfterDelete.some((row) => textOf(row.find((node) => hasClass(node, "neo-job-name"))) === "third"),
        false,
        "Delete 성공 뒤 렌더된 Job 목록에서 third를 제거해야 합니다.",
      );
      const selectedAfterDelete = rowsAfterDelete
        .find((row) => row.props["data-selected"] === true);
      assert.equal(
        selectedAfterDelete && textOf(selectedAfterDelete.find((node) => hasClass(node, "neo-job-name"))),
        "second",
        "삭제 직후 Side와 Main은 같은 Job을 선택해야 합니다.",
      );

      await act(async () => { addButton.props.onClick(); });
      const refreshFailureForm = renderer.root.findByType("form");
      await act(async () => {
        renderer.root.findByProps({ name: "job-name" }).props.onChange({ target: { value: "refresh-failure" } });
      });
      failRefreshAfterCreate = true;
      await act(async () => {
        await refreshFailureForm.props.onSubmit({ preventDefault() {} });
      });
      assert.match(textOf(renderer.toJSON()), /CGI error \(HTTP 500\): 목록 조회 실패/, "POST 성공 뒤 목록 실패는 조회 오류로 보여야 합니다.");
      await act(async () => {
        await Promise.all(intervals.map(({ callback }) => callback()));
      });
      assert.doesNotMatch(textOf(renderer.toJSON()), /목록 조회 실패/, "다음 polling 성공은 이전 조회 오류를 지워야 합니다.");

      await act(async () => { addButton.props.onClick(); });
      const failedForm = renderer.root.findByType("form");
      const retryInput = renderer.root.findByProps({ name: "job-name" });
      assert.equal(retryInput.props.value, "", "성공한 생성 form을 다시 열면 이름 입력이 비어 있어야 합니다.");
      await act(async () => {
        retryInput.props.onChange({ target: { value: "retry-job" } });
      });
      createShouldFail = true;
      await act(async () => {
        await failedForm.props.onSubmit({ preventDefault() {} });
      });
      createShouldFail = false;
      assert.match(textOf(renderer.toJSON()), /작업 생성 실패/, "POST 자체 실패는 action 오류로 보여야 합니다.");
      await act(async () => {
        await Promise.all(intervals.map(({ callback }) => callback()));
      });
      assert.match(textOf(renderer.toJSON()), /작업 생성 실패/, "polling 성공이 action 오류를 지우면 안 됩니다.");
      listShouldHaveControllerError = true;
      await act(async () => {
        await Promise.all(intervals.map(({ callback }) => callback()));
      });
      assert.match(textOf(renderer.toJSON()), /작업 생성 실패/, "action 오류는 새 조회 오류와 별도로 남아야 합니다.");
      assert.match(textOf(renderer.toJSON()), /Controller error \(HTTP 503\): polling controller failure/, "최신 조회 오류가 action 오류에 가려지면 안 됩니다.");
      listShouldHaveControllerError = false;
    } else {
      const initialText = textOf(renderer.toJSON());
      assert.match(initialText, /alpha/, "example이 없으면 side=no jobs Main은 첫 Job 상세를 보여야 합니다.");
      assert.match(initialText, /RUNNING/, "Job 상세에는 상태가 보여야 합니다.");
      assert.match(initialText, /count7/, "Job 상세에는 count가 보여야 합니다.");
      assert.match(initialText, /intervalMs1500/, "Job 상세에는 intervalMs가 보여야 합니다.");
      assert.match(initialText, /serviceneo-pkg-self-test-alpha/, "Job 상세에는 service가 보여야 합니다.");
      assert.match(initialText, /updatedAt2026-07-28T01:02:03.000Z/, "Job 상세에는 updatedAt이 보여야 합니다.");
      assert.match(initialText, /"count": 7/, "Job 상세에는 결과 JSON이 보여야 합니다.");

      listShouldHaveControllerError = true;
      await act(async () => { await intervals[0].callback(); });
      const errorText = textOf(renderer.toJSON());
      assert.match(errorText, /Controller error \(HTTP 503\): polling controller failure/, "조회 실패 중에는 StatusMessages가 오류를 보여야 합니다.");
      assert.doesNotMatch(errorText, /Restore example/, "조회 실패 중에는 example 복구 버튼을 보여주면 안 됩니다.");
      listShouldHaveControllerError = false;
      await act(async () => { await intervals[0].callback(); });

      jobs = [...jobs, {
        name: "example",
        config: { intervalMs: 1000 },
        status: "STOPPED",
        statusKnown: true,
        registered: true,
        running: false,
        service: "neo-pkg-self-test-example",
        error: "",
        errorKind: "",
        resultError: "",
        result: null,
      }];
      await act(async () => { await intervals[0].callback(); });
      assert.equal(
        textOf(renderer.root.find((node) => node.props && node.props.className === "neo-job-detail__title")),
        "alpha",
        "첫 준비 완료에서 선택한 alpha는 다음 polling에 example이 추가되어도 유지해야 합니다.",
      );

      const deleteAlpha = renderer.root.findByProps({ "aria-label": "alpha Delete" });
      await act(async () => { await deleteAlpha.props.onClick(); });
      assert.equal(
        textOf(renderer.root.find((node) => node.props && node.props.className === "neo-job-detail__title")),
        "example",
        "선택한 alpha 삭제 뒤 원래 순서의 다음 Job인 example을 보여야 합니다.",
      );
      const deleteExample = renderer.root.findByProps({ "aria-label": "example Delete" });
      await act(async () => { await deleteExample.props.onClick(); });
      const emptyText = textOf(renderer.toJSON());
      assert.match(emptyText, /Restore example/, "side=no 마지막 Job 삭제 뒤 example 복구 버튼을 보여야 합니다.");
      assert.match(emptyText, /Choose side=yes/, "side=no 빈 화면은 여러 Job을 쓰는 방법을 알려야 합니다.");

      const restore = renderer.root.findAllByType("button").find((button) => button.props.children === "Restore example");
      await act(async () => { await restore.props.onClick(); });
      assert.deepEqual(
        createBodies.at(-1),
        { name: "example", config: { intervalMs: 1000 } },
        "복구 버튼은 example과 intervalMs 1000만 정확히 보내야 합니다.",
      );
      assert.equal(textOf(renderer.root.find((node) => node.props && node.props.className === "neo-job-detail__title")), "example", "복구 성공 뒤 example 상세를 다시 보여야 합니다.");
    }
  }

  await act(async () => { renderer.unmount(); });
  assert.equal(clearedIntervals.length, intervals.length, "실제 StarterView unmount는 모든 polling timer를 정리해야 합니다.");
  assert.equal(channels.every((channel) => channel.closed), true, "실제 StarterView unmount는 채널을 닫아야 합니다.");

  const cleanupSignals = [];
  globalThis.fetch = (_url, options = {}) => {
    cleanupSignals.push(options.signal);
    return new Promise(() => {});
  };
  let cleanupRenderer;
  await act(async () => { cleanupRenderer = create(React.createElement(StarterView, { surface: "main" })); });
  await act(async () => { cleanupRenderer.unmount(); });
  assert.equal(cleanupSignals.every((signal) => signal.aborted), true, "실제 StarterView unmount는 진행 중 fetch를 abort해야 합니다.");

  if (isSingle) {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/health")) {
        return jsonResponse({
          ok: false,
          data: {
            healthy: false,
            status: "error",
            pid: null,
            exit_code: null,
            error: "controller health unavailable",
            result: null,
          },
        }, 503, false);
      }
      return jsonResponse({ ok: false, error: "controller unavailable" }, 503, false);
    };
    let errorRenderer;
    await act(async () => { errorRenderer = create(React.createElement(StarterView, { surface: "main" })); });
    const healthErrorText = textOf(errorRenderer.toJSON());
    assert.match(healthErrorText, /Controller error \(HTTP 503\): controller health unavailable/, "single health 503은 공통 상태 메시지에서 Controller 오류로 보여야 합니다.");
    assert.match(textOf(errorRenderer.root.findByProps({ "aria-label": "Service details" })), /controller health unavailable/, "single health Controller 오류의 상세는 Main에도 보여야 합니다.");
    await act(async () => { errorRenderer.unmount(); });
  }
} finally {
  globalThis.fetch = original.fetch;
  globalThis.window = original.window;
  globalThis.BroadcastChannel = original.BroadcastChannel;
  globalThis.IS_REACT_ACT_ENVIRONMENT = original.actEnvironment;
  await server.close();
}
