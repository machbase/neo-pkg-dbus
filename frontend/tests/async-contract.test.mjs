import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root: frontendRoot,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { ApiError, jobsApi, serviceApi } = await server.ssrLoadModule("/src/api.js");
  const { createRequestCoordinator } = await server.ssrLoadModule("/src/request-coordinator.js");
  const { createViewState, initialViewState } = await server.ssrLoadModule("/src/view-state.js");
  const { createPackageChannel } = await server.ssrLoadModule("/src/package-channel.js");

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      async json() {
        return {
          ok: false,
          data: {
            healthy: false,
            status: "error",
            error: "Neo Controller 연결 실패",
            result: { count: 9, startedAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-28T00:00:01Z" },
          },
        };
      },
    });
    await assert.rejects(
      serviceApi.health(),
      (error) => error instanceof ApiError
        && error.kind === "controller"
        && error.status === 503
        && error.message === "Neo Controller 연결 실패"
        && error.data.result.count === 9,
      "503 controller 응답은 상태 코드, 종류, 원문 데이터와 카운터를 보존해야 합니다.",
    );

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      async json() {
        return { ok: false, error: "controller unavailable" };
      },
    });
    for (const action of [serviceApi.start, serviceApi.stop]) {
      await assert.rejects(
        action(),
        (error) => error instanceof ApiError
          && error.kind === "controller"
          && error.status === 503
          && error.message === "controller unavailable",
        "single start/stop의 503은 일반 오류 본문이어도 Controller 오류여야 합니다.",
      );
    }

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      async json() {
        return { ok: false, kind: "controller", error: "jobs controller unavailable" };
      },
    });
    for (const action of [
      () => jobsApi.create("alpha", { intervalMs: 1000 }),
      () => jobsApi.start("alpha"),
      () => jobsApi.stop("alpha"),
      () => jobsApi.remove("alpha"),
    ]) {
      await assert.rejects(
        action(),
        (error) => error instanceof ApiError
          && error.kind === "controller"
          && error.status === 503
          && error.message === "jobs controller unavailable",
        "jobs 변경 API의 구조화된 Controller 오류를 CGI 오류와 구분해야 합니다.",
      );
    }

    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      async json() {
        return { ok: false, error: "작업 이름이 잘못되었습니다." };
      },
    });
    await assert.rejects(
      serviceApi.start(),
      (error) => error instanceof ApiError
        && error.kind === "cgi"
        && error.status === 400
        && error.message === "작업 이름이 잘못되었습니다.",
      "CGI 오류는 HTTP 상태와 오류 원문을 보존해야 합니다.",
    );

    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      async json() {
        return { ok: false };
      },
    });
    await assert.rejects(
      serviceApi.start(),
      (error) => error instanceof ApiError
        && error.kind === "cgi"
        && error.status === 500
        && error.message === "Request could not be completed.",
      "서버 오류 본문에 문구가 없으면 영어 기본 문구를 보여야 합니다.",
    );

    globalThis.fetch = async () => { throw new TypeError("network down"); };
    await assert.rejects(
      serviceApi.stop(),
      (error) => error instanceof ApiError
        && error.kind === "network"
        && error.status === null
        && error.message === "network down",
      "네트워크 실패는 network 종류로 구분해야 합니다.",
    );

    globalThis.fetch = async () => { throw new Error(); };
    await assert.rejects(
      serviceApi.stop(),
      (error) => error instanceof ApiError
        && error.kind === "network"
        && error.status === null
        && error.message === "Network request failed.",
      "네트워크 오류에 서버 문구가 없으면 영어 기본 문구를 보여야 합니다.",
    );

    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      async json() {
        throw new Error("invalid response body");
      },
    });
    await assert.rejects(
      serviceApi.health(),
      (error) => error instanceof ApiError
        && error.kind === "cgi"
        && error.status === 502
        && error.message === "Unable to read server response.",
      "응답 본문을 읽지 못하면 영어 기본 문구를 보여야 합니다.",
    );

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          data: {
            name: "alpha",
            cleanupError: "result removal failed",
          },
        };
      },
    });
    const result = await jobsApi.remove("alpha");
    assert.equal(
      result.cleanupError,
      "result removal failed",
      "jobs Delete 성공 응답의 결과 파일 정리 경고를 화면 상태까지 전달할 수 있어야 합니다.",
    );

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    try {
      globalThis.setTimeout = (callback) => {
        queueMicrotask(callback);
        return 1;
      };
      globalThis.clearTimeout = () => {};
      globalThis.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
      await Promise.race([
        assert.rejects(
          jobsApi.list(),
          (error) => error instanceof ApiError
            && error.kind === "network"
            && error.message === "Request timed out.",
          "응답이 멈춘 요청은 시간 제한 뒤 네트워크 오류가 되어야 합니다.",
        ),
        new Promise((_, reject) => {
          originalSetTimeout(
            () => reject(new Error("요청 시간 제한이 구현되지 않았습니다.")),
            50,
          );
        }),
      ]);

      globalThis.fetch = async (_url, options = {}) => ({
        ok: true,
        status: 200,
        async json() {
          return new Promise((resolve, reject) => {
            const rejectAbort = () => {
              const error = new Error("body aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (options.signal.aborted) rejectAbort();
            else options.signal.addEventListener("abort", rejectAbort);
          });
        },
      });
      await Promise.race([
        assert.rejects(
          jobsApi.list(),
          (error) => error instanceof ApiError
            && error.kind === "network"
            && error.message === "Request timed out.",
          "응답 본문이 멈춰도 같은 시간 제한 네트워크 오류가 되어야 합니다.",
        ),
        new Promise((_, reject) => {
          originalSetTimeout(
            () => reject(new Error("응답 본문 시간 제한이 구현되지 않았습니다.")),
            50,
          );
        }),
      ]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    initialViewState(),
    { phase: "initial-loading", snapshot: { jobs: [], health: null }, error: null },
    "첫 요청 전에는 빈 결과가 아니라 initial-loading 상태여야 합니다.",
  );
  assert.equal(
    createViewState({ jobs: [], health: { service_summary: { total: 0, running: 0, errors: [] } } }, null).phase,
    "ready-empty",
    "jobs 조회가 끝난 뒤 빈 목록만 ready-empty가 되어야 합니다.",
  );
  assert.equal(
    createViewState(null, new ApiError({ kind: "controller", status: 503, message: "controller", data: {} })).phase,
    "controller-error",
    "controller 오류는 빈 결과나 CGI 오류와 다른 화면 상태여야 합니다.",
  );

  const calls = [];
  const applied = [];
  const coordinator = createRequestCoordinator({
    load: ({ signal, generation }) => {
      const call = deferred();
      calls.push({ signal, generation, ...call });
      return call.promise;
    },
    apply: (value) => applied.push(value),
  });
  const first = coordinator.refresh();
  const second = coordinator.refresh({ force: true });
  assert.equal(calls.length, 2, "강제 새로고침은 이전 polling을 기다리지 않고 즉시 요청해야 합니다.");
  assert.equal(calls[0].signal.aborted, true, "강제 새로고침은 이전 요청을 취소해야 합니다.");
  calls[1].resolve("new");
  await second;
  calls[0].resolve("old");
  await first;
  assert.deepEqual(applied, ["new"], "오래된 응답은 최신 화면 상태를 덮어쓰면 안 됩니다.");

  const cleanupCalls = [];
  const cleanupCoordinator = createRequestCoordinator({
    load: ({ signal }) => {
      const call = deferred();
      cleanupCalls.push({ signal, ...call });
      return call.promise;
    },
    apply: () => { throw new Error("cleanup 뒤에는 응답을 적용하면 안 됩니다."); },
  });
  const pending = cleanupCoordinator.refresh();
  cleanupCoordinator.cleanup();
  assert.equal(cleanupCalls[0].signal.aborted, true, "effect cleanup은 진행 중 fetch를 취소해야 합니다.");
  cleanupCalls[0].resolve("ignored");
  await pending;

  const OriginalChannel = globalThis.BroadcastChannel;
  const channels = [];
  class FakeChannel {
    constructor(name) { this.name = name; channels.push(this); }
    postMessage(message) {
      this.sent ||= [];
      this.sent.push(message);
      for (const peer of channels) {
        if (peer !== this && peer.name === this.name && peer.onmessage) {
          peer.onmessage({ data: message });
        }
      }
    }
    close() { this.closed = true; }
  }
  globalThis.BroadcastChannel = FakeChannel;
  try {
    const disabled = createPackageChannel({ enabled: false, name: "app:test", onMessage: () => {} });
    disabled.refresh();
    disabled.selectJob("example");
    disabled.newJob();
    assert.equal(channels.length, 0, "side=no에서는 BroadcastChannel을 만들면 안 됩니다.");

    const received = [];
    const main = createPackageChannel({
      enabled: true,
      name: "app:test",
      onMessage: (message) => received.push(message),
    });
    const side = createPackageChannel({
      enabled: true,
      name: "app:test",
      onMessage: (message) => received.push(message),
    });

    side.selectJob("example");
    side.newJob();
    main.refresh();

    assert.deepEqual(side.channel.sent[0], {
      type: "select-job",
      name: "example",
    }, "Side에서 선택한 작업 이름을 Main으로 보내야 합니다.");
    assert.deepEqual(side.channel.sent[1], { type: "new-job" }, "Side의 새 작업 요청을 Main으로 보내야 합니다.");
    assert.deepEqual(main.channel.sent[0], { type: "refresh" }, "Main 새로고침을 Side로 보내야 합니다.");
    assert.deepEqual(received, [
      { type: "select-job", name: "example" },
      { type: "new-job" },
      { type: "refresh" },
    ], "같은 이름의 다른 surface는 세 유효한 메시지를 받아야 합니다.");

    const invalidReceived = [];
    const guard = createPackageChannel({
      enabled: true,
      name: "app:guard",
      onMessage: (message) => invalidReceived.push(message),
    });
    guard.channel.onmessage({ data: { type: "select-job", name: "" } });
    guard.channel.onmessage({ data: { type: "unknown" } });
    guard.channel.onmessage({ data: "refresh" });
    assert.deepEqual(invalidReceived, [], "빈 이름, 알 수 없는 type, 객체가 아닌 데이터는 전달하면 안 됩니다.");

    main.close();
    side.close();
    guard.close();
    assert.equal(channels.every((channel) => channel.closed), true, "채널 effect cleanup은 채널을 닫아야 합니다.");
  } finally {
    globalThis.BroadcastChannel = OriginalChannel;
  }
} finally {
  await server.close();
}
