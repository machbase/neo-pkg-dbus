import React, { useEffect, useState } from "react";
import { jobsApi } from "../api";
import {
  EmptyState,
  Metric,
  ResultJson,
  StatusBadge,
  counterValue,
  isTransitionalStatus,
  jobErrorLabels,
} from "./CommonView";
import Icon from "./Icon";

const packageName = "neo-pkg-dbus";

function normalizedStatus(job) {
  return String(job && job.status || "").toUpperCase();
}

function isKnownRegistered(job) {
  return job.statusKnown === true && job.registered === true;
}

function isKnownNotInstalled(job) {
  return job.statusKnown === true
    && job.registered === false
    && normalizedStatus(job) === "NOT_INSTALLED";
}

function canEditJob(job) {
  return !job.configError && ((isKnownRegistered(job) && normalizedStatus(job) === "STOPPED")
    || isKnownNotInstalled(job));
}

function canDeleteJob(job) {
  return (isKnownRegistered(job) && ["STOPPED", "FAILED"].includes(normalizedStatus(job)))
    || isKnownNotInstalled(job);
}

function canStartJob(job) {
  return !job.configError && ((isKnownRegistered(job) && ["STOPPED", "FAILED"].includes(normalizedStatus(job)))
    || isKnownNotInstalled(job));
}

function canStopJob(job) {
  return isKnownRegistered(job) && normalizedStatus(job) === "RUNNING";
}

function toggleAction(job) {
  return ["RUNNING", "STARTING", "STOPPING"].includes(normalizedStatus(job)) ? "stop" : "start";
}

function canToggleJob(job) {
  return toggleAction(job) === "stop" ? canStopJob(job) : canStartJob(job);
}

export function resolveSelectedJob(jobs, selectedName, deletedName) {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  if (deletedName && selectedName === deletedName) {
    const deletedIndex = jobs.findIndex((job) => job.name === deletedName);
    if (deletedIndex >= 0) {
      return jobs[deletedIndex + 1]?.name ?? jobs[deletedIndex - 1]?.name ?? null;
    }
  }
  if (selectedName && jobs.some((job) => job.name === selectedName)) return selectedName;
  if (jobs.some((job) => job.name === "example")) return "example";
  return jobs[0].name;
}

export function JobsSide({ state }) {
  const [selectedName, setSelectedName] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const jobs = state.view.snapshot.jobs;

  const selectJob = (name) => {
    setIsCreating(false);
    setSelectedName(name);
    if (state.packageChannel) state.packageChannel.selectJob(name);
  };

  useEffect(() => {
    if (state.view.phase !== "ready-data" || isCreating) return;
    setSelectedName((current) => resolveSelectedJob(jobs, current, null));
  }, [isCreating, jobs, state.view.phase]);

  useEffect(() => {
    const channel = state.packageChannel && state.packageChannel.channel;
    if (!channel || typeof channel.addEventListener !== "function") return undefined;
    const handleMessage = (event) => {
      const message = event.data;
      if (message && message.type === "select-job" && typeof message.name === "string" && message.name.length > 0) {
        setIsCreating(false);
        setSelectedName(message.name);
      }
    };
    channel.addEventListener("message", handleMessage);
    return () => channel.removeEventListener("message", handleMessage);
  }, [state.packageChannel]);

  const showNewJob = () => {
    setIsCreating(true);
    setSelectedName(null);
    if (state.packageChannel) state.packageChannel.newJob();
  };

  const toggleJob = (job) => {
    if (!canToggleJob(job)) return Promise.resolve(false);
    const action = toggleAction(job);
    return state.runAction(
      `${action}:${job.name}`,
      () => action === "stop" ? jobsApi.stop(job.name) : jobsApi.start(job.name),
    );
  };

  return (
    <section className="neo-jobs-side" aria-label="Jobs">
      <div className="neo-jobs-side__header">
        <Icon name="work" className="neo-side-package-icon" />
        <h2 title={packageName}>{packageName}</h2>
        <button
          type="button"
          className="neo-side-header-action"
          aria-label="New Job"
          title="New Job"
          onClick={showNewJob}
        >
          <Icon name="add" />
        </button>
      </div>
      <div className="neo-job-list__header">
        <h3>Jobs</h3>
        <button
          type="button"
          className="neo-side-section-action"
          aria-label="Refresh"
          title="Refresh"
          onClick={() => state.refresh(true)}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div className="neo-job-list">
        {jobs.map((job) => {
          const action = toggleAction(job);
          const selected = selectedName === job.name;
          const hasError = Boolean(job.error || job.configError || job.controllerError || job.resultError || String(job.status).toUpperCase() === "FAILED");
          const statusLabel = hasError ? "ERROR" : job.running ? "RUNNING" : "STOPPED";
          return (
            <div
              className={`neo-job-row${selected ? " neo-job-row--selected" : ""}`}
              data-selected={selected}
              key={job.name}
            >
              <button
                type="button"
                className="neo-job-select"
                aria-pressed={selected}
                onClick={() => selectJob(job.name)}
              >
                <span className="neo-job-name" title={jobErrorLabels(job).join("; ") || statusLabel}>{job.name}</span>
              </button>
              <button
                type="button"
                className="neo-switch"
                aria-label={`${job.name} ${action === "stop" ? "Stop" : "Start"}`}
                title={action === "stop" ? "Stop" : "Start"}
                aria-pressed={["RUNNING", "STARTING", "STOPPING"].includes(normalizedStatus(job))}
                disabled={state.isPending(`${action}:${job.name}`) || !canToggleJob(job)}
                onClick={() => toggleJob(job)}
              >
                <span className="neo-switch__visual">
                  <span className="neo-switch__thumb" />
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function JobForm({ state, job = null, onSaved, onCancel }) {
  const editing = Boolean(job);
  const actionKey = editing ? `update:${job.name}` : "create";
  const [name, setName] = useState(job ? job.name : "");
  const [intervalMs, setIntervalMs] = useState(String(job?.config?.intervalMs ?? 1000));

  const saveJob = async (event) => {
    event.preventDefault();
    const nextName = name.trim();
    const saved = await state.runAction(
      actionKey,
      () => editing
        ? jobsApi.update(nextName, { intervalMs: Number(intervalMs) })
        : jobsApi.create(nextName, { intervalMs: Number(intervalMs) }),
    );
    if (saved) {
      onSaved(nextName);
    }
  };

  return (
    <form className="neo-job-form" onSubmit={saveJob}>
      <header className="neo-page-header">
        <button type="button" className="neo-icon-button" aria-label="Back" title="Back" onClick={onCancel}>
          <Icon name="arrow_back" />
        </button>
        <h2>{editing ? "Edit Job Configuration" : "New Job Configuration"}</h2>
        <div className="neo-page-header__actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="submit"
            className="neo-button-primary"
            aria-label={editing ? "Update Job" : "Create Job"}
            disabled={state.isPending(actionKey)}
          >
            <Icon name={editing ? "edit" : "add"} />
            {editing ? "Update" : "Create"}
          </button>
        </div>
      </header>
      <div className="neo-job-form__body">
        <section className="neo-form-card">
          <h3><Icon name="work" /> Job</h3>
          <div className="neo-form-grid">
            <label>
              <span>Name</span>
              <input
                name="job-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="daily-report"
                disabled={editing}
                required
              />
            </label>
            <label>
              <span>Interval (ms)</span>
              <input
                name="interval-ms"
                type="number"
                min="1000"
                max="60000"
                step="1"
                value={intervalMs}
                onChange={(event) => setIntervalMs(event.target.value)}
                required
              />
            </label>
          </div>
        </section>
      </div>
    </form>
  );
}

function JobDetail({ job, state, onDeleted, onEdit, hasSide }) {
  const errors = jobErrorLabels(job);
  const startKey = `start:${job.name}`;
  const stopKey = `stop:${job.name}`;
  const editKey = `update:${job.name}`;
  const deleteKey = `delete:${job.name}`;
  const transitioning = isTransitionalStatus(job.status);
  const canStart = canStartJob(job);
  const canStop = canStopJob(job);

  return (
    <section className="neo-job-detail" aria-label={`${job.name} details`}>
      <div className="neo-job-detail__header">
        <h2 className="neo-job-detail__title">{job.name}</h2>
        <StatusBadge status={job.status} running={job.running} />
      </div>
      <div className="neo-job-detail__metrics">
        <section className="neo-summary-card">
          <h3><Icon name="work" /> Job</h3>
          <Metric label="intervalMs" value={job.config && job.config.intervalMs} mono />
          <Metric label="service" value={job.service} mono />
        </section>
        <section className="neo-summary-card neo-summary-card--count">
          <h3><Icon name="counter_1" /> Count</h3>
          <Metric label="count" value={counterValue(job.result)} />
        </section>
        <section className="neo-summary-card">
          <h3><Icon name="schedule" /> Last update</h3>
          <Metric label="updatedAt" value={job.result && job.result.updatedAt} mono />
        </section>
      </div>
      {errors.length > 0 ? <ul className="neo-job-errors">{errors.map((error) => <li key={error}>{error}</li>)}</ul> : null}
      {job.result ? (
        <section className="neo-result-card">
          <h3><Icon name="data_object" /> Result</h3>
          <ResultJson result={job.result} />
        </section>
      ) : null}
      <div className="neo-job-actions">
        {!hasSide ? (
          <>
            <button
              type="button"
              aria-label={`${job.name} Start`}
              title="Start"
              disabled={state.isPending(startKey) || !canStart || transitioning}
              onClick={() => state.runAction(startKey, () => jobsApi.start(job.name))}
            >
              <Icon name="play_arrow" />
              Start
            </button>
            <button
              type="button"
              aria-label={`${job.name} Stop`}
              title="Stop"
              disabled={state.isPending(stopKey) || !canStop || transitioning}
              onClick={() => state.runAction(stopKey, () => jobsApi.stop(job.name))}
            >
              <Icon name="stop" />
              Stop
            </button>
          </>
        ) : null}
        <button
          type="button"
          aria-label={`${job.name} Edit`}
          title="Edit"
          disabled={state.isPending(editKey) || !canEditJob(job)}
          onClick={() => onEdit(job)}
        >
          <Icon name="edit" />
          Edit
        </button>
        <button
          type="button"
          className="starter-button--danger"
          aria-label={`${job.name} Delete`}
          title="Delete"
          disabled={state.isPending(deleteKey) || !canDeleteJob(job)}
          onClick={() => onDeleted(job)}
        >
          <Icon name="delete" />
          Delete
        </button>
      </div>
    </section>
  );
}

export function JobsMain({ state, hasSide }) {
  const [selectedName, setSelectedName] = useState(null);
  const [mode, setMode] = useState("detail");
  const jobs = state.view.snapshot.jobs;
  const resolvedName = resolveSelectedJob(jobs, selectedName, null);
  const selectedJob = jobs.find((job) => job.name === resolvedName) || null;
  const visibleMode = mode === "new"
    ? "new"
    : mode === "edit" && selectedJob
      ? "edit"
      : selectedJob
        ? "detail"
        : "empty";

  useEffect(() => {
    if (state.view.phase !== "ready-data" || jobs.length === 0) return;
    setSelectedName((current) => {
      if (current && jobs.some((job) => job.name === current)) return current;
      return resolveSelectedJob(jobs, current, null);
    });
  }, [jobs, state.view.phase]);

  useEffect(() => {
    const channel = state.packageChannel && state.packageChannel.channel;
    if (!channel || typeof channel.addEventListener !== "function") return undefined;
    const handleMessage = (event) => {
      const message = event.data;
      if (message && message.type === "select-job" && typeof message.name === "string" && message.name.length > 0) {
        setSelectedName(message.name);
        setMode("detail");
      } else if (message && message.type === "new-job") {
        setMode("new");
      }
    };
    channel.addEventListener("message", handleMessage);
    return () => channel.removeEventListener("message", handleMessage);
  }, [state.packageChannel]);

  const showSavedJob = (name) => {
    setSelectedName(name);
    setMode("detail");
    if (state.packageChannel) state.packageChannel.selectJob(name);
  };

  const cancelNewJob = () => {
    setMode(selectedJob ? "detail" : "empty");
    if (selectedJob && state.packageChannel) state.packageChannel.selectJob(selectedJob.name);
  };

  const deleteJob = async (job) => {
    const nextName = resolveSelectedJob(jobs, job.name, job.name);
    const deleted = await state.runAction(
      `delete:${job.name}`,
      () => jobsApi.remove(job.name),
    );
    if (deleted) {
      setSelectedName(nextName);
      setMode(nextName ? "detail" : "empty");
      if (nextName && state.packageChannel) state.packageChannel.selectJob(nextName);
    }
  };

  const restoreExample = async () => {
    const created = await state.runAction(
      "create:example",
      () => jobsApi.create("example", { intervalMs: 1000 }),
    );
    if (created) {
      setSelectedName("example");
      setMode("detail");
    }
  };

  if (visibleMode === "new") {
    return <JobForm state={state} onSaved={showSavedJob} onCancel={cancelNewJob} />;
  }

  if (visibleMode === "edit") {
    return <JobForm state={state} job={selectedJob} onSaved={showSavedJob} onCancel={cancelNewJob} />;
  }

  if (visibleMode === "detail") {
    return (
      <JobDetail
        job={selectedJob}
        state={state}
        hasSide={hasSide}
        onEdit={() => setMode("edit")}
        onDeleted={deleteJob}
      />
    );
  }

  if (state.view.phase !== "ready-empty") return null;

  if (hasSide) {
    return (
      <EmptyState
        title="No job selected"
        description="Select a job from the side panel or create a new one."
      />
    );
  }

  return (
    <EmptyState
      title="No example job"
      description="Choose side=yes when the package needs to manage multiple jobs."
      action={(
        <button type="button" onClick={restoreExample} disabled={state.isPending("create:example")}>
          Restore example
        </button>
      )}
    />
  );
}
