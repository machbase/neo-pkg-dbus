import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const expectSide = true;
const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root: frontendRoot,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

function cssDeclarations(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^{}]*)\\}`, "ms"));
  assert.ok(match, `${selector} CSS 규칙이 있어야 합니다.`);
  return Object.fromEntries(
    match[1]
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const separator = declaration.indexOf(":");
        return [
          declaration.slice(0, separator).trim(),
          declaration.slice(separator + 1).trim(),
        ];
      }),
  );
}

function assertCssDeclarations(source, selector, expected) {
  const actual = cssDeclarations(source, selector);
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(
      actual[property],
      value,
      `${selector}의 ${property}는 ${value}여야 합니다.`,
    );
  }
}

function atRuleBody(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${marker} 규칙이 있어야 합니다.`);
  const openIndex = source.indexOf("{", markerIndex);
  let depth = 1;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  assert.fail(`${marker} 규칙의 닫는 괄호가 있어야 합니다.`);
}

function assertClass(markup, className, message) {
  assert.match(
    markup,
    new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`),
    message,
  );
}

try {
  const { apiBase, jobsApi, serviceApi } = await server.ssrLoadModule("/src/api.js");
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      async json() {
        return { ok: true, data: { accepted: true } };
      },
    };
  };
  try {
    assert.match(
      apiBase,
      /^\/public\/[^/]+\/cgi-bin\/api$/,
      "API 기본 경로는 패키지의 public CGI API여야 합니다.",
    );
    await jobsApi.list();
    await jobsApi.health();
    await jobsApi.create("batch", { intervalMs: 2000 });
    await jobsApi.update("batch", { intervalMs: 3000 });
    await jobsApi.start("batch");
    await jobsApi.stop("batch");
    await jobsApi.remove("batch");
    await serviceApi.start();
    await serviceApi.stop();
    await serviceApi.health();
    assert.deepEqual(
      requests.map(({ url, options }) => ({
        url,
        method: options.method || "GET",
        body: options.body || null,
      })),
      [
        { url: `${apiBase}/jobs/list`, method: "GET", body: null },
        { url: `${apiBase}/health`, method: "GET", body: null },
        {
          url: `${apiBase}/jobs/create`,
          method: "POST",
          body: JSON.stringify({ name: "batch", config: { intervalMs: 2000 } }),
        },
        {
          url: `${apiBase}/jobs/update`,
          method: "POST",
          body: JSON.stringify({ name: "batch", config: { intervalMs: 3000 } }),
        },
        { url: `${apiBase}/jobs/start?name=batch`, method: "POST", body: null },
        { url: `${apiBase}/jobs/stop?name=batch`, method: "POST", body: null },
        { url: `${apiBase}/jobs/delete?name=batch`, method: "POST", body: null },
        { url: `${apiBase}/service/start`, method: "POST", body: null },
        { url: `${apiBase}/service/stop`, method: "POST", body: null },
        { url: `${apiBase}/health`, method: "GET", body: null },
      ],
      "조작 API는 실제 CGI 경로와 POST 요청을 사용해야 합니다.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { StarterView } = await server.ssrLoadModule("/src/StarterView.jsx");
  const indexChildren = [];
  if (expectSide) {
    indexChildren.push(
      React.createElement(
        "aside",
        { className: "starter-index-side", key: "side" },
        React.createElement(StarterView, { surface: "side" }),
      ),
    );
  }
  indexChildren.push(
    React.createElement(
      "main",
      { className: "starter-index-main", key: "main" },
      React.createElement(StarterView, { surface: "main" }),
    ),
  );
  const markup = renderToStaticMarkup(
    React.createElement("div", { className: "starter-index" }, indexChildren),
  );
  const mainCount = (markup.match(/<main(?:\s|>)/g) ?? []).length;
  const asideCount = (markup.match(/<aside(?:\s|>)/g) ?? []).length;
  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const labelledBy = [
    ...markup.matchAll(/\saria-labelledby="([^"]+)"/g),
  ].map((match) => match[1]);

  assert.equal(mainCount, 1, "index에는 보이는 main landmark가 하나여야 합니다.");
  assert.equal(
    asideCount,
    expectSide ? 1 : 0,
    "side 선택과 aside landmark가 맞아야 합니다.",
  );
  assert.equal(ids.length, new Set(ids).size, "index의 모든 id는 고유해야 합니다.");
  assert.equal(labelledBy.length, 0, "공통 hero 상태 카드는 새 profile 화면에 남으면 안 됩니다.");
  for (const labelledById of labelledBy) {
    assert.ok(
      ids.includes(labelledById),
      `aria-labelledby가 존재하는 id를 가리켜야 합니다: ${labelledById}`,
    );
  }
  if (expectSide) {
    assert.ok(
      markup.indexOf("<aside") < markup.indexOf("<main"),
      "모바일 문서 순서는 Side 다음 Main이어야 합니다.",
    );
  }

  const mainMarkup = renderToStaticMarkup(
    React.createElement(StarterView, { surface: "main" }),
  );
  const sideMarkup = renderToStaticMarkup(
    React.createElement(StarterView, { surface: "side" }),
  );
  if ("jobs" === "jobs") {
    assert.match(mainMarkup, /Loading status/, "첫 조회 전 jobs Main은 loading 상태를 보여야 합니다.");
    assert.doesNotMatch(mainMarkup, /Restore example/, "첫 조회 전 jobs Main은 example 복구 기능을 보여주면 안 됩니다.");
    if (expectSide) {
      assert.match(sideMarkup, /aria-label="New Job"/, "jobs Side에는 New Job 아이콘 기능이 있어야 합니다.");
    }
    assert.doesNotMatch(markup, /전체 요약/, "jobs의 기존 공통 Side 요약 카드는 제거해야 합니다.");

    const { JobsMain, JobsSide } = await server.ssrLoadModule("/src/components/JobsView.jsx");
    const jobState = {
      view: {
        phase: "ready-data",
        snapshot: {
          jobs: [{
            name: "very-long-package-job-name",
            config: { intervalMs: 1000 },
            status: "RUNNING",
            running: true,
            service: "very-long-controller-service-name",
            error: "",
            errorKind: "",
            resultError: "",
            result: { count: 1, updatedAt: "2026-07-28T00:00:00.000Z" },
          }],
        },
      },
      packageChannel: { channel: null, newJob() {}, selectJob() {} },
      isPending() { return false; },
      async runAction() { return true; },
    };
    const jobsRoleMarkup = renderToStaticMarkup(
      React.createElement(React.Fragment, null,
        React.createElement(JobsSide, { state: jobState }),
        React.createElement(JobsMain, { state: jobState, hasSide: expectSide }),
      ),
    );
    const jobsMainMarkup = renderToStaticMarkup(
      React.createElement(JobsMain, { state: jobState, hasSide: expectSide }),
    );
    for (const className of [
      "neo-jobs-side",
      "neo-jobs-side__header",
      "neo-job-row",
      "neo-job-name",
      "neo-switch",
      "neo-job-detail",
      "neo-job-detail__header",
      "neo-job-detail__metrics",
      "neo-job-actions",
      "neo-result-json",
    ]) {
      assertClass(jobsRoleMarkup, className, `jobs 렌더 결과에 ${className} 역할 class가 있어야 합니다.`);
    }
    assert.match(
      jobsRoleMarkup,
      /aria-label="New Job"[^>]*title="New Job"/,
      "jobs Side의 생성 동작은 기존 패키지처럼 New Job 아이콘 버튼이어야 합니다.",
    );
    assert.match(
      jobsRoleMarkup,
      /aria-label="Refresh"[^>]*title="Refresh"/,
      "jobs Side에는 기존 패키지와 같은 Refresh 아이콘 버튼이 있어야 합니다.",
    );
    assert.doesNotMatch(
      jobsRoleMarkup,
      /neo-status-dot/,
      "jobs Side 행은 기존 패키지처럼 상태 점 없이 이름과 스위치만 보여야 합니다.",
    );
    assert.match(
      jobsRoleMarkup,
      />very-long-package-job-name</,
      "긴 Job 이름은 렌더된 DOM에 전체 값이 남아야 합니다.",
    );
    assert.match(jobsRoleMarkup, /aria-label="very-long-package-job-name Edit"/, "Job 상세에는 설정 수정 버튼이 있어야 합니다.");
    assert.match(jobsRoleMarkup, /aria-label="very-long-package-job-name Delete"/, "Job 상세에는 삭제 버튼이 있어야 합니다.");
    if (expectSide) {
      assert.doesNotMatch(jobsMainMarkup, /aria-label="very-long-package-job-name Start"/, "side=yes는 Side 스위치가 시작을 맡으므로 Main에 Start 버튼을 중복하면 안 됩니다.");
      assert.doesNotMatch(jobsMainMarkup, /aria-label="very-long-package-job-name Stop"/, "side=yes는 Side 스위치가 정지를 맡으므로 Main에 Stop 버튼을 중복하면 안 됩니다.");
    } else {
      assert.match(jobsMainMarkup, /aria-label="very-long-package-job-name Start"/, "side=no는 Main에 시작 제어가 남아야 합니다.");
      assert.match(jobsMainMarkup, /aria-label="very-long-package-job-name Stop"/, "side=no는 Main에 정지 제어가 남아야 합니다.");
    }
  } else {
    assert.match(mainMarkup, /Start/, "single Main에는 시작 제어가 있어야 합니다.");
    assert.match(mainMarkup, /count/, "single Main에는 count가 있어야 합니다.");
    assert.match(mainMarkup, /PID/, "single Main에는 PID가 있어야 합니다.");
    assert.match(mainMarkup, /exit code/, "single Main에는 exit code가 있어야 합니다.");
    assert.match(mainMarkup, /packageService\.managed/, "single Main에는 관리 모델이 있어야 합니다.");
    assert.match(mainMarkup, /cgi-bin\/data\/service\.counter\.json/, "single Main에는 결과 파일 경로가 있어야 합니다.");
    assert.match(mainMarkup, /No result yet/, "결과가 없을 때 single Main은 빈 결과 설명을 보여야 합니다.");
    assert.doesNotMatch(sideMarkup, /Start service/, "Side는 서비스를 제어하면 안 됩니다.");
    assert.doesNotMatch(sideMarkup, /Stop service/, "Side는 서비스를 제어하면 안 됩니다.");
    if (expectSide) {
      assert.match(sideMarkup, /Service/, "single Side는 서비스 이름을 요약해야 합니다.");
      assert.match(sideMarkup, /Status/, "single Side는 상태만 요약해야 합니다.");
      assert.match(sideMarkup, /Count/, "single Side는 count만 요약해야 합니다.");
      assert.match(sideMarkup, /Updated/, "single Side는 마지막 갱신 시각을 요약해야 합니다.");
      assert.doesNotMatch(sideMarkup, /PID|exit code|packageService\.managed|cgi-bin\/data/, "single Side는 Main 상세를 중복해 보여주면 안 됩니다.");
    }

    const { SingleMain, SingleSide } = await server.ssrLoadModule("/src/components/SingleView.jsx");
    const singleState = {
      view: {
        phase: "ready-data",
        snapshot: {
          health: {
            status: "running",
            pid: 123,
            exit_code: 0,
            error: "",
            resultError: "",
            result: { count: 1, updatedAt: "2026-07-28T00:00:00.000Z" },
          },
        },
      },
      isPending() { return false; },
      async runAction() { return true; },
    };
    const singleRoleMarkup = renderToStaticMarkup(
      React.createElement(React.Fragment, null,
        React.createElement(SingleSide, { state: singleState }),
        React.createElement(SingleMain, { state: singleState }),
      ),
    );
    for (const className of [
      "neo-single-side",
      "neo-single-side__summary",
      "neo-single-detail",
      "neo-single-detail__header",
      "neo-single-detail__metrics",
      "neo-single-detail__actions",
      "neo-result-json",
    ]) {
      assertClass(singleRoleMarkup, className, `single 렌더 결과에 ${className} 역할 class가 있어야 합니다.`);
    }

    const errorSideMarkup = renderToStaticMarkup(
      React.createElement(SingleSide, {
        state: {
          ...singleState,
          view: {
            phase: "ready-data",
            snapshot: {
              health: {
                ...singleState.view.snapshot.health,
                healthy: false,
                error: "controller detail",
                resultError: "result detail",
              },
            },
          },
        },
      }),
    );
    assertClass(errorSideMarkup, "neo-single-side__error", "single Side 오류는 전용 요소 하나에 표시해야 합니다.");
    assert.equal((errorSideMarkup.match(/neo-single-side__error/g) ?? []).length, 1, "single Side 오류 요소는 하나여야 합니다.");
    assert.match(errorSideMarkup, /controller detail/, "single Side는 Controller 오류를 우선 표시해야 합니다.");
    assert.doesNotMatch(errorSideMarkup, /result detail/, "Controller 오류가 있으면 Result 오류를 중복 표시하면 안 됩니다.");
    assert.doesNotMatch(errorSideMarkup, /<button(?:\s|>)/, "오류가 있어도 single Side는 읽기 전용이어야 합니다.");
  }
  assert.doesNotMatch(markup, /Machbase Neo Package/, "기존 공통 hero 브랜드는 profile 화면에서 제거해야 합니다.");
  assert.doesNotMatch(markup, /선택한 패키지 프로필/, "기존 profile tag 묶음은 제거해야 합니다.");

  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assertCssDeclarations(styles, ".neo-job-row", {
    padding: "0",
    gap: "0",
  });
  assertCssDeclarations(styles, ".neo-job-select", {
    "padding-left": "12px",
    "padding-right": "6px",
  });
  assertCssDeclarations(styles, ".neo-switch", {
    "margin-right": "12px",
  });
  assertCssDeclarations(styles, ".neo-job-select:hover:not(:disabled)", {
    border: "0",
    background: "transparent",
    color: "inherit",
  });
  const htmlEntries = [
    await readFile(new URL("../index.html", import.meta.url), "utf8"),
    await readFile(new URL("../main.html", import.meta.url), "utf8"),
  ];
  if (expectSide) htmlEntries.push(await readFile(new URL("../side.html", import.meta.url), "utf8"));
  for (const html of htmlEntries) {
    assert.match(html, /<html lang="en">/, "모든 frontend entry는 기존 패키지와 같은 영문 UI 문서여야 합니다.");
    assert.match(
      html,
      /Material\+Symbols\+Outlined/,
      "모든 frontend entry는 기존 패키지와 같은 Material Symbols 아이콘 글꼴을 불러야 합니다.",
    );
  }
  assertCssDeclarations(styles, ":root", {
    "--neo-bg": "#1e1e1e",
    "--neo-panel": "#252525",
    "--neo-elevated": "#2c2c2c",
    "--neo-selected": "#005fb8",
    "--neo-hover": "#0075e2",
    "--neo-border": "rgba(255, 255, 255, 0.13)",
    "--neo-radius": "4px",
    "--neo-side-width": "256px",
    "--neo-side-header-height": "40px",
    "--neo-section-header-height": "22px",
    "--neo-job-row-height": "28px",
    "--neo-warning": "#f5c451",
    "--neo-font-sans": "Pretendard, sans-serif",
    "--neo-font-mono": "D2Coding, monospace",
  });
  assertCssDeclarations(styles, ".neo-status-message--warning", {
    color: "var(--neo-warning)",
  });
  assertCssDeclarations(styles, "html, body, #root", {
    width: "100%",
    height: "100%",
  });
  assertCssDeclarations(styles, "body", {
    "overflow-x": "hidden",
    background: "var(--neo-bg)",
    "font-family": "var(--neo-font-sans)",
  });
  assertCssDeclarations(styles, "*,\n*::before,\n*::after", {
    "font-family": "var(--neo-font-sans)",
  });
  assertCssDeclarations(styles, ".starter-index", {
    display: "grid",
    "grid-template-columns": "minmax(0, 1fr)",
    width: "100%",
    height: "100%",
    "min-width": "0",
    "overflow-x": "hidden",
  });
  assertCssDeclarations(styles, ".starter-index--split", {
    "grid-template-columns": "var(--neo-side-width) minmax(0, 1fr)",
  });
  assertCssDeclarations(styles, ".starter-index-side", {
    "min-width": "0",
    "overflow-x": "hidden",
    "border-right": "1px solid var(--neo-border)",
  });
  assertCssDeclarations(styles, ".starter-index-main", {
    width: "100%",
    "min-width": "0",
    "overflow-x": "hidden",
    background: "var(--neo-panel)",
  });
  assertCssDeclarations(styles, ".starter-shell", {
    width: "100%",
    height: "100%",
    "min-width": "0",
    "overflow-x": "hidden",
  });
  assertCssDeclarations(styles, ".starter-panel", {
    width: "100%",
    height: "100%",
    "min-width": "0",
    "overflow-x": "hidden",
  });
  assertCssDeclarations(styles, "button, input", {
    "font-family": "var(--neo-font-sans)",
    "font-size": "12px",
  });
  assertCssDeclarations(styles, ".neo-mono", {
    "font-family": "var(--neo-font-mono)",
  });
  assertCssDeclarations(styles, ".neo-jobs-side__header", {
    height: "var(--neo-side-header-height)",
  });
  assertCssDeclarations(styles, ".neo-jobs-side__header h2", {
    height: "var(--neo-section-header-height)",
    "font-family": "var(--neo-font-sans)",
    "line-height": "1",
  });
  assertCssDeclarations(styles, ".neo-job-list__header h3", {
    "line-height": "1",
  });
  assertCssDeclarations(styles, ".neo-job-row", {
    height: "var(--neo-job-row-height)",
    "min-width": "0",
    "font-family": "var(--neo-font-sans)",
  });
  const jobRowRule = cssDeclarations(styles, ".neo-job-row");
  assert.equal(jobRowRule["min-height"], undefined, "기존 패키지와 같은 고정 28px Job 행을 사용해야 합니다.");
  assertCssDeclarations(styles, ".neo-job-row--selected", {
    background: "var(--neo-selected)",
  });
  assertCssDeclarations(styles, ".neo-job-row:hover", {
    background: "var(--neo-hover)",
  });
  const jobNameRule = cssDeclarations(styles, ".neo-job-name");
  assert.equal(jobNameRule["min-width"], "0", "Job 이름은 flex 안에서 줄어들 수 있어야 합니다.");
  assert.equal(jobNameRule.overflow, "hidden", "긴 Job 이름은 행 높이를 바꾸지 않도록 잘라야 합니다.");
  assert.equal(jobNameRule["text-overflow"], "ellipsis", "긴 Job 이름은 말줄임표로 표시해야 합니다.");
  assert.equal(jobNameRule["white-space"], "nowrap", "긴 Job 이름은 한 줄에 유지해야 합니다.");
  assertCssDeclarations(styles, ".neo-single-side__error", {
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  });
  assertCssDeclarations(styles, ".neo-switch", {
    width: "28px",
    height: "28px",
    "flex-shrink": "0",
  });
  assertCssDeclarations(styles, ".neo-switch__visual", {
    width: "28px",
    height: "13px",
    "border-radius": "9999px",
  });
  assertCssDeclarations(styles, ".neo-switch__thumb", {
    width: "9px",
    height: "9px",
    "border-radius": "9999px",
  });
  for (const selector of [".neo-job-detail", ".neo-single-detail"]) {
    assertCssDeclarations(styles, selector, {
      display: "grid",
      width: "100%",
      "min-height": "100%",
      "min-width": "0",
      "overflow-x": "hidden",
    });
  }
  for (const selector of [".neo-job-detail__header", ".neo-single-detail__header"]) {
    assertCssDeclarations(styles, selector, {
      height: "80px",
      "min-height": "80px",
      "min-width": "0",
    });
  }
  assertCssDeclarations(styles, ".neo-job-detail__metrics", {
    display: "grid",
    "grid-template-columns": "repeat(3, minmax(0, 1fr))",
    "min-width": "0",
    margin: "32px 40px 16px",
  });
  assertCssDeclarations(styles, ".neo-single-detail__metrics", {
    display: "grid",
    "grid-template-columns": "repeat(2, minmax(0, 1fr))",
    "min-width": "0",
  });
  for (const selector of [".neo-job-actions", ".neo-single-detail__actions"]) {
    assertCssDeclarations(styles, selector, {
      "grid-column": "2",
      "grid-row": "1",
      height: "80px",
      "min-height": "80px",
    });
  }
  assertCssDeclarations(styles, ".neo-result-json", {
    "min-width": "0",
    "overflow-x": "auto",
    "overflow-wrap": "anywhere",
    "border-radius": "var(--neo-radius)",
    background: "var(--neo-bg)",
  });
  assertCssDeclarations(styles, ".neo-summary-card", {
    background: "var(--neo-bg)",
    border: "1px solid var(--neo-border)",
    "border-radius": "var(--neo-radius)",
    padding: "32px",
  });
  assertCssDeclarations(styles, ".neo-status-badge--running", {
    "border-color": "rgba(113, 224, 113, 0.3)",
    background: "rgba(113, 224, 113, 0.15)",
    color: "var(--neo-success)",
  });
  assertCssDeclarations(styles, ".neo-status-badge--stopped", {
    "border-color": "rgba(255, 83, 83, 0.3)",
    background: "rgba(255, 83, 83, 0.15)",
    color: "var(--neo-text)",
  });
  assertCssDeclarations(styles, ".neo-job-actions button,\n.neo-single-detail__actions button", {
    height: "32px",
    "min-height": "32px",
    padding: "0 16px",
    "font-size": "13px",
    "font-weight": "500",
    gap: "6px",
    "line-height": "1",
  });
  assertCssDeclarations(styles, ".neo-job-actions .material-symbols-outlined,\n.neo-single-detail__actions .material-symbols-outlined", {
    "font-size": "14px",
  });
  assertCssDeclarations(styles, ".neo-side-section-action .material-symbols-outlined", {
    "font-size": "14px",
  });
  assertCssDeclarations(styles, ".neo-status-badge", {
    display: "inline-flex",
    "align-items": "center",
    "font-size": "13px",
  });
  for (const selector of [".neo-summary-card h3", ".neo-result-card h3"]) {
    assertCssDeclarations(styles, selector, {
      "font-size": "15px",
      "font-weight": "700",
      "line-height": "1",
    });
  }
  assertCssDeclarations(styles, ".neo-page-header", {
    height: "80px",
    "min-height": "80px",
    padding: "0 40px",
  });
  assertCssDeclarations(styles, ".neo-page-header h2", {
    "line-height": "1",
  });
  assertCssDeclarations(styles, ".neo-page-header__actions button", {
    height: "32px",
    "min-height": "32px",
    padding: "0 16px",
    "font-size": "13px",
    "font-weight": "500",
    "line-height": "1",
  });
  assertCssDeclarations(styles, ".neo-page-header__actions .material-symbols-outlined", {
    "font-size": "14px",
  });
  assertCssDeclarations(styles, ".neo-icon-button", {
    width: "32px",
    "min-width": "32px",
    height: "32px",
    "min-height": "32px",
  });
  assertCssDeclarations(styles, ".neo-form-card h3", {
    "line-height": "1",
  });
  assertCssDeclarations(styles, ".neo-single-side > h2", {
    "line-height": "1",
  });
  assertCssDeclarations(styles, ".neo-metric__label", {
    "font-family": "var(--neo-font-sans)",
    "font-size": "12px",
    "font-weight": "600",
    "text-transform": "uppercase",
  });
  assertCssDeclarations(styles, ".starter-button--danger", {
    "border-color": "#fa6464",
    background: "#ff4747",
    color: "#f1f1f1",
  });
  assertCssDeclarations(styles, ".neo-job-form", {
    width: "100%",
    "min-height": "100%",
  });
  assertCssDeclarations(styles, ".neo-empty-state", {
    width: "min(100%, 560px)",
    margin: "auto",
    "border-radius": "var(--neo-radius)",
  });
  assertCssDeclarations(styles, ".neo-single-side__summary", {
    display: "grid",
    "grid-template-columns": "minmax(0, 1fr)",
    "min-width": "0",
  });
  for (const selector of [
    ".neo-single-side__summary dd",
    ".neo-metric__value",
    ".neo-job-errors",
    ".neo-status-message",
  ]) {
    assertCssDeclarations(styles, selector, {
      "min-width": "0",
      "overflow-wrap": "anywhere",
    });
  }
  const narrowMainStyles = atRuleBody(styles, "@media (max-width: 640px)");
  assertCssDeclarations(
    narrowMainStyles,
    ".starter-entry .neo-job-detail__metrics, .starter-entry .neo-single-detail__metrics",
    { "grid-template-columns": "minmax(0, 1fr)" },
  );
  const bodyRule = styles.match(/body\s*\{([^}]*)\}/s);
  assert.ok(bodyRule, "body 스타일이 있어야 합니다.");
  assert.doesNotMatch(bodyRule[1], /min-width\s*:/, "256px Side보다 큰 최소 너비를 강제하면 안 됩니다.");

  const indexSource = await readFile(
    new URL("../src/index.jsx", import.meta.url),
    "utf8",
  );
  assert.match(
    indexSource,
    /<aside\s+className="starter-index-side"/,
    "실제 index JSX가 Side를 aside landmark로 만들어야 합니다.",
  );
  assert.match(
    indexSource,
    /<main\s+className="starter-index-main"/,
    "실제 index JSX가 Main을 main landmark로 만들어야 합니다.",
  );
  if (expectSide) {
    assert.ok(
      indexSource.indexOf("<aside") < indexSource.indexOf("<main"),
      "실제 index JSX 순서는 Side 다음 Main이어야 합니다.",
    );
  }
} finally {
  await server.close();
}
