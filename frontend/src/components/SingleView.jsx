import React from "react";
import { serviceApi } from "../api";
import {
  Metric,
  ResultJson,
  StatusBadge,
  counterValue,
  isTransitionalStatus,
} from "./CommonView";
import Icon from "./Icon";

const packageServiceName = "neo-pkg-dbus";
const resultPath = "cgi-bin/data/service.counter.json";
const startableStatuses = new Set(["stopped", "failed", "not_installed"]);

function healthValue(health, key) {
  return health && health[key] != null ? health[key] : null;
}

export function SingleSide({ state }) {
  const health = state.view.snapshot.health;
  const result = health && health.result;
  const error = health && (
    health.error
    || (health.resultError ? `Result error: ${health.resultError}` : "")
  );

  return (
    <section className="neo-single-side" aria-label="Service summary">
      <h2><Icon name="memory" /> <span>{packageServiceName}</span></h2>
      <dl className="neo-single-side__summary">
        <div><dt>Service</dt><dd>{packageServiceName}</dd></div>
        <div><dt>Status</dt><dd>{health ? <StatusBadge status={health.status} /> : "—"}</dd></div>
        <div><dt>Count</dt><dd>{counterValue(result)}</dd></div>
        <div><dt>Updated</dt><dd>{healthValue(result, "updatedAt") ?? "—"}</dd></div>
      </dl>
      {error ? <p className="neo-single-side__error" title={error}>{error}</p> : null}
    </section>
  );
}

export function SingleMain({ state }) {
  const health = state.view.snapshot.health;
  const result = health && health.result;
  const status = String((health && health.status) || "").toLowerCase();
  const running = status === "running";
  const transitioning = isTransitionalStatus(status);
  const actionable = running || startableStatuses.has(status);
  const actionKey = running ? "service:stop" : "service:start";
  const action = running
    ? () => serviceApi.stop()
    : () => serviceApi.start();

  return (
    <section className="neo-single-detail" aria-label="Service details">
      <div className="neo-single-detail__header">
        <h2>{packageServiceName}</h2>
        {health ? <StatusBadge status={health.status} /> : null}
      </div>
      <div className="neo-single-detail__metrics">
        <Metric label="status" value={healthValue(health, "status")} />
        <Metric label="count" value={counterValue(result)} />
        <Metric label="PID" value={healthValue(health, "pid")} mono />
        <Metric label="exit code" value={healthValue(health, "exit_code")} mono />
        <Metric label="packageService.managed" value="true" mono />
        <Metric label="result path" value={resultPath} mono />
      </div>
      {health && (health.error || health.status === "failed")
          ? <p className="starter-controller-detail">{health.error || "The service failed to run."}</p>
        : null}
      {health && health.resultError ? <p className="starter-controller-detail">Result error: {health.resultError}</p> : null}
      {result ? <ResultJson result={result} /> : <p className="neo-empty-result">No result yet.</p>}
      <div className="neo-single-detail__actions">
        <button
          type="button"
          aria-label={running ? "Stop service" : "Start service"}
          title={running ? "Stop" : "Start"}
          disabled={!actionable || transitioning || state.isPending(actionKey)}
          onClick={() => state.runAction(actionKey, action)}
        >
          <Icon name={running ? "stop" : "play_arrow"} />
          {health && health.status === "starting"
            ? "Starting"
            : health && health.status === "stopping"
              ? "Stopping"
              : running ? "Stop" : "Start"}
        </button>
      </div>
    </section>
  );
}
