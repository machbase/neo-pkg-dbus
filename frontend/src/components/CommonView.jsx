import React from "react";

const statusLabels = {
  running: "RUNNING",
  starting: "STARTING",
  stopping: "STOPPING",
  stopped: "STOPPED",
  failed: "FAILED",
  error: "ERROR",
  not_installed: "NOT INSTALLED",
  unknown: "UNKNOWN",
};

export function statusKey(status, running) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  if (Object.hasOwn(statusLabels, normalized)) return normalized;
  if (!normalized && running === true) return "running";
  return "unknown";
}

export function isTransitionalStatus(status) {
  const key = statusKey(status);
  return key === "starting" || key === "stopping";
}

export function errorLabel(error) {
  const status = error && error.status != null ? ` (HTTP ${error.status})` : "";
  const prefix = error && error.kind === "controller"
    ? "Controller error"
    : error && error.kind === "network"
      ? "Network error"
      : "CGI error";
  return `${prefix}${status}: ${(error && error.message) || "Unable to load status."}`;
}

export function StatusMessages({ view, actionError, actionWarning }) {
  return (
    <>
      {actionError ? <p className="starter-message starter-message--error neo-status-message neo-status-message--error" role="alert">{errorLabel(actionError)}</p> : null}
      {actionWarning ? <p className="starter-message starter-message--warning neo-status-message neo-status-message--warning" role="status">Cleanup warning: {actionWarning}</p> : null}
      {view.phase === "initial-loading" ? <p className="starter-message neo-status-message" aria-live="polite">Loading status…</p> : null}
      {view.error ? <p className="starter-message starter-message--error neo-status-message neo-status-message--error" role="alert">{errorLabel(view.error)}</p> : null}
    </>
  );
}

export function StatusBadge({ status, running }) {
  const key = statusKey(status, running);
  return <span className={`neo-status-badge neo-status-badge--${key}`}>{statusLabels[key]}</span>;
}

export function Metric({ label, value, mono = false }) {
  const displayValue = value === null || value === undefined ? "—" : String(value);
  const className = mono ? "neo-metric__value neo-mono" : "neo-metric__value";
  return <div className="neo-metric"><span className="neo-metric__label">{label}</span><strong className={className}>{displayValue}</strong></div>;
}

export function ResultJson({ result }) {
  if (result === null || result === undefined) return null;
  return <pre className="neo-result-json neo-mono">{JSON.stringify(result, null, 2)}</pre>;
}

export function EmptyState({ title, description, action }) {
  return (
    <section className="neo-empty-state">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action || null}
    </section>
  );
}

export function counterValue(result) {
  return result && Number.isInteger(result.count) ? String(result.count) : "—";
}

export function jobErrorLabels(job) {
  const detailFields = [
    ["configError", "Config error"],
    ["controllerError", "Controller error"],
    ["resultError", "Result error"],
  ];
  const labels = [];
  const seen = new Set();
  const hasDetailFields = detailFields.some(([field]) => Object.hasOwn(job, field));

  for (const [field, prefix] of detailFields) {
    const message = job[field];
    if (typeof message !== "string" || !message) continue;
    labels.push(`${prefix}: ${message}`);
    seen.add(message);
  }

  if (!hasDetailFields && typeof job.error === "string" && job.error && !seen.has(job.error)) {
    labels.push(job.errorKind === "controller"
      ? `Controller error: ${job.error}`
      : job.error);
  }

  return labels;
}
