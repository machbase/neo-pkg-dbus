import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { api } from "./api";
import { createPackageChannel } from "./package-channel";
import { buildJobTree, chartEvidenceKey, createDefaultJobConfig, createMethodCall, displayGridRow, hasCompleteNumericEvidence, hydrateJobConfig, jobActions, jobNeedsStringValueColumn, nextDefaultJobName, parseSuccessValue, reorder, serializeJobConfig, validateJobTags } from "./model";
import { appendProductMethodCall, createInitialMethodCalls, deviceStringBuilder as productDeviceStringBuilder, displayInputValue as productDisplayInputValue, inputLabel as productInputLabel, inputPrefix as productInputPrefix, minimumIntervalMs, reconcileProductTags as reconcileGeneratedTags, retryConfigurable as productRetryConfigurable, resolveJobFormMode as jobFormMode, showsInterfaceManagement, storeInputValue as productStoreInputValue, tagCsvImporter as productTagCsvImporter } from "@product";
import Icon from "./components/Icon";
import DataViewerPage from "./data-viewer/DataViewerPage";
import LiveLogs from "./live-logs/LiveLogs";

const CHANNEL_NAME = "app:neo-pkg-dbus";
const TRANSFORM_DRAG_TYPE = "application/x-neo-transform-index";
const LS_CALL_DRAG_TYPE = "application/x-neo-ls-method-call-index";
const AppContext = createContext(null);

const DEFAULT_CONFIG = createDefaultJobConfig(null, "");

function messageOf(error) {
  const code = String(error?.code || "").trim();
  const messages = {
    DB_SERVER_NOT_FOUND: "Database server was not found.",
    DB_SERVER_INVALID: "Database server settings are invalid.",
    DB_UNAVAILABLE: "Database connection is unavailable.",
    TABLE_NOT_FOUND: "Table was not found.",
    TABLE_INVALID: "Table settings are invalid.",
    TABLE_ALREADY_EXISTS: "The table already exists.",
    JOB_NOT_FOUND: "Job was not found.",
    JOB_INVALID: "Job settings are invalid.",
    JOB_RUNNING: "Stop the job before changing it.",
  };
  if (code) return messages[code] || `Request failed (${code}).`;
  const message = error?.message || error?.reason;
  if (message && !/[가-힣]/.test(message)) return message;
  return "Request could not be completed.";
}

function isTransientRequestError(error) {
  // Job detail remains usable when the optional last-run request has a
  // temporary transport/server failure. Surface those failures as a toast,
  // but never let an error classifier itself break the detail render.
  if (!error) return false;
  const code = String(error.code || "");
  return code === "NETWORK_ERROR" || code === "INVALID_RESPONSE" || Number(error.status) >= 500;
}

function logSizeLabel(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 1024) return "—";
  return `${Math.round(value / (1024 * 1024) * 10) / 10} MiB`;
}

function useLoad(loader, dependencies = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const activeRequest = useRef(null);
  const generation = useRef(0);
  const reload = useCallback(({ signal: externalSignal, clearData = false } = {}) => {
    if (activeRequest.current) {
      activeRequest.current.controller.abort();
      activeRequest.current = null;
    }
    if (externalSignal?.aborted) return Promise.resolve({ status: "aborted" });
    const requestGeneration = generation.current + 1;
    generation.current = requestGeneration;
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    setState((current) => clearData ? { loading: true, data: null, error: null } : { ...current, loading: true, error: null });
    const aborted = () => {
      if (generation.current === requestGeneration) {
        if (activeRequest.current?.controller === controller) activeRequest.current = null;
        setState((current) => ({ ...current, loading: false }));
      }
      return { status: "aborted" };
    };
    const request = Promise.resolve(loader(controller.signal)).then(
      (data) => {
        if (controller.signal.aborted) return aborted();
        if (generation.current !== requestGeneration) return { status: "aborted" };
        activeRequest.current = null;
        setState({ loading: false, data, error: null });
        return { status: "success", data };
      },
      (error) => {
        if (controller.signal.aborted || error?.name === "AbortError") return aborted();
        if (generation.current !== requestGeneration) return { status: "aborted" };
        activeRequest.current = null;
        setState({ loading: false, data: null, error });
        return { status: "error", error };
      },
    ).finally(() => externalSignal?.removeEventListener("abort", abort));
    activeRequest.current = { controller, generation: requestGeneration };
    return request;
  }, dependencies);
  useEffect(() => {
    void reload({ clearData: true });
    return () => {
      generation.current += 1;
      if (activeRequest.current) activeRequest.current.controller.abort();
      activeRequest.current = null;
    };
  }, [reload]);
  return { ...state, reload };
}

function useRouteMutation(name) {
  const active = useRef(null);
  const currentName = useRef(name);
  currentName.current = name;
  useEffect(() => () => {
    active.current?.controller.abort();
    active.current = null;
  }, [name]);
  return useCallback(() => {
    active.current?.controller.abort();
    const controller = new AbortController();
    const request = { name, controller };
    active.current = request;
    return {
      signal: controller.signal,
      isCurrent: () => active.current === request && currentName.current === name && !controller.signal.aborted,
      finish: () => { if (active.current === request) active.current = null; },
    };
  }, [name]);
}

function useLatestRequest() {
  const active = useRef(null);
  const cancel = useCallback(() => {
    active.current?.controller.abort();
    active.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const begin = useCallback(() => {
    cancel();
    const controller = new AbortController();
    const request = { controller };
    active.current = request;
    return {
      signal: controller.signal,
      isCurrent: () => active.current === request && !controller.signal.aborted,
      finish: () => { if (active.current === request) active.current = null; },
      abort: () => {
        controller.abort();
        if (active.current === request) active.current = null;
      },
    };
  }, [cancel]);
  return { begin, cancel };
}

function abortError() { return Object.assign(new Error("Request aborted."), { name: "AbortError" }); }

function routeJobName(pathname) {
  const route = String(pathname || "");
  if (route === "/jobs/new") return "";
  const match = route.match(/^\/(?:jobs\/([^/]+)(?:\/edit)?|data\/([^/]+)|logs\/([^/]+))$/);
  const encoded = match?.[1] || match?.[2] || match?.[3] || "";
  if (!encoded) return "";
  try { return decodeURIComponent(encoded); } catch (_) { return ""; }
}

function useSerialApiQueue() {
  const tail = useRef(Promise.resolve());
  const active = useRef(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const cancel = useCallback(() => {
    generation.current += 1;
    active.current?.abort();
    active.current = null;
  }, []);
  const run = useCallback((operation, { signal: externalSignal } = {}) => {
    const queuedGeneration = generation.current;
    const next = tail.current.catch(() => null).then(async () => {
      if (!mounted.current || queuedGeneration !== generation.current || externalSignal?.aborted) throw abortError();
      const controller = new AbortController();
      const abort = () => controller.abort();
      externalSignal?.addEventListener("abort", abort, { once: true });
      active.current = controller;
      try {
        const value = await operation(controller.signal);
        if (!mounted.current || queuedGeneration !== generation.current || controller.signal.aborted) throw abortError();
        return value;
      } finally {
        externalSignal?.removeEventListener("abort", abort);
        if (active.current === controller) active.current = null;
      }
    });
    tail.current = next.catch(() => null);
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  return { run, cancel };
}

export function AppProvider({ children, surface }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [jobs, setJobs] = useState([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState(null);
  const [createModal, setCreateModal] = useState("");
  const [resourceRevision, setResourceRevision] = useState(0);
  const [jobRevision, setJobRevision] = useState(0);
  const channelRef = useRef(null);
  const selectedRef = useRef("");
  const locationPathRef = useRef(location.pathname);
  const navigateRef = useRef(navigate);
  const refreshGeneration = useRef(0);
  const toastSequence = useRef(0);

  // `refresh` is also captured by the package-channel effect below. Keep the
  // current route in a ref so changing from Job detail to Job edit does not
  // recreate that channel. Recreating it emits a second `ready` message; the
  // side document then replays its selected Job and used to navigate the main
  // document back from `/edit` to the monitoring route, aborting form loads.
  locationPathRef.current = location.pathname;
  navigateRef.current = navigate;

  const notify = useCallback((error, kind = "error") => {
    const message = typeof error === "string" ? error : messageOf(error);
    const id = toastSequence.current + 1;
    toastSequence.current = id;
    setToasts((current) => [...current.slice(-2), { id, kind, message }]);
  }, []);
  const dismissToast = useCallback((id) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const refresh = useCallback(async ({ signal } = {}) => {
    if (signal?.aborted) return false;
    const requestGeneration = refreshGeneration.current + 1;
    refreshGeneration.current = requestGeneration;
    setLoading(true);
    try {
      const values = await api.jobs.list({ signal });
      if (signal?.aborted || refreshGeneration.current !== requestGeneration) return false;
      const listedJobs = Array.isArray(values) ? values : [];
      const initialName = listedJobs[0]?.name || "";
      setJobs(listedJobs);
      setSelected((current) => listedJobs.some((job) => job.name === current) ? current : initialName);
      // The side and main documents have independent providers. When the
      // package opens at its root, make the main document follow the same
      // initial Job that the side document highlights.
      if (surface !== "side" && locationPathRef.current === "/" && initialName) navigateRef.current(`/jobs/${encodeURIComponent(initialName)}`, { replace: true });
      setJobRevision((value) => value + 1);
      setError(null);
      return true;
    } catch (failure) {
      if (signal?.aborted || refreshGeneration.current !== requestGeneration || failure?.name === "AbortError") return false;
      setError(null);
      notify(failure);
      return false;
    } finally {
      if (refreshGeneration.current === requestGeneration) setLoading(false);
    }
  }, [notify, surface]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    api.settings.get({ signal: controller.signal }).then(
      (value) => { setSettings(value); setSettingsError(null); },
      (failure) => { if (failure?.name !== "AbortError") setSettingsError(failure); },
    ).finally(() => { if (!controller.signal.aborted) setSettingsLoading(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const channel = createPackageChannel({ enabled: true, name: CHANNEL_NAME, onMessage(message) {
      if (message.type === "ready") {
        // The Neo shell can recreate only side.html while preserving main.html.
        // In that case main's current route is authoritative: send its Job back
        // to the newly created side so a form/detail never loses its context.
        if (surface !== "side" && message.surface === "side") {
          const currentJob = routeJobName(locationPathRef.current);
          if (currentJob) {
            setSelected(currentJob);
            channelRef.current?.selectJob(currentJob, { sync: true });
          }
        }
        // A newly created main document still needs the side's existing Job
        // selection to open the initial detail route.
        if (surface === "side" && message.surface !== "side" && selectedRef.current) {
          channelRef.current?.selectJob(selectedRef.current, { sync: true });
        }
      }
      if (message.type === "refresh") void refresh();
      if (message.type === "select-job") {
        const currentJob = surface !== "side" ? routeJobName(locationPathRef.current) : "";
        // Initial side synchronization must not overwrite an already-open
        // main detail/form. A real user click has no sync flag and still owns
        // navigation as before.
        if (!(message.sync && currentJob)) setSelected(message.name);
        // An automatic side/main synchronization must only choose the initial
        // root-page detail. A real side click has no `sync` flag and is still
        // allowed to leave an edit/new route deliberately.
        if (surface !== "side" && (!message.sync || locationPathRef.current === "/")) navigateRef.current(`/jobs/${encodeURIComponent(message.name)}`);
      }
      if (message.type === "new-job" && surface !== "side") navigateRef.current("/jobs/new");
      if (message.type === "navigate" && surface !== "side") navigateRef.current(message.path);
      if (message.type === "open-create-modal" && surface !== "side") setCreateModal(message.target);
    } });
    channelRef.current = channel;
    channel.ready(surface);
    return () => { channel.close(); channelRef.current = null; };
  }, [refresh, surface]);

  // The initial list is loaded independently by side.html and main.html.
  // Publish the side's selection when it becomes available, rather than
  // relying only on a user click that might precede main's channel setup.
  useEffect(() => {
    if (surface === "side" && selected) channelRef.current?.selectJob(selected, { sync: true });
  }, [selected, surface]);

  const selectJob = useCallback((name) => {
    setSelected(name);
    if (surface !== "side") navigateRef.current(`/jobs/${encodeURIComponent(name)}`);
    channelRef.current?.selectJob(name);
  }, [surface]);
  const newJob = useCallback(() => { if (surface !== "side") navigateRef.current("/jobs/new"); channelRef.current?.newJob(); }, [surface]);
  const go = useCallback((path) => { if (surface !== "side") navigateRef.current(path); channelRef.current?.navigate(path); }, [surface]);
  const openCreateModal = useCallback((target) => { if (surface !== "side") setCreateModal(target); channelRef.current?.openCreateModal(target); }, [surface]);
  const closeCreateModal = useCallback(() => setCreateModal(""), []);
  const resourceChanged = useCallback(() => setResourceRevision((value) => value + 1), []);
  const run = useCallback(async (operation, { signal, isCurrent = () => true, onError, jobName = "", removeJob = false } = {}) => {
    if (signal?.aborted || !isCurrent()) return false;
    setError(null);
    try {
      const result = await operation();
      if (signal?.aborted || !isCurrent()) return false;
      channelRef.current?.refresh();
      if (jobName) {
        setJobs((current) => removeJob
          ? current.filter((job) => job.name !== jobName)
          : current.map((job) => job.name === jobName ? { ...job, ...result } : job));
        setJobRevision((value) => value + 1);
      } else await refresh({ signal });
      return !signal?.aborted && isCurrent();
    } catch (failure) {
      if (!signal?.aborted && isCurrent() && failure?.name !== "AbortError") {
        if (onError) onError(failure); else notify(failure);
      }
      return false;
    }
  }, [notify, refresh]);

  const provider = settingsLoading || settingsError || !settings ? undefined : settings.provider;
  return <AppContext.Provider value={{ jobs, selected, loading, error, toasts, settings, settingsLoading, settingsError, provider, createModal, resourceRevision, jobRevision, refresh, selectJob, newJob, go, openCreateModal, closeCreateModal, resourceChanged, notify, dismissToast, run }}>{children}</AppContext.Provider>;
}

function useApp() {
  return useContext(AppContext) || { jobs: [], selected: "", loading: false, error: null, toasts: [], settings: null, settingsLoading: false, settingsError: null, provider: null, createModal: "", resourceRevision: 0, jobRevision: 0, refresh() {}, selectJob() {}, newJob() {}, go() {}, openCreateModal() {}, closeCreateModal() {}, resourceChanged() {}, notify() {}, dismissToast() {}, run: async () => false };
}

function StatusText({ job }) {
  const state = job?.controllerState || "UNKNOWN";
  const key = state.toLowerCase().replaceAll("_", "-");
  return <span className={`neo-status neo-status--${key}`}>{state.replaceAll("_", " ")}</span>;
}

function IconButton({ icon, label, className = "", ...props }) {
  return <button className={`neo-icon-button ${className}`.trim()} type="button" aria-label={label} title={label} {...props}><Icon name={icon} /></button>;
}

function Modal({ title, ariaLabel = title, icon, variant = "", onClose, children, escapeDisabled = false }) {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape" && !escapeDisabled) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, escapeDisabled]);
  return <div className="neo-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`neo-modal__dialog${variant ? ` neo-modal__dialog--${variant}` : ""}`} role="dialog" aria-modal="true" aria-label={ariaLabel}><header className="neo-modal__header"><div className="neo-modal__title">{icon ? <Icon name={icon} /> : null}<h2>{title}</h2></div><IconButton className="neo-modal__close" icon="close" label="Close" onClick={onClose} /></header><div className="neo-modal__body">{children}</div></section></div>;
}

export function JobSide({ jobs, selected, loading = false, error = null, settingsLoading = false, settingsError = null, provider = null, onSelect, onNew, onOpenModal = () => {}, onRefresh, onToggle }) {
  const settingsBlocked = settingsLoading || Boolean(settingsError);
  const showDbusInterfaceManagement = showsInterfaceManagement(provider);
  return <aside className="neo-side" aria-label="DBus Collector jobs">
    <header className="neo-side__header"><span className="neo-package-mark"><Icon name="memory" /></span><strong title="neo-pkg-dbus">neo-pkg-dbus</strong><span className="neo-side__header-actions"><IconButton icon="add" label="New Job" onClick={onNew} /><IconButton icon="dns" label="New Database Server" onClick={() => onOpenModal("db-server")} />{showDbusInterfaceManagement && (!settingsBlocked && provider?.jobMode !== "fixed" ? <IconButton icon="account_tree" label="New DBus Interface" onClick={() => onOpenModal("dbus-interface")} /> : null)}</span></header>
    <div className="neo-side__section"><span>JOBS</span><span className="neo-side__tools"><IconButton icon="refresh" label="Refresh" onClick={onRefresh} /></span></div>
    {loading && jobs.length === 0 ? <p className="neo-message" aria-live="polite">Loading jobs…</p> : null}
    <Notice error={error || settingsError} />
    <div className="neo-job-list">
      {jobs.map((job) => {
        const actions = jobActions(job);
        const running = job.executionState === "running";
        return <div className={`neo-job-row${selected === job.name ? " is-selected" : ""}`} key={job.name}>
          <button className="neo-job-row__select" type="button" aria-pressed={selected === job.name} onClick={() => onSelect(job.name)} title={`${job.name} · ${job.controllerState || "UNKNOWN"}`}>
            <span>{job.name}</span>
          </button>
          {actions.switchVisible ? <button className={`neo-switch${running ? " is-on" : ""}`} type="button" aria-label={`${job.name} ${running ? "Stop" : "Start"}`} title={`${running ? "Stop" : "Start"} ${job.name}`} aria-pressed={running} disabled={actions.switchDisabled} onClick={() => onToggle(job, running ? "stop" : "start")}><span /></button>
            : <span className="neo-install-required" aria-label={`${job.name} Install required`} title="Install required"><Icon name="download" /></span>}
        </div>;
      })}
      {!loading && jobs.length === 0 ? <p className="neo-side__empty">No jobs</p> : null}
    </div>
  </aside>;
}

export function ConnectedSide() {
  const app = useApp();
  const location = useLocation();
  const beginMutation = useRouteMutation(location.pathname);
  const toggle = async (job, action) => {
    const mutation = beginMutation();
    try {
      await app.run(() => api.jobs[action](job.name, { signal: mutation.signal }), { signal: mutation.signal, isCurrent: mutation.isCurrent, jobName: job.name });
    } finally {
      mutation.finish();
    }
  };
  return <JobSide {...app} onSelect={app.selectJob} onNew={app.newJob} onOpenModal={app.openCreateModal} onRefresh={app.refresh} onToggle={toggle} />;
}

function MainHeader({ title, subtitle, onBack, children }) {
  return <header className="neo-main-header"><div className="neo-main-header__title">{onBack ? <IconButton className="neo-back-button" icon="arrow_back" label="Back" onClick={onBack} /> : null}<div><h1 title={title}>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div></div><div className="neo-actions">{children}</div></header>;
}

function Notice({ error, status, children }) {
  const { notify } = useApp();
  useEffect(() => {
    if (error) notify(error);
  }, [error, notify]);
  if (error || !children) return null;
  return <p className="neo-message" role={status ? "status" : undefined}>{children}</p>;
}

function ToastLayer() {
  const { toasts, dismissToast } = useApp();
  useEffect(() => {
    const timers = toasts.map((toast) => window.setTimeout(() => dismissToast(toast.id), 5000));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [dismissToast, toasts]);
  if (toasts.length === 0) return null;
  return <div className="neo-toast-stack" aria-live="assertive" aria-label="Notifications">
    {toasts.map((toast) => <div className={`neo-toast neo-toast--${toast.kind}`} key={toast.id} role="alert"><span>{toast.message}</span><IconButton icon="close" label="Dismiss notification" onClick={() => dismissToast(toast.id)} /></div>)}
  </div>;
}

function Home() {
  const { jobs } = useApp();
  const noJobs = jobs.length === 0;
  return <main className="neo-main neo-main--home" aria-label="DBus Collector main"><section className="neo-home-empty"><Icon name="inbox" /><p>{noJobs ? "No jobs yet" : "Select a job from the sidebar"}</p>{noJobs ? <p>Click "New" to get started</p> : null}</section></main>;
}

function JobDetail() {
  const { name = "" } = useParams();
  const app = useApp();
  const beginMutation = useRouteMutation(name);
  const [liveLogsOpen, setLiveLogsOpen] = useState(false);
  const [logLevel, setLogLevel] = useState("");
  const [logSaving, setLogSaving] = useState(false);
  const [overrunClearing, setOverrunClearing] = useState(false);
  const lastJobRevision = useRef(app.jobRevision);
  const loaded = useLoad(async (signal) => {
    const [jobResult, lastRunResult] = await Promise.allSettled([
      api.jobs.get(name, { signal }), api.jobs.lastRun(name, { signal }),
    ]);
    if (jobResult.status === "rejected") throw jobResult.reason;
    if (lastRunResult.status === "rejected" && lastRunResult.reason?.name === "AbortError") throw lastRunResult.reason;
    return {
      job: jobResult.value,
      lastRun: lastRunResult.status === "fulfilled" ? lastRunResult.value?.lastRun ?? null : null,
      lastRunError: lastRunResult.status === "rejected" ? lastRunResult.reason : null,
    };
  }, [name]);
  useEffect(() => {
    if (isTransientRequestError(loaded.error)) app.notify(loaded.error);
  }, [app.notify, loaded.error]);
  useEffect(() => {
    if (lastJobRevision.current === app.jobRevision) return;
    lastJobRevision.current = app.jobRevision;
    void loaded.reload();
  }, [app.jobRevision, loaded.reload]);
  const job = loaded.data?.job;
  const lastRun = loaded.data?.lastRun ?? null;
  const lastRunError = loaded.data?.lastRunError ?? null;
  const hasSkippedCycles = Number(lastRun?.overrunCount || 0) > 0;
  useEffect(() => {
    if (!job?.running) return undefined;
    const timer = setInterval(() => { void loaded.reload(); }, 5000);
    return () => clearInterval(timer);
  }, [job?.running, loaded.reload]);
  const actions = jobActions(job);
  const config = job?.config || {};
  const loggingPolicy = app.settings?.logging || {};
  const invalid = job?.error?.code === "JOB_INVALID_CONFIG";
  const logHotApplyAvailable = minimumIntervalMs === 1;
  useEffect(() => {
    setLogLevel(String(config.log?.level || "info").toLowerCase());
  }, [job?.revision, name]);
  const mutate = async (action) => {
    if (action === "remove" && !window.confirm(`Delete ${name}?`)) return;
    const mutation = beginMutation();
    try {
      const ok = await app.run(
        () => action === "remove" ? api.jobs.remove(name, { signal: mutation.signal }) : api.jobs[action](name, { signal: mutation.signal }),
        { signal: mutation.signal, isCurrent: mutation.isCurrent, jobName: name, removeJob: action === "remove" },
      );
      if (!mutation.isCurrent() || !ok) return;
      if (action === "remove") app.go("/");
    } finally {
      mutation.finish();
    }
  };
  const saveLogLevel = async () => {
    if (!job || !logHotApplyAvailable || logSaving || logLevel === String(config.log?.level || "info").toLowerCase()) return;
    const mutation = beginMutation();
    setLogSaving(true);
    try {
      await app.run(
        () => api.jobs.updateLogLevel(name, { revision: job.revision, level: logLevel }, { signal: mutation.signal }),
        { signal: mutation.signal, isCurrent: mutation.isCurrent, jobName: name },
      );
    } finally {
      if (mutation.isCurrent()) setLogSaving(false);
      mutation.finish();
    }
  };
  const clearOverrun = async () => {
    if (!job || !hasSkippedCycles || overrunClearing) return;
    const mutation = beginMutation();
    setOverrunClearing(true);
    try {
      await app.run(
        () => api.jobs.clearOverrun(name, { signal: mutation.signal }),
        { signal: mutation.signal, isCurrent: mutation.isCurrent, jobName: name },
      );
    } finally {
      if (mutation.isCurrent()) setOverrunClearing(false);
      mutation.finish();
    }
  };
  return <main className="neo-main" aria-label="DBus Collector main">
    <MainHeader title={name || "Job"} subtitle={job ? `${new Set((config.methodCalls || []).map((call) => call.interfaceId).filter(Boolean)).size} DBus Interface · ${config.methodCalls?.length || 0} Method Call` : "Job detail"}>
      <button className="neo-button" type="button" onClick={() => setLiveLogsOpen(true)}><Icon name="terminal" />Live Logs</button>
      <Link className="neo-button neo-button--primary-outline" to={`/data/${encodeURIComponent(name)}`}><Icon name="query_stats" />Data Viewer</Link>
      <Link className={`neo-button${!actions.edit ? " is-disabled" : ""}`} aria-disabled={!actions.edit} tabIndex={actions.edit ? 0 : -1} to={actions.edit ? `/jobs/${encodeURIComponent(name)}/edit` : "#"}><Icon name="edit" />Edit</Link>
      <button className="neo-button neo-button--danger" aria-label={`${name} Delete`} disabled={!actions.remove} onClick={() => mutate("remove")}><Icon name="delete" />Delete</button>
    </MainHeader>
    {loaded.loading && !job ? <p className="neo-message" aria-live="polite">Loading Job…</p> : null}<Notice error={loaded.error} />
    {invalid ? <Notice status>{job.controllerDetail || "Stored Job name does not match its file. All changes are blocked."}</Notice> : null}
    {job ? <div className="neo-page-body">
      <section className="neo-job-overview" aria-label="Job overview">
        <OverviewCard label="JOB" icon="memory">
          <OverviewValue label="STATUS" value={<StatusText job={job} />} />
          <div className="neo-overview-card__row"><OverviewValue label="INTERVAL" value={`${config.schedule?.intervalMs ?? "—"} ms`} /><OverviewValue label="SAVE POLICY" value={config.execution?.savePolicy || "—"} /></div>
        </OverviewCard>
        <OverviewCard label="METHOD CALLS" centered>
          <strong className="neo-overview-card__count">{config.methodCalls?.length ?? job.methodCallCount ?? 0}</strong>
          <span className="neo-overview-card__count-label">CALLS CONFIGURED</span>
          {hasSkippedCycles ? <div className="neo-overview-card__overrun"><span>SKIPPED {lastRun.overrunCount}{Number(lastRun.queueSkipped || 0) > 0 ? ` (QUEUE FULL: ${lastRun.queueSkipped})` : ""} · {lastRun.lastOverrunAt || "—"}</span><IconButton icon="delete_sweep" label="Clear skipped cycle monitoring" disabled={overrunClearing} onClick={clearOverrun} /></div> : null}
        </OverviewCard>
        <OverviewCard label="DATABASE" icon="database">
          <OverviewValue label="SERVER" value={config.database?.server || "—"} />
          <div className="neo-overview-card__row"><OverviewValue label="TABLE" value={config.database?.table || "—"} /><OverviewValue label="VALUE COLUMN" value={config.database?.valueColumn || "—"} /><OverviewValue label="STRING COLUMN" value={config.database?.stringValueColumn || "—"} /></div>
        </OverviewCard>
      </section>
      <section className="neo-panel"><h2>LATEST RUN</h2><Notice error={lastRunError} />{lastRun ? <><div className="neo-summary-grid neo-summary-grid--compact"><Metric label="LATEST STATUS" value={lastRun.status} /><Metric label="LAST SUCCESSFUL" value={lastRun.lastSuccessfulRunAt || "—"} /><Metric label="LAST STORED" value={lastRun.lastStoredAt || "—"} /></div><table><thead><tr><th>Method</th><th>Status</th><th>Rows saved</th><th>Error</th></tr></thead><tbody>{(lastRun.methodCalls || lastRun.methods || []).map((method) => <tr key={method.id}><td>{method.name}</td><td>{method.status}</td><td>{method.storedCount}</td><td>{method.error || "—"}</td></tr>)}</tbody></table></> : <p>No run result yet</p>}</section>
      <section className="neo-panel neo-logging-controls">
        <div className="neo-logging-controls__title"><Icon name="terminal" /><h2>LOGS</h2></div>
        <div className="neo-logging-controls__item neo-logging-controls__item--level"><span>LOG LEVEL</span>{logHotApplyAvailable ? <><select aria-label="Log level" value={logLevel} disabled={logSaving} onChange={(event) => setLogLevel(event.target.value)}>{["trace", "debug", "info", "warn", "error"].map((level) => <option key={level} value={level}>{level.toUpperCase()}</option>)}</select><button className="neo-button neo-button--primary" type="button" disabled={logSaving || logLevel === String(config.log?.level || "info").toLowerCase()} onClick={saveLogLevel}>{logSaving ? "Applying…" : "Apply"}</button></> : <strong className="neo-logging-controls__badge">{String(config.log?.level || "info").toUpperCase()}</strong>}</div>
        <div className="neo-logging-controls__item neo-logging-controls__item--rotation"><span>ROTATION</span><strong>{`${logSizeLabel(loggingPolicy.maxFileBytes)} × ${loggingPolicy.maxFiles ?? config.log?.maxFiles ?? 3}`}</strong></div>
        <Link className="neo-button neo-button--primary-outline" to={`/logs/${encodeURIComponent(name)}`}><Icon name="description" />View Logs</Link>
      </section>
    </div> : null}
    <LiveLogs jobName={name} open={liveLogsOpen} onClose={() => setLiveLogsOpen(false)} />
  </main>;
}

function Metric({ label, value, warning = false }) {
  return <div className={`neo-metric${warning ? " neo-metric--warning" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function OverviewCard({ label, icon, centered = false, children }) {
  return <article className={`neo-overview-card${centered ? " neo-overview-card--centered" : ""}`}><header><h2>{label}</h2>{icon ? <Icon name={icon} /> : null}</header>{children}</article>;
}

function OverviewValue({ label, value }) {
  return <div className="neo-overview-value"><span>{label}</span><strong>{value}</strong></div>;
}

function Field({ label, children, wide = false, className = "", action = null }) { return <div className={`neo-field${wide ? " neo-field--wide" : ""} ${className}`.trim()}><span className="neo-field__label">{label}</span>{action ? <span className="neo-field__action">{action}</span> : null}{children}</div>; }
function Input({ value, onChange, ...props }) { return <input {...props} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />; }

function ColumnSelect({ value, groups, disabled, onChange }) {
  const selectedValue = String(value || "");
  const hasSelectedColumn = groups.some((group) => group.columns.some((column) => column.name === selectedValue));
  return <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="" disabled>{disabled ? "Select a table first" : "Select a column..."}</option>
    {selectedValue && !hasSelectedColumn ? <option value={selectedValue}>{selectedValue}</option> : null}
    {groups.map((group) => group.columns.length ? <optgroup label={group.label} key={group.label}>
      {group.columns.map((column) => <option value={column.name} key={column.name}>{column.name} ({column.type})</option>)}
    </optgroup> : null)}
  </select>;
}

function outputChoices(type, path = "", label = "Value") {
  const current = [{ path, label, type }];
  if (type?.type === "struct") return current.concat((type.fields || []).flatMap((field, index) => outputChoices(field, `${path}/${index}`, `Field ${index + 1}`)));
  return current;
}

function jsonOutputChoices(value, path = "", label = "Value") {
  const type = Array.isArray(value) ? { type: "array", element: "variant" } : value !== null && typeof value === "object" ? { type: "dict-entry", key: "string", value: "variant" } : typeof value === "number" ? "double" : typeof value === "boolean" ? "boolean" : "string";
  const current = [{ path, label, type }];
  if (Array.isArray(value)) return current.concat(value.flatMap((item, index) => jsonOutputChoices(item, `${path}/${index}`, `Item ${index + 1}`)));
  if (value !== null && typeof value === "object") return current.concat(Object.entries(value).flatMap(([key, item]) => jsonOutputChoices(item, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, key)));
  return current;
}

function tagRows(methodId, prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index + 1}`, bias: 0, multiplier: 1, transformOrder: ["bias", "multiplier"] }));
}

function valueTypeForOutput(type) {
  if (type?.type === "array") return "array";
  if (["byte", "uint16", "uint32", "uint64", "int16", "int32", "int64", "double"].includes(type)) return "numeric";
  if (["string", "object-path", "signature"].includes(type)) return "string";
  return "json";
}

function isNativeScalarOutput(type) {
  return ["byte", "uint16", "uint32", "uint64", "int16", "int32", "int64", "double", "boolean", "string", "object-path", "signature"].includes(type);
}

function outputSelectionFor(method, sourceIndex, id = `output-${Date.now()}`) {
  const type = method.outputs?.[sourceIndex]?.type;
  if (isNativeScalarOutput(type)) {
    return { id, sourceIndex, interpretation: "native", tags: tagRows(method.id, "TAG", 1) };
  }
  const valueType = valueTypeForOutput(type);
  const elementType = valueType === "array" ? valueTypeForOutput(type.element) === "array" ? "json" : valueTypeForOutput(type.element) : undefined;
  return {
    id,
    sourceIndex,
    interpretation: "native",
    selector: "",
    valueType,
    ...(elementType ? { elementType } : {}),
    tags: tagRows(method.id, "TAG", 1),
  };
}

function MethodCallsEditor({ calls, setCalls, onTest, interfaces = [], interfaceDetails = {} }) {
  const callDrag = useRef(-1);
  const [outputModal, setOutputModal] = useState(null);
  const updateCall = (index, patch) => setCalls((current) => current.map((call, callIndex) => callIndex === index ? { ...call, ...patch } : call));
  const methodsFor = (call) => (interfaceDetails[call.interfaceId]?.interface?.methods || []).map((method) => ({ ...method, displayName: method.member, inputs: (method.inputs || []).map((input) => ({ ...input, id: input.name })) }));
  const methodFor = (call) => methodsFor(call).find((method) => method.id === call.methodId);
  const chooseMethod = (index, methodId) => {
    const method = methodsFor(calls[index]).find((item) => item.id === methodId);
    if (!method) return;
    const replacement = createMethodCall(method, calls[index].id, calls[index].interfaceId);
    updateCall(index, replacement);
  };
  return <section className="neo-panel"><div className="neo-panel__title"><h2>METHOD CALLS</h2><button type="button" className="neo-button" onClick={() => setCalls((current) => [...current, { id: `call-${Date.now()}`, name: "New Call", interfaceId: "", methodId: "", inputs: {}, outputSelections: [] }])}>Add Call</button></div>
    {calls.map((call, index) => { const method = methodFor(call); return <article className="neo-call" key={call.id} draggable onDragStart={(event) => { if (callDrag.current !== index) { event.preventDefault(); return; } event.dataTransfer.setData("text/plain", String(index)); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (event.dataTransfer.types.includes("text/plain")) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.types.includes("text/plain")) return; const from = Number(event.dataTransfer.getData("text/plain")); if (Number.isInteger(from)) setCalls((current) => reorder(current, from, index)); }} onDragEnd={() => { callDrag.current = -1; }}>
      <div className="neo-call__head"><span className="neo-drag" onPointerDown={() => { callDrag.current = index; }} title="Drag to reorder method call" aria-label={`${call.name} Drag to reorder`}><Icon name="drag_indicator" /></span><span className="neo-actions"><IconButton icon="arrow_upward" label={`${call.name} Move up`} disabled={index === 0} onClick={() => setCalls((current) => reorder(current, index, index - 1))} /><IconButton icon="arrow_downward" label={`${call.name} Move down`} disabled={index === calls.length - 1} onClick={() => setCalls((current) => reorder(current, index, index + 1))} /><IconButton icon="delete" label={`${call.name} Remove`} disabled={calls.length === 1} onClick={() => setCalls((current) => current.filter((_, callIndex) => callIndex !== index))} /></span></div>
      <div className="neo-form-grid"><Field label="Call Name" wide><Input value={call.name} onChange={(name) => updateCall(index, { name })} /></Field><Field label="DBus Interface"><select aria-label={`${call.name} Interface`} value={call.interfaceId} onChange={(event) => updateCall(index, { interfaceId: event.target.value, methodId: "", inputs: {}, outputSelections: [] })}><option value="">Select interface</option>{interfaces.map((item) => <option value={item.id} key={item.id}>{item.name || item.interface}</option>)}</select></Field><Field label="Method"><select aria-label={`${call.name} Method`} disabled={!call.interfaceId} value={call.methodId} onChange={(event) => chooseMethod(index, event.target.value)}><option value="">Select method</option>{methodsFor(call).map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></Field>{(method?.inputs || []).map((input) => <Field label={`${input.id} (${dbusTypeLabel(input.type)})`} key={input.id}>{dbusInputEditor(input, call.inputs[input.id], (value) => updateCall(index, { inputs: { ...call.inputs, [input.id]: value } }))}</Field>)}</div>
      {method ? <><section className="neo-call__outputs"><div className="neo-panel__title"><h3>OUTPUT MAPPINGS</h3><button type="button" className="neo-button" disabled={!method.outputs?.length} onClick={() => setOutputModal({ callId: call.id, selection: null })}>Add Output</button></div><OutputMappingList method={method} selections={call.outputSelections || []} onEdit={(selection) => setOutputModal({ callId: call.id, selection })} onRemove={(selectionId) => updateCall(index, { outputSelections: (call.outputSelections || []).filter((selection) => selection.id !== selectionId) })} /></section>{outputModal?.callId === call.id ? <OutputMappingModal callName={call.name} method={method} selection={outputModal.selection} onClose={() => setOutputModal(null)} onSave={(selection) => { const current = call.outputSelections || []; updateCall(index, { outputSelections: outputModal.selection ? current.map((item) => item.id === selection.id ? selection : item) : [...current, selection] }); setOutputModal(null); }} /> : null}</> : null}
      <div className="neo-toolbar"><button type="button" className="neo-button" disabled={!method} onClick={() => onTest(call, method)}>Test Call</button></div>
    </article>; })}
  </section>;
}

function fixedCallInput(call, label) {
  const entry = Object.entries(call?.inputs || {}).find(([key]) => productInputLabel(key) === label);
  return entry ? entry[1] : "";
}

function tagSummary(tags = []) {
  if (!tags.length) return "0 tags";
  if (tags.length === 1) return `1 tag · ${tags[0].name}`;
  return `${tags.length} tags · ${tags[0].name} ~ ${tags[tags.length - 1].name}`;
}

function FixedProviderInput({ input, label, value, onChange }) {
  const editor = dbusInputEditor(input, value, onChange);
  return editor.type === Input
    ? editor.type({ ...editor.props, "aria-label": label })
    : React.cloneElement(editor, { "aria-label": label });
}

function deviceStringParts(value, builder) {
  const raw = String(value || "").replace(/^%/, "");
  const match = /^(.+?)(\d+)$/.exec(raw);
  const fallback = {
    area: builder.memoryAreas[0] || "",
    type: builder.dataTypes[0] || "",
    address: "",
  };
  if (!match) return fallback;
  const stem = match[1];
  const type = [...builder.dataTypes]
    .sort((left, right) => right.length - left.length)
    .find((item) => stem.length > item.length && stem.toUpperCase().endsWith(item.toUpperCase()));
  if (type) return { area: stem.slice(0, -type.length), type, address: match[2] };
  return stem.length > 1
    ? { area: stem.slice(0, -1), type: stem.slice(-1), address: match[2] }
    : { ...fallback, area: stem, address: match[2] };
}

function DeviceStringChoice({ label, value, options, open, onChange, onToggle, onSelect }) {
  const visibleLabel = label.replace(/\b\w/g, (letter) => letter.toUpperCase());
  const choiceInput = Input({ "aria-label": `DeviceString ${label.toLowerCase()}`, value, onChange });
  return <div className="neo-device-string__choice"><span>{visibleLabel}</span><div className="neo-device-string__choice-control">{choiceInput}<IconButton icon={open ? "expand_less" : "expand_more"} label={`Toggle DeviceString ${label.toLowerCase()} options`} aria-expanded={open} onClick={onToggle} /></div>{open ? <div className="neo-device-string__options" role="listbox" aria-label={`DeviceString ${label.toLowerCase()} options`}>{options.map((option) => <button type="button" role="option" aria-selected={option === value} key={option} onClick={() => onSelect(option)}>{option}</button>)}</div> : null}</div>;
}

function NumberStepper({ label, value, min, step = 1, onChange, onBlur, nextValue, previousValue }) {
  const hasMinimum = min !== undefined && min !== null;
  const minimum = hasMinimum ? Number(min) : Number.NEGATIVE_INFINITY;
  const increment = Number(step);
  const numericValue = Number(value);
  const fallback = hasMinimum ? minimum : 0;
  const update = (nextValue) => onChange(String(hasMinimum ? Math.max(minimum, Number.isFinite(nextValue) ? nextValue : fallback) : (Number.isFinite(nextValue) ? nextValue : fallback)));
  const current = Number.isFinite(numericValue) ? numericValue : fallback;
  const input = Input({ "aria-label": label, type: "number", ...(hasMinimum ? { min: String(minimum) } : {}), step: String(increment), value, onChange: (nextValue) => update(Number(nextValue)), onBlur: () => { if (onBlur) onBlur(current); } });
  return <div className="neo-number-stepper">{input}<span className="neo-number-stepper__actions"><IconButton icon="expand_less" label={`${label} Increase`} onClick={() => update(nextValue ? nextValue(current) : current + increment)} /><IconButton icon="expand_more" label={`${label} Decrease`} disabled={hasMinimum && current <= minimum} onClick={() => update(previousValue ? previousValue(current) : current - increment)} /></span></div>;
}

function DeviceStringInput({ inputLabel, value, onChange, builder }) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState("");
  const initialParts = () => {
    const parts = deviceStringParts(value, builder);
    return { ...parts, address: parts.address || "0" };
  };
  const [draft, setDraft] = useState(initialParts);
  const [directValue, setDirectValue] = useState(() => `%${String(value || "").replace(/^%/, "")}`);
  useEffect(() => {
    if (!open) {
      setDraft(initialParts());
      setDirectValue(`%${String(value || "").replace(/^%/, "")}`);
    }
  }, [value, builder, open]);
  useEffect(() => {
    if (!open || typeof document === "undefined") return undefined;
    const close = (event) => { if (!rootRef.current?.contains(event.target)) { setOpen(false); setChoiceOpen(""); } };
    const escape = (event) => { if (event.key === "Escape") { setOpen(false); setChoiceOpen(""); } };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const toggle = () => {
    setOpen((current) => {
      if (!current) {
        setDraft(initialParts());
        setDirectValue(`%${String(value || "").replace(/^%/, "")}`);
      }
      if (current) setChoiceOpen("");
      return !current;
    });
  };
  const updateDraft = (patch) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setDirectValue(`%${next.area}${next.type}${next.address}`);
  };
  const directValid = /^%[^%\d][^%]*\d+$/.test(directValue);
  const apply = () => {
    onChange(directValue.replace(/^%/, ""));
    setOpen(false);
    setChoiceOpen("");
  };
  const mainInput = Input({ "aria-label": inputLabel, value, readOnly: true, onClick: () => { if (!open) toggle(); }, onChange() {} });
  const addressInput = <NumberStepper label="DeviceString address" min={0} step={1} value={draft.address} onChange={(address) => updateDraft({ address })} />;
  const directInput = Input({ className: "neo-device-string__preview", "aria-label": "DeviceString address preview", value: directValue, onChange: (nextValue) => {
    setDirectValue(nextValue);
    if (/^%[^%\d][^%]*\d+$/.test(nextValue)) setDraft(deviceStringParts(nextValue, builder));
  } });
  return <div className="neo-device-string" ref={rootRef}><div className="neo-device-string__control"><span aria-hidden="true">%</span>{mainInput}<IconButton icon={open ? "expand_less" : "expand_more"} label="Toggle DeviceString address picker" aria-expanded={open} onClick={toggle} /></div>{open ? <div className="neo-device-string__popover" role="dialog" aria-label="DeviceString address picker"><div className="neo-device-string__picker-grid"><DeviceStringChoice label="memory area" value={draft.area} options={builder.memoryAreas} open={choiceOpen === "area"} onChange={(area) => updateDraft({ area })} onToggle={() => setChoiceOpen((current) => current === "area" ? "" : "area")} onSelect={(area) => { updateDraft({ area }); setChoiceOpen(""); }} /><DeviceStringChoice label="data type" value={draft.type} options={builder.dataTypes} open={choiceOpen === "type"} onChange={(type) => updateDraft({ type })} onToggle={() => setChoiceOpen((current) => current === "type" ? "" : "type")} onSelect={(type) => { updateDraft({ type }); setChoiceOpen(""); }} /><div className="neo-device-string__address"><span>Address</span>{addressInput}</div></div>{directInput}<button type="button" className="neo-button neo-button--primary neo-device-string__apply" disabled={!directValid} onClick={apply}>Apply</button></div> : null}</div>;
}

function FixedProviderTagsEditor({ selection, onChange, bitAddress = false }) {
  const tags = selection?.tags || [];
  const updateTag = (tagIndex, patch) => onChange({
    ...selection,
    tags: tags.map((tag, index) => index === tagIndex ? { ...tag, ...patch } : tag),
  });
  return <div className="neo-fixed-tags__editor neo-table-wrap"><table className="neo-fixed-tag-list"><colgroup><col className="neo-fixed-tag-list__index" /><col className="neo-fixed-tag-list__name" /><col className="neo-fixed-tag-list__signed" /><col className="neo-fixed-tag-list__transform" /></colgroup><thead><tr><th>#</th><th>TAG NAME</th><th>SIGNED</th><th>TRANSFORM</th></tr></thead><tbody>{tags.map((tag, tagIndex) => {
    const transformOrder = tag.transformOrder || ["bias", "multiplier"];
    return <tr key={tagIndex}><td>{tagIndex + 1}</td><td><FixedProviderInput input={{ type: "string" }} label={`${tag.name} Tag Name`} value={tag.name} onChange={(name) => updateTag(tagIndex, { name, nameMode: "manual" })} /></td><td><input aria-label={`${tag.name} Signed`} type="checkbox" checked={tag.signed === true} disabled={bitAddress} title={bitAddress ? "Signed conversion does not apply to Bit values." : "Interpret this PLC value as signed."} onChange={(event) => updateTag(tagIndex, { signed: event.target.checked })} /></td><td><div className="neo-tag-transform"><span>(</span><strong>value</strong>{transformOrder.map((operation, transformIndex) => { const label = `${tag.name} ${operation === "bias" ? "Bias" : "Multiplier"}`; return <span className="neo-tag-transform__part" key={operation}><span className="neo-tag-transform__operand" draggable onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData(TRANSFORM_DRAG_TYPE, String(transformIndex)); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { event.stopPropagation(); if (event.dataTransfer.types.includes(TRANSFORM_DRAG_TYPE)) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const draggedTransform = Number(event.dataTransfer.getData(TRANSFORM_DRAG_TYPE)); if (!Number.isInteger(draggedTransform)) return; updateTag(tagIndex, { transformOrder: reorder(transformOrder, draggedTransform, transformIndex) }); }} onDragEnd={(event) => event.stopPropagation()}><Icon name="drag_indicator" /><span>{operation === "bias" ? "+" : "×"}</span><NumberStepper label={label} step={1} value={tag[operation]} onChange={(value) => updateTag(tagIndex, { [operation]: Number(value) })} /></span>{transformIndex === 0 ? <span>)</span> : null}</span>; })}</div></td></tr>;
  })}</tbody></table></div>;
}

function TestCallResult({ result, onClear, ariaLabel }) {
  if (!result) return null;
  return <section className="neo-test-call-result" aria-label={ariaLabel}>
    <header className="neo-test-call-result__header"><h3>TEST CALL</h3>{onClear ? <button type="button" className="neo-button" onClick={onClear}>Clear</button> : null}</header>
    <div className="neo-summary-grid neo-summary-grid--compact"><Metric label="SUCCESS" value={String(Boolean(result.success))} /><Metric label="DURATION" value={`${result.durationMs ?? "—"} ms`} /><Metric label="VALUES" value={result.valueCount ?? result.values?.length ?? 0} /></div>
    <h3>Call result</h3><pre className="neo-code">{JSON.stringify(result.values || [], null, 2)}</pre>
  </section>;
}

export function FixedProviderCallsEditor({ calls, methodsByInterface, provider, testResult, setCalls, onTest, onClearTest }) {
  const [selectedCallId, setSelectedCallId] = useState(calls[0]?.id || "");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagCsvError, setTagCsvError] = useState(null);
  const tagCsvInputRef = useRef(null);
  const selectedCallRef = useRef(null);
  const selectedIndex = Math.max(0, calls.findIndex((call) => call.id === selectedCallId));
  const call = calls[selectedIndex];
  const method = (methodsByInterface[call?.interfaceId]?.interface?.methods || []).find((item) => item.id === call?.methodId);
  const selectionIndex = Math.max(0, (call?.outputSelections || []).findIndex((selection) => selection.id === provider?.outputSelections?.[0]?.id));
  const selection = call?.outputSelections?.[selectionIndex];

  useEffect(() => {
    if (!calls.some((item) => item.id === selectedCallId)) setSelectedCallId(calls[0]?.id || "");
  }, [calls, selectedCallId]);

  useEffect(() => {
    selectedCallRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedCallId, calls.length]);

  const selectCall = (id) => {
    setSelectedCallId(id);
    setTagsOpen(false);
    setTagCsvError(null);
  };
  const updateCall = (index, nextCall) => setCalls((current) => current.map((item, itemIndex) => itemIndex === index ? nextCall : item));
  const addCall = () => {
    const next = appendProductMethodCall(calls, provider);
    setCalls(next);
    setSelectedCallId(next.at(-1)?.id || "");
    setTagsOpen(false);
    setTagCsvError(null);
  };
  const moveCall = (from, to) => setCalls((current) => reorder(current, from, to));
  const removeSelected = () => {
    if (calls.length === 1) return;
    const nextSelectedId = calls[selectedIndex - 1]?.id || calls[selectedIndex + 1]?.id || "";
    setCalls((current) => current.filter((item) => item.id !== call.id));
    setSelectedCallId(nextSelectedId);
    setTagsOpen(false);
    setTagCsvError(null);
  };
  const updateInputs = (key, value) => {
    const inputs = { ...(call.inputs || {}), [key]: value };
    const outputSelections = (call.outputSelections || []).map((currentSelection, index) => {
      if (index !== selectionIndex) return currentSelection;
      const generatedBefore = reconcileGeneratedTags(call.inputs, [], provider);
      const existingTags = (currentSelection.tags || []).map((tag, tagIndex) => tag.nameMode ? tag : ({
        ...tag,
        nameMode: tag.name === generatedBefore[tagIndex]?.name ? "auto" : "manual",
      }));
      return { ...currentSelection, tags: reconcileGeneratedTags(inputs, existingTags, provider) };
    });
    updateCall(selectedIndex, { ...call, inputs, outputSelections });
  };
  const updateSelection = (nextSelection) => updateCall(selectedIndex, {
    ...call,
    outputSelections: (call.outputSelections || []).map((item, index) => index === selectionIndex ? nextSelection : item),
  });
  const importTags = async (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    try {
      if (!file || !productTagCsvImporter || !selection) return;
      const text = await file.text();
      const tags = productTagCsvImporter.apply(text, selection.tags || [], Number(fixedCallInput(call, "DataCount")));
      updateSelection({ ...selection, tags });
      setTagCsvError(null);
    } catch (failure) {
      setTagCsvError(failure instanceof Error ? failure : new Error("CSV import failed."));
    } finally {
      input.value = "";
    }
  };

  if (!call) return <section className="neo-panel neo-fixed-calls"><div className="neo-fixed-calls__header"><h2>METHOD CALLS</h2><button type="button" className="neo-button" onClick={addCall}>Add Call</button></div><p role="status">Provider Method Call is unavailable.</p></section>;
  const sortedInputs = [...(method?.inputs || [])].sort((left, right) => {
    const order = { DeviceString: 0, DataCount: 1 };
    return (order[productInputLabel(left.id || left.name)] ?? 2) - (order[productInputLabel(right.id || right.name)] ?? 2);
  });
  return <section className="neo-panel neo-fixed-calls"><header className="neo-fixed-calls__header"><h2>METHOD CALLS</h2><button type="button" className="neo-button" onClick={addCall}>Add Call</button></header><div className="neo-fixed-calls__body">
    <div className="neo-fixed-calls__list-shell"><div className="neo-fixed-calls__list">{calls.map((item, index) => <article ref={item.id === call.id ? selectedCallRef : null} className={`neo-fixed-calls__item${item.id === call.id ? " is-selected" : ""}`} key={item.id} onDragOver={(event) => { if (event.dataTransfer.types.includes(LS_CALL_DRAG_TYPE)) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.types.includes(LS_CALL_DRAG_TYPE)) return; event.preventDefault(); const from = Number(event.dataTransfer.getData(LS_CALL_DRAG_TYPE)); if (Number.isInteger(from)) moveCall(from, index); }}>
      <span className="neo-drag" draggable onDragStart={(event) => { const row = event.currentTarget.closest(".neo-fixed-calls__item"); if (row && event.dataTransfer.setDragImage) { const bounds = row.getBoundingClientRect(); event.dataTransfer.setDragImage(row, event.clientX - bounds.left, event.clientY - bounds.top); } event.dataTransfer.setData(LS_CALL_DRAG_TYPE, String(index)); event.dataTransfer.effectAllowed = "move"; }} title="Drag to reorder method call" aria-label={`${item.id} Drag to reorder`}><Icon name="drag_indicator" /></span><button type="button" className="neo-fixed-calls__select" aria-label={`${item.id} Select`} aria-pressed={item.id === call.id} onClick={() => selectCall(item.id)}><strong>{productInputPrefix("DeviceString")}{productDisplayInputValue("DeviceString", fixedCallInput(item, "DeviceString")) || "—"}</strong><span>DataCount <b>{fixedCallInput(item, "DataCount") || "—"}</b></span></button>
    </article>)}</div></div>
    <div className="neo-fixed-calls__detail"><div className="neo-fixed-calls__detail-header"><p className="neo-fixed-calls__method neo-mono">{call.interfaceId} · {call.methodId}</p><span className="neo-actions"><button type="button" className="neo-button" onClick={() => onTest(call, method)}>Test Call</button><IconButton icon="delete" label={`${call.id} Remove`} disabled={calls.length === 1} onClick={removeSelected} /></span></div>
      <div className="neo-fixed-calls__inputs">{sortedInputs.map((input) => { const key = input.id || input.name; const label = productInputLabel(key); const prefix = productInputPrefix(key); const value = productDisplayInputValue(key, call.inputs?.[key]); const onChange = (value) => updateInputs(key, productStoreInputValue(key, value)); const builder = productDeviceStringBuilder(key); const editor = builder ? <DeviceStringInput inputLabel={label} value={value} onChange={onChange} builder={builder} /> : label === "DataCount" ? <NumberStepper label={label} min={1} step={1} value={value || 1} onChange={(nextValue) => onChange(Number(nextValue))} /> : <FixedProviderInput input={{ ...input, id: key }} label={label} value={value} onChange={onChange} />; return <Field label={label} key={`${call.id}-${key}`}>{prefix && !builder ? <div className="neo-input-prefix"><span aria-hidden="true">{prefix}</span>{editor}</div> : editor}</Field>; })}</div>
      <section className={`neo-fixed-tags${tagsOpen ? " is-open" : ""}`}><div className="neo-fixed-tags__header"><button type="button" className="neo-fixed-tags__summary" aria-expanded={tagsOpen} onClick={() => setTagsOpen((open) => !open)}><strong>TAGS</strong><span>{tagSummary(selection?.tags || [])}</span></button>{productTagCsvImporter ? <><input ref={tagCsvInputRef} className="neo-visually-hidden" aria-label="Import Tags CSV" type="file" accept=".csv,text/csv" onChange={importTags} /><button type="button" className="neo-button" onClick={() => tagCsvInputRef.current?.click()}>Import CSV</button></> : null}<button type="button" className="neo-icon-button neo-fixed-tags__toggle" aria-label="Toggle Tags" aria-expanded={tagsOpen} onClick={() => setTagsOpen((open) => !open)}><Icon name={tagsOpen ? "expand_less" : "expand_more"} /></button></div>{tagCsvError ? <p className="neo-message neo-message--error neo-fixed-tags__error" role="alert">{tagCsvError.message}</p> : null}{tagsOpen && selection ? <FixedProviderTagsEditor selection={selection} onChange={updateSelection} bitAddress={/^%.[Xx]/.test(String(call?.inputs?.DeviceString || ""))} /> : null}</section>
      {testResult?.callId === call.id ? <TestCallResult result={testResult} onClear={onClearTest} ariaLabel={`${call.id} Test Call result`} /> : null}
    </div>
  </div></section>;
}

function OutputMappingList({ method, selections, onEdit, onRemove }) {
  if (!method.outputs?.length) return <p role="status">This Method has no output arguments.</p>;
  if (!selections.length) return <p role="status">No output mapping.</p>;
  const tagLabel = (selection) => {
    const tags = selection.tags || [];
    if (!tags.length) return "—";
    if (selection.valueType === "array") return `${tags[0].name} ~ ${tags[tags.length - 1].name}`;
    return tags[0].name;
  };
  return <div className="neo-table-wrap"><table className="neo-output-list"><thead><tr><th>Output</th><th>Format</th><th>Tags</th><th /></tr></thead><tbody>{selections.map((selection) => { const output = method.outputs[selection.sourceIndex]; const label = output?.name || `Output ${selection.sourceIndex + 1}`; const format = selection.interpretation === "json" ? `JSON ${selection.selector || "root"} · ${selection.valueType}` : dbusTypeLabel(output?.type); return <tr key={selection.id}><td><button type="button" className="neo-link-button" onClick={() => onEdit(selection)}>{label}</button></td><td>{format}</td><td>{tagLabel(selection)}</td><td className="neo-output-list__actions"><span className="neo-actions"><IconButton icon="edit" label={`Edit ${label}`} onClick={() => onEdit(selection)} /><IconButton icon="delete" label={`Remove ${label}`} onClick={() => onRemove(selection.id)} /></span></td></tr>; })}</tbody></table></div>;
}

function OutputMappingModal({ callName, method, selection, onClose, onSave }) {
  const [draft, setDraft] = useState(selection || outputSelectionFor(method, 0));
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [prefix, setPrefix] = useState("TAG");
  const [count, setCount] = useState(draft.tags?.length || 1);
  const output = method.outputs?.[draft.sourceIndex]; const valueType = draft.valueType || valueTypeForOutput(output?.type); const nativeScalar = draft.interpretation !== "json" && isNativeScalarOutput(output?.type); const numeric = valueType === "numeric" || (valueType === "array" && draft.elementType === "numeric");
  const patch = (next) => setDraft((current) => ({ ...current, ...next }));
  const generate = () => { const nextCount = Number(count); if (!Number.isInteger(nextCount) || nextCount < 1) return; patch({ tags: tagRows(method.id, prefix, nextCount) }); setGeneratorOpen(false); };
  return <Modal title={selection ? `Edit Output · ${callName}` : `Add Output · ${callName}`} variant="output-mappings" onClose={onClose}><section className="neo-output-modal"><div className="neo-form-grid"><Field label="Method output"><select aria-label={`${callName} Output`} value={draft.sourceIndex} onChange={(event) => { const replacement = outputSelectionFor(method, Number(event.target.value), draft.id); setDraft({ ...replacement, tags: draft.tags }); }}>{(method.outputs || []).map((item, sourceIndex) => <option value={sourceIndex} key={sourceIndex}>{item.name || `Output ${sourceIndex + 1}`} ({dbusTypeLabel(item.type)})</option>)}</select></Field>{output?.type === "string" ? <Field label="Interpret as"><select aria-label={`${callName} Interpretation`} value={draft.interpretation || "native"} onChange={(event) => { const next = event.target.value === "native" ? outputSelectionFor(method, draft.sourceIndex, draft.id) : { ...draft, interpretation: "json", selector: "", valueType: "numeric" }; setDraft({ ...next, tags: draft.tags }); }}><option value="native">Native string</option><option value="json">Parse as JSON</option></select></Field> : null}{!nativeScalar ? <Field label="Selector (JSON Pointer)"><Input aria-label={`${callName} Selector`} value={draft.selector || ""} placeholder="/data" onChange={(selector) => patch({ selector })} /></Field> : null}{!nativeScalar ? <Field label="Value type"><select aria-label={`${callName} Value type`} value={valueType} onChange={(event) => { const nextType = event.target.value; patch({ valueType: nextType, ...(nextType === "array" ? { elementType: draft.elementType || "numeric" } : { elementType: undefined }), tags: tagRows(method.id, "TAG", 1) }); }}><option value="numeric">Numeric</option><option value="string">String</option><option value="json">JSON</option><option value="array">Array</option></select></Field> : null}{!nativeScalar && valueType === "array" ? <><Field label="Array element type"><select aria-label={`${callName} Array element type`} value={draft.elementType || "numeric"} onChange={(event) => patch({ elementType: event.target.value })}><option value="numeric">Numeric</option><option value="string">String</option><option value="json">JSON</option></select></Field><div className="neo-array-tag-actions"><button type="button" className="neo-button" onClick={() => setGeneratorOpen(true)}><Icon name="auto_awesome" />Generate from Array</button></div></> : null}</div><TagMappingEditor numeric={numeric} selection={draft} onChange={patch} />{generatorOpen ? <Modal title="Generate Tags" variant="tag-generator" onClose={() => setGeneratorOpen(false)}><div className="neo-form-grid"><Field label="Prefix"><Input aria-label="Tag prefix" value={prefix} onChange={setPrefix} /></Field><Field label="Count"><Input aria-label="Tag count" type="number" min="1" value={count} onChange={(value) => setCount(Number(value))} /></Field></div><div className="neo-actions"><button type="button" className="neo-button" onClick={() => setGeneratorOpen(false)}>Cancel</button><button type="button" className="neo-button neo-button--primary" onClick={generate}>Generate</button></div></Modal> : null}<div className="neo-actions"><button type="button" className="neo-button" onClick={onClose}>Cancel</button><button type="button" className="neo-button neo-button--primary" onClick={() => onSave(draft)}>{selection ? "Update Output" : "Add Output"}</button></div></section></Modal>;
}

function TagMappingEditor({ numeric, selection, onChange }) {
  const tags = selection.tags || [];
  const isArray = selection.valueType === "array";
  const replaceTags = (next) => onChange({ tags: next });
  const updateTag = (tagIndex, patch) => replaceTags(tags.map((tag, index) => index === tagIndex ? { ...tag, ...patch } : tag));
  return <div className="neo-table-wrap"><table className={`neo-tag-list${numeric ? " neo-tag-list--numeric" : ""}`}><colgroup>{numeric ? <><col className="neo-tag-list__name" /><col className="neo-tag-list__transform" /><col className="neo-tag-list__actions" /></> : <><col className="neo-tag-list__name" /><col className="neo-tag-list__actions" /></>}</colgroup><thead><tr><th>Name</th>{numeric ? <th>Transform</th> : null}<th /></tr></thead><tbody>{tags.map((tag, tagIndex) => {
    const transformOrder = tag.transformOrder || ["bias", "multiplier"];
    return <tr key={tagIndex}><td><Input value={tag.name} onChange={(name) => updateTag(tagIndex, { name })} /></td>{numeric ? <td><div className="neo-tag-transform"><span>(</span><strong>value</strong>{transformOrder.map((operation, transformIndex) => { const label = `${tag.name} ${operation === "bias" ? "Bias" : "Multiplier"}`; return <span className="neo-tag-transform__part" key={operation}><span className="neo-tag-transform__operand" draggable onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.setData(TRANSFORM_DRAG_TYPE, String(transformIndex)); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { event.stopPropagation(); if (event.dataTransfer.types.includes(TRANSFORM_DRAG_TYPE)) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); const draggedTransform = Number(event.dataTransfer.getData(TRANSFORM_DRAG_TYPE)); if (!Number.isInteger(draggedTransform)) return; updateTag(tagIndex, { transformOrder: reorder(transformOrder, draggedTransform, transformIndex) }); }} onDragEnd={(event) => event.stopPropagation()}><Icon name="drag_indicator" /><span>{operation === "bias" ? "+" : "×"}</span><NumberStepper label={label} step={1} value={tag[operation]} onChange={(value) => updateTag(tagIndex, { [operation]: Number(value) })} /></span>{transformIndex === 0 ? <span>)</span> : null}</span>; })}</div></td> : null}<td className="neo-tag-list__actions"><IconButton icon="delete" label={`Remove ${tag.name}`} disabled={!isArray && tags.length === 1} onClick={() => replaceTags(tags.filter((_, itemIndex) => itemIndex !== tagIndex))} /></td></tr>;
  })}</tbody></table></div>;
}

function JobSectionSummary({ className = "", label, items, onEdit }) {
  return <div className={`neo-panel__title neo-job-section-header ${className}`.trim()}>
    <h2>{label}</h2>
    <div className="neo-job-section-summary" aria-label={`${label === "DATABASE" ? "Database" : "Job Configuration"} summary`}>
      {items.map((item) => <span className="neo-job-section-summary__item" key={item.label}><span className="neo-job-section-summary__label">{item.label}</span><strong>{item.value || "—"}</strong></span>)}
    </div>
    {onEdit ? <IconButton icon="edit" label={`Edit ${label === "DATABASE" ? "Database" : "Job Configuration"}`} onClick={onEdit} /> : null}
  </div>;
}

function JobForm({ mode }) {
  const params = useParams();
  const navigate = useNavigate();
  const app = useApp();
  const provider = app.provider;
  const editing = mode === "edit";
  const formMode = jobFormMode({ settings: app.settings, settingsLoading: app.settingsLoading, settingsError: app.settingsError, editing });
  const fixedNewJob = formMode === "fixed";
  const intervalCycleMs = Math.max(1, Number(app.settings?.intervalPolicy?.cycleMs) || 1);
  const intervalDefaultMs = Math.ceil(10 / intervalCycleMs) * intervalCycleMs;
  const normalizeInterval = (value) => Math.max(intervalCycleMs, Math.ceil(Math.max(0, Number(value) || 0) / intervalCycleMs) * intervalCycleMs);
  const nextInterval = (value) => Math.max(intervalCycleMs, (Math.floor((Number(value) || 0) / intervalCycleMs) + 1) * intervalCycleMs);
  const previousInterval = (value) => Math.max(intervalCycleMs, (Math.ceil((Number(value) || 0) / intervalCycleMs) - 1) * intervalCycleMs);
  const currentEditName = useRef(params.name || "");
  currentEditName.current = params.name || "";
  const beginSubmission = useRouteMutation(editing ? params.name : "new");
  const beginTestCall = useRouteMutation(editing ? params.name : "new");
  const loaded = useLoad((signal) => Promise.all([api.interfaces.list({ signal }), api.db.servers.list({ signal }), editing ? api.jobs.get(params.name, { signal }) : Promise.resolve(null)]), [editing, params.name]);
  const [name, setName] = useState("");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [errors, setErrors] = useState([]);
  const [testResult, setTestResult] = useState(null);
  const [interfaceDetail, setInterfaceDetail] = useState(null);
  const [interfaceDetails, setInterfaceDetails] = useState({});
  const [tables, setTables] = useState([]);
  const [columns, setColumns] = useState([]);
  const [tableListOpen, setTableListOpen] = useState(false);
  const [jobConfigurationModalOpen, setJobConfigurationModalOpen] = useState(false);
  const [databaseModalOpen, setDatabaseModalOpen] = useState(false);
  const [jobConfigurationDraft, setJobConfigurationDraft] = useState(null);
  const [databaseDraft, setDatabaseDraft] = useState(null);
  const [validationWarnings, setValidationWarnings] = useState([]);
  const [warningApprovalKey, setWarningApprovalKey] = useState("");
  const defaultNameApplied = useRef(false);
  const nameEdited = useRef(false);
  const activeDatabase = databaseModalOpen && databaseDraft ? databaseDraft : config.database;
  useEffect(() => {
    defaultNameApplied.current = editing;
    nameEdited.current = false;
    setName("");
    setConfig(DEFAULT_CONFIG);
    setErrors([]);
    setTestResult(null);
    setInterfaceDetail(null);
    setTables([]);
    setColumns([]);
    setTableListOpen(false);
    setJobConfigurationModalOpen(false);
    setDatabaseModalOpen(false);
    setJobConfigurationDraft(null);
    setDatabaseDraft(null);
    setValidationWarnings([]);
    setWarningApprovalKey("");
  }, [editing, params.name]);
  useEffect(() => {
    if (editing || app.loading || app.error || defaultNameApplied.current || nameEdited.current) return;
    setName(nextDefaultJobName(app.jobs));
    defaultNameApplied.current = true;
  }, [app.error, app.jobs, app.loading, editing, params.name]);
  useEffect(() => {
    if (!loaded.data || formMode === "blocked") return;
    const [interfaces, servers, job] = loaded.data;
    const settings = app.settings;
    if (editing) {
      if (job?.name !== params.name) return;
      setName(job.name);
      setConfig(hydrateJobConfig({ ...DEFAULT_CONFIG, ...job.config }));
    } else {
      const databaseServer = settings?.defaults?.database?.server || servers?.[0]?.name || "";
      const server = (servers || []).find((item) => item.name === databaseServer);
      setConfig(createDefaultJobConfig(provider, server || { name: databaseServer }, createInitialMethodCalls(provider), intervalDefaultMs));
    }
  }, [app.settings, editing, formMode, intervalDefaultMs, loaded.data, params.name, provider]);
  useEffect(() => {
    const interfaceIds = [...new Set((config.methodCalls || []).map((call) => call.interfaceId).filter(Boolean))];
    if (!interfaceIds.length) return undefined;
    const controller = new AbortController();
    Promise.all(interfaceIds.map((interfaceId) => api.interfaces.get(interfaceId, { signal: controller.signal }).then((detail) => [interfaceId, detail]))).then((entries) => {
      const next = Object.fromEntries(entries);
      setInterfaceDetails(next);
      setInterfaceDetail(next[interfaceIds[0]] || null);
    }, () => { setInterfaceDetails({}); setInterfaceDetail(null); });
    return () => controller.abort();
  }, [JSON.stringify((config.methodCalls || []).map((call) => call.interfaceId)), params.name]);
  useEffect(() => {
    if (!Object.keys(interfaceDetails).length) return;
    setConfig((current) => {
      let changed = false;
      const methodCalls = (current.methodCalls || []).map((call) => {
        const method = (interfaceDetails[call.interfaceId]?.interface?.methods || []).find((item) => item.id === call.methodId);
        if (!method || !Array.isArray(call.outputSelections)) return call;
        const outputSelections = call.outputSelections.map((selection) => {
          const outputType = method.outputs?.[selection.sourceIndex]?.type;
          if (selection.interpretation === "json" || !isNativeScalarOutput(outputType) || (selection.selector === undefined && selection.valueType === undefined && selection.elementType === undefined)) return selection;
          changed = true;
          const { selector, valueType, elementType, ...nativeSelection } = selection;
          return nativeSelection;
        });
        return changed ? { ...call, outputSelections } : call;
      });
      return changed ? { ...current, methodCalls } : current;
    });
  }, [interfaceDetails]);
  useEffect(() => {
    if (!fixedNewJob) return;
    setConfig((current) => {
      return {
        ...current,
        methodCalls: current.methodCalls.map((call) => {
          const method = (interfaceDetails[call.interfaceId]?.interface?.methods || []).find((item) => item.id === call.methodId);
          if (!method) return call;
          const defaults = createMethodCall({ ...method, inputs: (method.inputs || []).map((input) => ({ ...input, id: input.id || input.name })) }, call.id, call.interfaceId).inputs;
          return { ...call, inputs: { ...defaults, ...(call.inputs || {}) } };
        }),
      };
    });
  }, [fixedNewJob, interfaceDetails]);
  useEffect(() => {
    if (!activeDatabase.server) { setTables([]); setTableListOpen(false); return undefined; }
    const controller = new AbortController();
    api.db.tables.list({ server: activeDatabase.server }, { signal: controller.signal }).then(
      (values) => setTables(values.tables || values || []),
      () => setTables([]),
    );
    return () => controller.abort();
  }, [activeDatabase.server, params.name]);
  useEffect(() => {
    const selected = tables.some((table) => String(table.name || table).toUpperCase() === String(activeDatabase.table || '').toUpperCase());
    if (!activeDatabase.server || !activeDatabase.table || !selected) { setColumns([]); return undefined; }
    const controller = new AbortController();
    api.db.tables.columns({ server: activeDatabase.server, table: activeDatabase.table }, { signal: controller.signal }).then((values) => setColumns(values.columns || values || []), () => setColumns([]));
    return () => controller.abort();
  }, [activeDatabase.server, activeDatabase.table, params.name, tables]);
  useEffect(() => {
    if (!tableListOpen) return undefined;
    const closeWhenFocusLeaves = (event) => {
      if (!event.target?.closest?.(".neo-combobox")) setTableListOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenFocusLeaves);
    document.addEventListener("focusin", closeWhenFocusLeaves);
    return () => {
      document.removeEventListener("pointerdown", closeWhenFocusLeaves);
      document.removeEventListener("focusin", closeWhenFocusLeaves);
    };
  }, [tableListOpen]);
  const openJobConfiguration = () => {
    setJobConfigurationDraft({
      name,
      schedule: { ...config.schedule },
      retry: { ...config.retry },
      execution: { ...config.execution },
    });
    setJobConfigurationModalOpen(true);
  };
  const cancelJobConfiguration = () => {
    setJobConfigurationDraft(null);
    setJobConfigurationModalOpen(false);
  };
  const applyJobConfiguration = () => {
    if (jobConfigurationDraft) {
      setName(jobConfigurationDraft.name);
      setConfig((current) => ({ ...current, schedule: jobConfigurationDraft.schedule, retry: jobConfigurationDraft.retry, execution: jobConfigurationDraft.execution }));
    }
    setJobConfigurationDraft(null);
    setJobConfigurationModalOpen(false);
  };
  const openDatabase = () => {
    setDatabaseDraft({ ...config.database });
    setDatabaseModalOpen(true);
  };
  const cancelDatabase = () => {
    setDatabaseDraft(null);
    setTableListOpen(false);
    setDatabaseModalOpen(false);
  };
  const applyDatabase = () => {
    if (databaseDraft) setConfig((current) => ({ ...current, database: databaseDraft }));
    setDatabaseDraft(null);
    setTableListOpen(false);
    setDatabaseModalOpen(false);
  };
  const save = async (event) => {
    event.preventDefault();
    const targetName = editing ? params.name : name;
    const submission = beginSubmission();
    try {
      if (formBlocked) {
        if (!editRoutePending) setErrors([formMode === "blocked" ? "Settings must be loaded before editing a Job." : editBlockMessage || "Job status must be checked before editing."]);
        return;
      }
      const needsStringValueColumn = jobNeedsStringValueColumn(config.methodCalls, interfaceDetails);
      const configForSave = tableWillBeCreated
        ? { ...config, database: { ...config.database, valueColumn: "VALUE", stringValueColumn: needsStringValueColumn ? "STR_VALUE" : "" } }
        : config;
      const validation = [];
      if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(name)) validation.push("Job name must use lowercase letters, numbers, _ or -.");
      if (!configForSave.methodCalls.length) validation.push("At least one Method Call is required.");
      configForSave.methodCalls.forEach((call) => {
        if (!call.interfaceId) validation.push("Select a DBus Interface for every Method Call.");
        else if (!call.methodId) validation.push("Select a Method for every Method Call.");
      });
      if (!configForSave.database.server) validation.push("Select a Database Server.");
      if (!configForSave.database.table) validation.push("Select or enter a Table.");
      if (!configForSave.database.valueColumn) validation.push("Select a Value Column.");
      validation.push(...validateJobTags(configForSave.methodCalls.map((call) => ({ ...call, method: (interfaceDetails[call.interfaceId]?.interface?.methods || []).find((method) => method.id === call.methodId) })), {
        maxGeneratedTagsPerCall: app.settings?.limits?.maxGeneratedTagsPerCall,
      }));
      setErrors(validation);
      if (validation.length) return;
      const payload = serializeJobConfig(configForSave);
      const validationResult = tableWillBeCreated
        ? { warnings: [] }
        : await api.jobs.validate({ name: targetName, config: payload }, { signal: submission.signal });
      if (!submission.isCurrent()) return;
      const warnings = validationResult?.warnings || [];
      const approvalKey = JSON.stringify({ name: targetName, payload });
      if (warnings.length && warningApprovalKey !== approvalKey) {
        setValidationWarnings(warnings);
        setWarningApprovalKey(approvalKey);
        return;
      }
      setValidationWarnings([]);
      if (editing) await api.jobs.update(targetName, { ...payload, revision: editJob.revision }, { signal: submission.signal }); else await api.jobs.create(targetName, payload, { signal: submission.signal });
      if (!submission.isCurrent()) return;
      await app.refresh({ signal: submission.signal });
      if (!submission.isCurrent()) return;
      app.go(`/jobs/${encodeURIComponent(targetName)}`); navigate(`/jobs/${encodeURIComponent(targetName)}`);
    } catch (failure) {
      if (!submission.isCurrent() || failure?.name === "AbortError") return;
      if (failure?.code === "JOB_CONFLICT") {
        if (!editing) { app.notify(failure); return; }
        if (currentEditName.current !== targetName) return;
        const latest = await loaded.reload({ signal: submission.signal });
        if (latest.status === "aborted" || !submission.isCurrent() || currentEditName.current !== targetName) return;
        const latestJob = latest.status === "success" ? latest.data?.[2] : null;
        if (latestJob?.name === targetName) {
          setName(latestJob.name);
          setConfig(hydrateJobConfig({ ...DEFAULT_CONFIG, ...latestJob.config }));
          app.notify("Another user saved this Job. The latest setting was reloaded. Review and save again.");
        } else app.notify("Another user saved this Job. The latest setting could not be reloaded. Refresh and try again.");
      } else app.notify(failure);
    } finally {
      submission.finish();
    }
  };
  const testCall = async (call, selectedMethod) => {
    const mutation = beginTestCall();
    try {
      const result = await api.dbus.call({ interfaceId: call.interfaceId, methodId: call.methodId, inputs: call.inputs }, { signal: mutation.signal });
      if (mutation.isCurrent()) setTestResult({ ...result, callId: call.id });
    } catch (failure) {
      if (mutation.isCurrent() && failure?.name !== "AbortError") {
        setTestResult(null);
        app.notify(failure);
      }
    } finally {
      mutation.finish();
    }
  };
  const servers = loaded.data?.[1] || [];
  const tableNames = tables.map((table) => String(table.name || table));
  const selectedTableKnown = tableNames.some((table) => table.toUpperCase() === String(activeDatabase.table || '').toUpperCase());
  const tableWillBeCreated = Boolean(activeDatabase.server && activeDatabase.table && !selectedTableKnown);
  const columnSelectionDisabled = !activeDatabase.server || !activeDatabase.table || tableWillBeCreated;
  const dataColumns = columns.filter((column) => !column.primaryKey && !column.basetime && !column.metadata);
  const numericColumns = dataColumns.filter((column) => column.numeric || column.kind === "value");
  const stringColumns = dataColumns.filter((column) => column.string || column.kind === "string-value");
  const loadedEditJob = loaded.data?.[2];
  const editRoutePending = editing && (loaded.loading || app.settingsLoading || loadedEditJob?.name !== params.name);
  const editReady = !editing || !editRoutePending;
  const editJob = editReady ? loadedEditJob : null;
  const editBlocked = editing && (!editReady || !editJob || editJob.statusKnown !== true
    || editJob.executionState === "running" || ["RUNNING", "STARTING", "STOPPING"].includes(editJob.controllerState));
  const editBlockMessage = !editBlocked || !editJob ? "" : editJob.statusKnown !== true
    ? "Job status is unknown. Refresh the page after the controller is available."
    : "Stop this Job before editing, then refresh the page.";
  const formBlocked = formMode === "blocked" || editBlocked;
  return <main className="neo-main neo-main--job-form" aria-label="DBus Collector main"><MainHeader title={editing ? `Edit ${params.name}` : "New Job"} onBack={() => navigate(-1)}><button className="neo-button neo-button--primary" type="submit" form="job-form" disabled={formBlocked} title={editBlockMessage || undefined}>{editing ? "Save" : "Create"}</button></MainHeader>
    {loaded.loading || app.settingsLoading ? <p className="neo-message" aria-live="polite">Loading form…</p> : null}<Notice error={loaded.error || app.settingsError} /><Notice status>{editBlockMessage}</Notice>{errors.length ? <div className="neo-message neo-message--error" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}</div> : null}{validationWarnings.length ? <div className="neo-message neo-message--warning" role="status"><p>Validation warnings found. Review them, then press {editing ? "Save" : "Create"} again to continue.</p>{validationWarnings.map((warning) => <p key={`${warning.code}-${JSON.stringify(warning.details || {})}`}>{warning.code}: {[...(warning.details?.jobs || []), ...(warning.details?.tags || [])].join(", ")}</p>)}</div> : null}
    <form id="job-form" className="neo-page-body" onSubmit={save}>
      <fieldset className="neo-form-lock" aria-label="Job editing controls" disabled={formBlocked}>
      <section className="neo-panel neo-job-section-panel">
        <JobSectionSummary className="neo-job-configuration-summary" label="JOB CONFIGURATION" items={[
          { label: "JOB NAME", value: name || "—" },
          { label: "RUN INTERVAL", value: `${config.schedule.intervalMs} ms` },
          { label: "SAVE POLICY", value: config.execution.savePolicy },
        ]} onEdit={openJobConfiguration} />
      </section>
      <section className="neo-panel neo-job-section-panel">
        <JobSectionSummary className="neo-database-summary" label="DATABASE" items={[
          { label: "DATABASE SERVER", value: config.database.server || "—" },
          { label: "TABLE", value: config.database.table || "—" },
        ]} onEdit={provider?.jobMode === "fixed" ? null : openDatabase} />
      </section>
      {jobConfigurationModalOpen && jobConfigurationDraft ? <Modal title="Edit Job Configuration" variant="job-section-editor" onClose={cancelJobConfiguration}>
        <div className="neo-form-grid"><Field label="Job Name"><Input maxLength={100} value={jobConfigurationDraft.name} readOnly={editing} disabled={editing} onChange={(value) => { nameEdited.current = true; setJobConfigurationDraft((current) => ({ ...current, name: value.toLowerCase() })); }} /></Field><Field label="Run Interval (ms)"><NumberStepper label="Run Interval (ms)" min={intervalCycleMs} step={intervalCycleMs} value={jobConfigurationDraft.schedule.intervalMs} onChange={(value) => setJobConfigurationDraft((current) => ({ ...current, schedule: { ...current.schedule, intervalMs: Number(value) } }))} onBlur={(value) => setJobConfigurationDraft((current) => ({ ...current, schedule: { ...current.schedule, intervalMs: normalizeInterval(value) } }))} nextValue={nextInterval} previousValue={previousInterval} /></Field>{productRetryConfigurable ? <><Field label="Retry Initial (ms)"><Input type="number" value={jobConfigurationDraft.retry.initialDelayMs} onChange={(value) => setJobConfigurationDraft((current) => ({ ...current, retry: { ...current.retry, initialDelayMs: Number(value) } }))} /></Field><Field label="Retry Maximum (ms)"><Input type="number" value={jobConfigurationDraft.retry.maximumDelayMs} onChange={(value) => setJobConfigurationDraft((current) => ({ ...current, retry: { ...current.retry, maximumDelayMs: Number(value) } }))} /></Field><Field label="Retry Multiplier"><Input type="number" value={jobConfigurationDraft.retry.multiplier} onChange={(value) => setJobConfigurationDraft((current) => ({ ...current, retry: { ...current.retry, multiplier: Number(value) } }))} /></Field></> : null}<Field label="Save Policy"><select value={jobConfigurationDraft.execution.savePolicy} onChange={(event) => setJobConfigurationDraft((current) => ({ ...current, execution: { ...current.execution, savePolicy: event.target.value } }))}><option value="perMethod">perMethod</option><option value="afterAllMethods">afterAllMethods</option></select></Field></div>
        <footer className="neo-modal__footer"><button type="button" className="neo-button" onClick={cancelJobConfiguration}>Cancel</button><button type="button" className="neo-button neo-button--primary" onClick={applyJobConfiguration}>Apply</button></footer>
      </Modal> : null}
      {databaseModalOpen && databaseDraft ? <Modal title="Edit Database" variant="job-section-editor" onClose={cancelDatabase}>
          <div className="neo-form-grid neo-job-database-editor">
          <Field label="Database Server">
            <div className="neo-select-action">
              <select value={databaseDraft.server} onChange={(event) => {
                setTableListOpen(false);
                setDatabaseDraft((current) => ({ ...current, server: event.target.value, table: "", valueColumn: "", stringValueColumn: "" }));
              }}>
                <option value="">Select server</option>{servers.map((server) => <option value={server.name} key={server.name}>{server.name}</option>)}
              </select>
              <IconButton icon="add" label="Manage Database Servers" onClick={() => app.openCreateModal("db-server")} />
            </div>
          </Field>
          <Field label="Table">
            <div className="neo-combobox">
              <Input placeholder="Select or enter a table..." disabled={!databaseDraft.server} value={databaseDraft.table} onClick={() => setTableListOpen(true)} onChange={(table) => setDatabaseDraft((current) => ({ ...current, table: table.toUpperCase(), valueColumn: "", stringValueColumn: "" }))} />
              <IconButton icon={tableListOpen ? "expand_less" : "expand_more"} label="Toggle table list" disabled={!databaseDraft.server} aria-expanded={tableListOpen} onClick={() => setTableListOpen((open) => !open)} />
              {tableListOpen ? <div className="neo-combobox__list" role="listbox" aria-label="Available tables">
                {tableNames.length ? tableNames.map((table) => <button type="button" role="option" aria-selected={table.toUpperCase() === String(databaseDraft.table).toUpperCase()} key={table} onClick={() => {
                  setTableListOpen(false);
                  setDatabaseDraft((current) => ({ ...current, table: table.toUpperCase(), valueColumn: "", stringValueColumn: "" }));
                }}>{table}</button>) : <p>No tables found.</p>}
              </div> : null}
            </div>
          </Field>
          <Field label="Value Column">
            <ColumnSelect value={databaseDraft.valueColumn} groups={[{ label: "Numeric", columns: numericColumns }]} disabled={columnSelectionDisabled} onChange={(valueColumn) => setDatabaseDraft((current) => ({ ...current, valueColumn }))} />
          </Field>
          <Field label="String Value Column (optional)">
            <ColumnSelect value={databaseDraft.stringValueColumn} groups={[{ label: "String", columns: stringColumns }]} disabled={columnSelectionDisabled} onChange={(stringValueColumn) => setDatabaseDraft((current) => ({ ...current, stringValueColumn }))} />
          </Field>
          </div>
          {tableWillBeCreated ? <p className="neo-table-create-info" role="status"><Icon name="info" />Table not found. It will be created automatically when the job is saved.</p> : null}
          <footer className="neo-modal__footer"><button type="button" className="neo-button" onClick={cancelDatabase}>Cancel</button><button type="button" className="neo-button neo-button--primary" onClick={applyDatabase}>Apply</button></footer>
      </Modal> : null}
      {formMode === "blocked" ? <Notice status>Settings must be loaded before editing Method Calls.</Notice>
        : fixedNewJob ? <FixedProviderCallsEditor calls={config.methodCalls} methodsByInterface={interfaceDetails} provider={provider} testResult={testResult} setCalls={(update) => setConfig((current) => ({ ...current, methodCalls: typeof update === "function" ? update(current.methodCalls) : update }))} onTest={testCall} onClearTest={() => setTestResult(null)} />
          : <MethodCallsEditor calls={config.methodCalls} interfaces={loaded.data?.[0] || []} interfaceDetails={interfaceDetails} testResult={testResult} setCalls={(update) => setConfig((current) => ({ ...current, methodCalls: typeof update === "function" ? update(current.methodCalls) : update }))} onTest={testCall} />}
      {!fixedNewJob && testResult ? <section className="neo-panel"><h2>TEST CALL</h2><div className="neo-summary-grid neo-summary-grid--compact"><Metric label="SUCCESS" value={String(Boolean(testResult.success))} /><Metric label="DURATION" value={`${testResult.durationMs ?? "—"} ms`} /><Metric label="VALUES" value={testResult.valueCount ?? testResult.values?.length ?? 0} /></div><h3>Call result</h3><pre className="neo-code">{JSON.stringify(testResult.values || [], null, 2)}</pre></section> : null}
      </fieldset>
    </form>
  </main>;
}

/* Legacy Profile API UI was replaced by DBus Interface/Method management.
function ProfilesPage() {
  const app = useApp();
  const loaded = useLoad((signal) => Promise.all([api.profiles.list({ signal }), api.settings.get({ signal })]), [app.resourceRevision]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState(createProfileDraft);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [message, setMessage] = useState("");
  useEffect(() => { if (!selected) return; api.profiles.get(selected).then(setDetail, setError); }, [selected]);
  useEffect(() => { if (loaded.data?.[1]) setSettingsDraft(loaded.data[1]); }, [loaded.data]);
  const save = async () => { try { if (editing) await api.profiles.update({ ...draft, builtIn: false }); else await api.profiles.create({ ...draft, builtIn: false }); setEditing(false); setDraft(createProfileDraft()); loaded.reload(); } catch (failure) { setError(failure); } };
  const remove = async () => { try { await api.profiles.remove(detail.profile.id); loaded.reload(); setSelected(""); setDetail(null); } catch (failure) { setError(failure); } };
  const saveSettings = async () => { try { const value = await api.settings.update(settingsDraft); setSettingsDraft(value); setMessage("Settings saved."); } catch (failure) { setError(failure); } };
  const blocked = referencesBlockChanges(detail?.references);
  const referenced = Boolean(detail?.references?.length);
  useEffect(() => {
    if (blocked && editing) { setEditing(false); setDraft(createProfileDraft()); }
  }, [blocked, editing]);
  const profileForm = <section className="neo-panel"><h2>{editing ? "EDIT CUSTOM PROFILE" : "NEW CUSTOM PROFILE"}</h2><div className="neo-form-grid"><Field label="ID"><Input maxLength={100} value={draft.id} readOnly={editing} onChange={(id) => setDraft({ ...draft, id: id.toLowerCase() })} /></Field><Field label="Display Name"><Input value={draft.displayName} onChange={(displayName) => setDraft({ ...draft, displayName })} /></Field><Field label="Vendor"><Input value={draft.vendor} onChange={(vendor) => setDraft({ ...draft, vendor })} /></Field><Field label="Minimum Neo Version"><Input value={draft.compatibility.minNeoVersion} onChange={(minNeoVersion) => setDraft({ ...draft, compatibility: { minNeoVersion } })} /></Field><Field label="Bus Type"><select value={draft.defaults.busType} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, busType: event.target.value } })}><option value="system">system</option><option value="session">session</option></select></Field><Field label="Destination"><Input value={draft.defaults.destination} onChange={(destination) => setDraft({ ...draft, defaults: { ...draft.defaults, destination } })} /></Field></div><span className="neo-actions"><button className="neo-button neo-button--primary" disabled={editing && blocked} onClick={save}>{editing ? "Save Profile" : "Create Profile"}</button>{editing ? <button className="neo-button" onClick={() => { setEditing(false); setDraft(createProfileDraft()); }}>Cancel</button> : null}</span></section>;
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title="Profiles" subtitle="Built-in profiles are read-only." /><Notice error={loaded.error || error} /><Notice status>{message}</Notice><div className="neo-page-body neo-management">
    {settingsDraft ? <section className="neo-panel"><h2>SETTINGS</h2><div className="neo-form-grid"><Field label="Max Generated Tags"><Input aria-label="Max Generated Tags" type="number" value={settingsDraft.limits.maxGeneratedTagsPerCall} onChange={(value) => setSettingsDraft({ ...settingsDraft, limits: { ...settingsDraft.limits, maxGeneratedTagsPerCall: Number(value) } })} /></Field><Field label="Max Buffered Rows"><Input aria-label="Max Buffered Rows" type="number" value={settingsDraft.limits.maxBufferedRowsPerCycle} onChange={(value) => setSettingsDraft({ ...settingsDraft, limits: { ...settingsDraft.limits, maxBufferedRowsPerCycle: Number(value) } })} /></Field></div><button className="neo-button neo-button--primary" onClick={saveSettings}>Save Settings</button></section> : null}
    <section className="neo-panel"><h2>PROFILE LIST</h2><table><thead><tr><th>Name</th><th>Vendor</th><th>Type</th><th>Version</th><th>Neo</th><th>Methods</th></tr></thead><tbody>{(loaded.data?.[0] || []).map((profile) => <tr key={profile.id}><td><button className="neo-link-button" onClick={() => setSelected(profile.id)}>{profile.displayName}</button>{profile.default ? <small> DEFAULT</small> : null}</td><td>{profile.vendor}</td><td>{profile.builtIn ? "Built-in" : "Custom"}</td><td>{profile.profileVersion}</td><td>{profile.compatible ? "Compatible" : profile.compatibilityReason}</td><td>{profile.methodCount}</td></tr>)}</tbody></table></section>
    {detail ? <section className="neo-panel"><div className="neo-panel__title"><h2>{detail.profile.displayName}</h2><span className="neo-actions">{detail.profile.builtIn ? "READ ONLY" : <><button className="neo-button" disabled={blocked} title={blocked ? "Running or unknown reference blocks changes." : "Edit Profile"} onClick={() => { setDraft(detail.profile); setEditing(true); }}>Edit Profile</button><button className="neo-button neo-button--danger" disabled={referenced} title={referenced ? "Referenced Profiles cannot be deleted." : "Delete Profile"} onClick={remove}>Delete Profile</button></>}</span></div><p>{detail.compatibilityReason || `Compatible with Neo ${detail.profile.compatibility.minNeoVersion}+`}</p><p>Referenced by: {(detail.references || []).map((item) => `${item.name} (${item.controllerState})`).join(", ") || "None"}</p><MethodManager profile={detail.profile} profileBlocked={blocked} onError={setError} reload={() => { api.profiles.get(detail.profile.id).then(setDetail, setError); loaded.reload(); }} /></section> : null}
    {editing ? profileForm : null}</div></main>;
}

function MethodManager({ profile, profileBlocked = false, onError, reload }) {
  const emptyMethod = () => ({ id: "", displayName: "", objectPath: "/", interface: "", methodName: "", inputs: [], output: { decoder: "raw", shape: "scalar" } });
  const [draft, setDraft] = useState(emptyMethod);
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState({});
  useEffect(() => { if (!profile.builtIn) Promise.all(profile.methods.map((method) => api.methods.get(profile.id, method.id))).then((values) => setDetails(Object.fromEntries(values.map((value) => [value.method.id, value]))), onError); }, [profile.id, profile.profileVersion, profile.builtIn]);
  useEffect(() => { if (profileBlocked) { setDraft(emptyMethod()); setEditing(false); } else if (!profile.builtIn && profile.methods[0]) { setDraft(profile.methods[0]); setEditing(true); } }, [profile.id, profile.profileVersion, profile.builtIn, profileBlocked]);
  if (profile.builtIn) return <table><thead><tr><th>Method</th><th>DBus member</th></tr></thead><tbody>{profile.methods.map((method) => <tr key={method.id}><td>{method.displayName}</td><td className="neo-mono">{method.interface}.{method.methodName}</td></tr>)}</tbody></table>;
  const save = async () => { if (profileBlocked) return; try { const method = serializeMethodDraft(draft); if (editing && profile.methods.some((item) => item.id === method.id)) await api.methods.update(profile.id, method); else await api.methods.create(profile.id, method); setEditing(false); setDraft(emptyMethod()); reload(); } catch (failure) { onError(failure); } };
  const remove = async (id) => { try { await api.methods.remove(profile.id, id); reload(); } catch (failure) { onError(failure); } };
  const blocked = (id) => (details[id]?.references || []).some((reference) => ["RUNNING", "STARTING", "STOPPING", "UNKNOWN"].includes(reference.controllerState));
  const referenced = (id) => Boolean((details[id]?.references || []).length);
  const updateInput = (index, patch) => setDraft({ ...draft, inputs: draft.inputs.map((input, inputIndex) => inputIndex === index ? { ...input, ...patch } : input) });
  const successType = successValueType(draft.output.success?.value);
  const updateSuccessValue = (value) => setDraft({
    ...draft,
    output: {
      ...draft.output,
      success: { ...(draft.output.success || { path: "result", operator: "equals" }), value },
    },
  });
  return <><h3>Methods</h3><p role="status">Confirm that custom Method calls are safe to repeat.</p>{profile.methods.map((method) => <div className="neo-list-row" key={method.id}><span>{method.displayName} {(details[method.id]?.references || []).map((reference) => `${reference.name} (${reference.controllerState})`).join(", ")}</span><span className="neo-actions"><button className="neo-button" disabled={profileBlocked || blocked(method.id)} onClick={() => { setDraft(details[method.id]?.method || method); setEditing(true); }}>Edit Method</button><button className="neo-button neo-button--danger" disabled={profileBlocked || referenced(method.id)} onClick={() => remove(method.id)}>Delete Method</button></span></div>)}
    <div className="neo-form-grid"><Field label="Method ID"><Input value={draft.id} readOnly={editing && profile.methods.some((item) => item.id === draft.id)} onChange={(id) => setDraft({ ...draft, id: id.toLowerCase() })} /></Field><Field label="Display Name"><Input value={draft.displayName} onChange={(displayName) => setDraft({ ...draft, displayName })} /></Field><Field label="Object Path"><Input value={draft.objectPath} onChange={(objectPath) => setDraft({ ...draft, objectPath })} /></Field><Field label="Interface"><Input value={draft.interface} onChange={(value) => setDraft({ ...draft, interface: value })} /></Field><Field label="Method Name"><Input value={draft.methodName} onChange={(methodName) => setDraft({ ...draft, methodName })} /></Field></div>
    <h3>Inputs</h3>{draft.inputs.map((input, index) => <div className="neo-method-input" key={`${input.id}-${index}`}><Input aria-label="Method input ID" value={input.id} onChange={(id) => updateInput(index, { id })} /><Input aria-label="Method input type" value={dbusTypeText(input.type)} onChange={(text) => updateInput(index, { type: parseDbusTypeText(text, input.type) })} /><label><input type="checkbox" checked={input.required} onChange={(event) => updateInput(index, { required: event.target.checked })} /> Required</label><Input aria-label="Input minimum" value={input.validation?.minimum ?? ""} onChange={(minimum) => updateInput(index, { validation: { ...input.validation, minimum: ["uint64", "int64"].includes(input.type) ? minimum : Number(minimum) } })} /><Input aria-label="Input maximum" value={input.validation?.maximum ?? ""} onChange={(maximum) => updateInput(index, { validation: { ...input.validation, maximum: ["uint64", "int64"].includes(input.type) ? maximum : Number(maximum) } })} /><Input aria-label="Input pattern" value={input.validation?.pattern ?? ""} onChange={(pattern) => updateInput(index, { validation: { ...input.validation, pattern } })} /><IconButton icon="delete" label={`Remove input ${input.id}`} onClick={() => setDraft({ ...draft, inputs: draft.inputs.filter((_, inputIndex) => inputIndex !== index) })} /></div>)}<button className="neo-button" onClick={() => setDraft({ ...draft, inputs: [...draft.inputs, { id: `input${draft.inputs.length + 1}`, type: "string", required: true }] })}>Add Input</button>
    <h3>Output</h3><div className="neo-form-grid"><Field label="Decoder"><select value={draft.output.decoder} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, decoder: event.target.value } })}><option value="raw">raw</option><option value="json">json</option></select></Field><Field label="Shape"><select value={draft.output.shape} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, shape: event.target.value } })}><option value="scalar">scalar</option><option value="array">array</option><option value="object">object</option></select></Field><Field label="Path"><Input value={draft.output.path || ""} onChange={(path) => setDraft({ ...draft, output: { ...draft.output, path } })} /></Field><Field label="Returned Count Path"><Input value={draft.output.returnedCountPath || ""} onChange={(returnedCountPath) => setDraft({ ...draft, output: { ...draft.output, returnedCountPath } })} /></Field><Field label="Expected Count Input"><select value={draft.output.expectedCount?.inputId || ""} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, expectedCount: event.target.value ? { source: "input", inputId: event.target.value } : undefined } })}><option value="">None</option>{draft.inputs.map((input) => <option key={input.id}>{input.id}</option>)}</select></Field><Field label="Success Path"><Input value={draft.output.success?.path || ""} onChange={(path) => setDraft({ ...draft, output: { ...draft.output, success: path ? { path, operator: "equals", value: draft.output.success?.value ?? 1 } : undefined } })} /></Field><Field label="Success Value Type"><select aria-label="Success value type" value={successType} onChange={(event) => { const type = event.target.value; updateSuccessValue(parseSuccessValue(type, type === "number" ? "0" : type === "boolean" ? "true" : "")); }}><option value="number">number</option><option value="boolean">boolean</option><option value="string">string</option><option value="null">null</option></select></Field><Field label="Success Value">{successType === "boolean" ? <select aria-label="Success Value" value={String(draft.output.success?.value)} onChange={(event) => updateSuccessValue(parseSuccessValue("boolean", event.target.value))}><option value="true">true</option><option value="false">false</option></select> : <Input aria-label="Success Value" type={successType === "number" ? "number" : "text"} readOnly={successType === "null"} value={successType === "null" ? "null" : draft.output.success?.value ?? ""} onChange={(value) => updateSuccessValue(parseSuccessValue(successType, value))} />}</Field></div>
    <h3>LS Tag Generation (optional)</h3><div className="neo-form-grid"><Field label="Capability"><select value={draft.tagGeneration?.capability || ""} onChange={(event) => setDraft({ ...draft, tagGeneration: event.target.value ? { capability: event.target.value, countInputId: draft.inputs[0]?.id || "", addressInputId: draft.inputs[1]?.id || "" } : undefined })}><option value="">None</option><option value="ls-get-device-data">ls-get-device-data</option></select></Field>{draft.tagGeneration ? <><Field label="Count Input"><select value={draft.tagGeneration.countInputId} onChange={(event) => setDraft({ ...draft, tagGeneration: { ...draft.tagGeneration, countInputId: event.target.value } })}>{draft.inputs.map((input) => <option key={input.id}>{input.id}</option>)}</select></Field><Field label="Address Input"><select value={draft.tagGeneration.addressInputId} onChange={(event) => setDraft({ ...draft, tagGeneration: { ...draft.tagGeneration, addressInputId: event.target.value } })}>{draft.inputs.map((input) => <option key={input.id}>{input.id}</option>)}</select></Field></> : null}</div>
    <span className="neo-actions"><button className="neo-button" disabled={profileBlocked} onClick={save}>{editing ? "Save Method" : "Add Method"}</button><button className="neo-button" disabled={profileBlocked} onClick={() => { setEditing(false); setDraft(emptyMethod()); }}>New Method</button></span></>;
}
*/

function DbServersPage() {
  const app = useApp();
  const loaded = useLoad((signal) => api.db.servers.list({ signal }), [app.resourceRevision]);
  const [draft, setDraft] = useState({ name: "", host: "127.0.0.1", port: 5656, user: "", password: "", database: "" });
  const [editing, setEditing] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(null);
  const [tableDraft, setTableDraft] = useState({ server: "", table: "", valueColumn: "VALUE", stringValueColumn: "" });
  const [tables, setTables] = useState([]);
  const save = async () => { try { if (editing) await api.db.servers.update(editing, draft); else await api.db.servers.create(draft); setDraft({ name: "", host: "127.0.0.1", port: 5656, user: "", password: "", database: "" }); setEditing(""); loaded.reload(); } catch (failure) { setError(failure); } };
  const test = async (name) => { try { await api.db.connect(name); setMessage(`Connection to ${name} succeeded.`); } catch (failure) { setError(failure); } };
  const loadTables = async (server) => { if (!server) { setTables([]); return; } try { const values = await api.db.tables.list({ server }); setTables(values.tables || values || []); } catch (failure) { setError(failure); } };
  const createTable = async () => { try { await api.db.tables.create(tableDraft); setMessage(`${tableDraft.table} created.`); await loadTables(tableDraft.server); } catch (failure) { setError(failure); } };
  const fieldsComplete = [draft.name, draft.host, draft.port, draft.user, draft.password].every((value) => String(value ?? "").trim());
  const serverForm = <section className="neo-panel"><h2>{editing ? `EDIT ${editing}` : "NEW SERVER"}</h2><div className="neo-form-grid">{Object.entries(draft).filter(([key]) => key !== "database").map(([key, value]) => <Field label={key.toUpperCase()} key={key}><Input type={key === "password" ? "password" : key === "port" ? "number" : "text"} value={value} readOnly={editing && key === "name"} onChange={(next) => setDraft({ ...draft, [key]: key === "port" ? Number(next) : next })} /></Field>)}</div><button className="neo-button neo-button--primary" disabled={!fieldsComplete} onClick={save}>{editing ? "Save" : "Create"}</button></section>;
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title="Database Servers" subtitle="Passwords are write-only." /><Notice error={loaded.error || error} /><Notice status>{message}</Notice><div className="neo-page-body"><section className="neo-panel"><h2>REGISTERED DATABASE SERVERS</h2>{(loaded.data || []).map((server) => <div className="neo-list-row" key={server.name}><span><strong>{server.name}</strong> {server.host}:{server.port}</span><span className="neo-actions"><button className="neo-button" onClick={() => { setEditing(server.name); setDraft({ ...server, password: "" }); }}>Edit</button><button className="neo-button" onClick={() => test(server.name)}>Test Connection</button><button className="neo-button neo-button--danger" onClick={() => api.db.servers.remove(server.name).then(loaded.reload, setError)}>Delete</button></span></div>)}</section>{editing ? serverForm : null}<section className="neo-panel"><h2>CREATE TAG TABLE</h2><div className="neo-form-grid"><Field label="Server"><select aria-label="Table server" value={tableDraft.server} onChange={(event) => { const server = event.target.value; setTableDraft({ ...tableDraft, server }); void loadTables(server); }}><option value="">Select server</option>{(loaded.data || []).map((server) => <option key={server.name}>{server.name}</option>)}</select></Field><Field label="Table Name"><Input aria-label="Table name" value={tableDraft.table} onChange={(table) => setTableDraft({ ...tableDraft, table })} /></Field><Field label="Value Column"><Input aria-label="Value column" value={tableDraft.valueColumn} onChange={(valueColumn) => setTableDraft({ ...tableDraft, valueColumn })} /></Field><Field label="String Value Column"><Input aria-label="String value column" value={tableDraft.stringValueColumn} onChange={(stringValueColumn) => setTableDraft({ ...tableDraft, stringValueColumn })} /></Field></div><button className="neo-button neo-button--primary" disabled={!tableDraft.server || !tableDraft.table || !tableDraft.valueColumn} onClick={createTable}>Create TAG Table</button><p>Tables: {tables.map((table) => table.name || table).join(", ") || "None"}</p></section></div></main>;
}

function CreateModalLayer() {
  const app = useApp();
  if (app.createModal === "dbus-interface") return <DbusInterfacesModal />;
  if (app.createModal === "db-server") return <DatabaseServersModal />;
  return null;
}

function DbusInterfaceDeleteConfirmModal({ item, references, onCancel, onConfirm }) {
  const blocked = item?.builtIn || references.length > 0;
  return <div className="neo-modal neo-modal--confirm" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="neo-modal__dialog neo-modal__dialog--dbus-interface-confirm" role="dialog" aria-modal="true" aria-label="Delete DBus Interface"><header className="neo-modal__header"><div className="neo-modal__title"><Icon name="warning" /><h2>Delete DBus Interface</h2></div><IconButton className="neo-modal__close" icon="close" label="Close" onClick={onCancel} /></header><div className="neo-modal__body"><p>Are you sure you want to delete DBus Interface &quot;{item.interface}&quot;?</p></div><footer className="neo-modal__footer"><button className="neo-button" onClick={onCancel}>Cancel</button><button className="neo-button neo-button--danger" disabled={blocked} onClick={onConfirm}>Delete</button></footer></section></div>;
}

function interfaceDeleteBlockReason(value) {
  if (!value?.interface) return "DBus Interface detail could not be loaded, so it cannot be deleted.";
  if (value.interface.builtIn) return "Built-in DBus Interfaces cannot be deleted.";
  if (value.references?.length) return `Referenced by ${value.references.map((reference) => reference.name).join(", ")}. This DBus Interface cannot be deleted.`;
  return "";
}

function DbusInterfaceFormModal({ editing, initialValue, references = [], onSaved, onCancel, readOnly = false, runApi = (operation) => operation() }) {
  const [draft, setDraft] = useState(() => ({ schemaVersion: 1, id: initialValue?.id || "", name: initialValue?.name || initialValue?.interface || "", busType: initialValue?.busType || "system", destination: initialValue?.destination || "", objectPath: initialValue?.objectPath || "", interface: initialValue?.interface || "", methods: initialValue?.methods || [], origin: initialValue?.origin }));
  const [discovered, setDiscovered] = useState([]);
  const [selectedDiscoveredId, setSelectedDiscoveredId] = useState("");
  const [manualEntry, setManualEntry] = useState(Boolean(editing && initialValue?.origin === "manual"));
  const [methodsOpen, setMethodsOpen] = useState(false);
  const [error, setError] = useState(null);
  const applyDiscovered = (selected) => {
    setSelectedDiscoveredId(selected.id);
    setManualEntry(false);
    setDraft((current) => ({ ...selected, id: editing ? current.id : "", name: editing ? current.name : current.name || selected.name || selected.interface, origin: "discovered" }));
  };
  const discover = async ({ selectStored = false } = {}) => {
    if (readOnly || references.length) return;
    try {
      const found = await runApi((signal) => api.interfaces.discover({ busType: draft.busType, destination: draft.destination, objectPath: draft.objectPath }, { signal }));
      const sorted = [...found].sort((left, right) => {
        const leftStandard = left.interface?.startsWith("org.freedesktop.") ? 1 : 0;
        const rightStandard = right.interface?.startsWith("org.freedesktop.") ? 1 : 0;
        return leftStandard - rightStandard || String(left.interface).localeCompare(String(right.interface));
      });
      setDiscovered(sorted);
      const keepManual = manualEntry || (selectStored && initialValue?.origin === "manual");
      const selected = keepManual
        ? null
        : selectStored
          ? sorted.find((item) => item.interface === initialValue?.interface)
          : sorted.find((item) => item.id === selectedDiscoveredId) || (!selectedDiscoveredId ? sorted[0] : null);
      if (keepManual) {
        setSelectedDiscoveredId("__manual__");
        setManualEntry(true);
      } else if (selected) applyDiscovered(selected);
      else {
        setSelectedDiscoveredId("");
        setManualEntry(false);
      }
      setError(null);
    } catch (failure) { setError(failure); }
  };
  useEffect(() => {
    if (editing && !readOnly && !references.length) void discover({ selectStored: true });
  }, []);
  const selectDiscovered = (id) => {
    if (id === "__manual__") { setSelectedDiscoveredId(id); setManualEntry(true); setDraft((current) => current.origin === "discovered" ? { ...current, interface: "", methods: [], origin: "manual" } : { ...current, origin: "manual" }); setError(null); return; }
    const selected = discovered.find((item) => item.id === id);
    if (!selected) return;
    applyDiscovered(selected);
    setError(null);
  };
  const save = async () => {
    if (readOnly) return;
    try {
      const origin = selectedDiscoveredId && !manualEntry ? "discovered" : (editing ? draft.origin : "manual");
      const value = { ...draft, origin, methods: (draft.methods || []).map((method) => ({ ...method, source: selectedDiscoveredId && !manualEntry ? "discovered" : method.source || "manual" })) };
      let result;
      if (editing) result = await runApi((signal) => (selectedDiscoveredId && !manualEntry ? api.interfaces.updateDiscovered : api.interfaces.update)(value, { signal }));
      else { const { id, ...creating } = value; result = await runApi((signal) => api.interfaces.create(creating, { signal })); }
      await onSaved(result);
    } catch (failure) { setError(failure); }
  };
  const directValid = [draft.name, draft.destination, draft.objectPath, draft.interface].every((value) => String(value || "").trim());
  const selectedDiscovered = !manualEntry && discovered.find((item) => item.id === selectedDiscoveredId);
  const storedDiscovered = Boolean(editing && draft.origin === "discovered");
  const connectionLocked = Boolean(readOnly || references.length);
  const canOpenMethods = Boolean(readOnly || manualEntry || selectedDiscovered || storedDiscovered);
  const methodsEditable = !connectionLocked && manualEntry && draft.origin === "manual";
  const refreshPersistedMethods = async () => {
    const detail = await runApi((signal) => api.interfaces.get(draft.id, { signal }));
    setDraft((current) => ({ ...current, methods: detail.interface.methods || [] }));
  };
  return <><Modal title={readOnly ? "View DBus Interface" : editing ? "Edit DBus Interface" : "Add DBus Interface"} icon={editing ? "edit" : "add_circle"} variant="dbus-interface-form" onClose={onCancel} escapeDisabled={methodsOpen}><Notice error={error} /><div className="neo-dbus-interface-form"><div className="neo-form-grid"><Field label="Name"><Input value={draft.name} disabled={readOnly} onChange={(name) => setDraft({ ...draft, name })} /></Field><Field label="Bus Type"><select value={draft.busType} disabled={connectionLocked} onChange={(event) => setDraft({ ...draft, busType: event.target.value })}><option value="system">system</option><option value="session">session</option></select></Field><Field label="Destination"><Input value={draft.destination} disabled={connectionLocked} onChange={(destination) => setDraft({ ...draft, destination })} /></Field><Field label="Object Path"><Input value={draft.objectPath} disabled={connectionLocked} onChange={(objectPath) => setDraft({ ...draft, objectPath })} /></Field></div><button className="neo-button" type="button" disabled={connectionLocked} onClick={discover}>Discover</button>{!readOnly && discovered.length > 0 ? <Field label="Discovered Interface"><select aria-label="Discovered Interface" value={selectedDiscoveredId} disabled={connectionLocked} onChange={(event) => selectDiscovered(event.target.value)}><option value="">Select discovered Interface</option>{discovered.map((item) => <option key={item.id} value={item.id}>{item.interface}{item.interface?.startsWith("org.freedesktop.") ? " (Standard)" : ""}</option>)}<option value="__manual__">Direct input</option></select></Field> : null}{manualEntry ? <Field label="Interface"><Input value={draft.interface} disabled={connectionLocked} onChange={(dbusInterface) => setDraft({ ...draft, interface: dbusInterface })} /></Field> : null}{canOpenMethods ? <button className="neo-button" type="button" onClick={() => setMethodsOpen(true)}>Methods ({draft.methods?.length || 0})</button> : null}</div><footer className="neo-modal__footer"><button className="neo-button" onClick={onCancel}>Cancel</button><button className="neo-button neo-button--primary" disabled={readOnly || !directValid} onClick={save}>{editing ? "Update Interface" : "Create Interface"}</button></footer></Modal>{methodsOpen ? <DbusMethodModal item={draft} editable={methodsEditable} persisted={Boolean(editing)} references={references} onDraftMethodsChange={(methods) => setDraft((current) => ({ ...current, methods }))} onChanged={refreshPersistedMethods} onError={setError} runApi={runApi} onClose={() => setMethodsOpen(false)} /> : null}</>;
}

const emptyDbusMethod = () => ({ id: "", member: "", source: "manual", inputs: [], outputs: [] });
function dbusTypeLabel(type) {
  if (typeof type === "string") return type;
  if (!type || typeof type !== "object") return "invalid";
  if (type.type === "array") return `array<${dbusTypeLabel(type.element)}>`;
  if (type.type === "dict-entry") return `dict-entry<${dbusTypeLabel(type.key)}, ${dbusTypeLabel(type.value)}>`;
  if (type.type === "struct") return `struct<${(type.fields || []).map(dbusTypeLabel).join(", ")}>`;
  return "invalid";
}
function dbusTypeText(type) { return typeof type === "string" ? type : JSON.stringify(type); }
function parseDbusTypeText(value, fallback) {
  const text = String(value || "").trim();
  if (!text.startsWith("{")) return text;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}
function isComplexDbusType(type) { return typeof type === "object" || type === "variant" || type === "unix-fd"; }
function dbusInputEditor(input, value, onChange) {
  if (input.type === "boolean") return <select value={String(Boolean(value))} onChange={(event) => onChange(event.target.value === "true")}><option value="true">true</option><option value="false">false</option></select>;
  if (isComplexDbusType(input.type)) return <Input type="text" value={typeof value === "string" ? value : JSON.stringify(value ?? (Array.isArray(input.type?.fields) ? [] : {}))} onChange={(text) => { try { onChange(JSON.parse(text)); } catch (_) { onChange(text); } }} />;
  const numeric = ["byte", "int16", "uint16", "int32", "uint32", "double"].includes(input.type);
  const text = ["uint64", "int64"].includes(input.type) || !numeric;
  return <Input type={text ? "text" : "number"} value={value} onChange={(next) => onChange(text ? next : Number(next))} />;
}
function referencesForMethod(references, methodId) { return references.filter((reference) => reference.invalidConfig || reference.methodIds?.includes(methodId)); }
function parameterValidationText(validation) { return Object.entries(validation || {}).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`).join(", "); }
function DbusMethodBadge({ children, tone = "neutral" }) { return <span className={`neo-dbus-method-badge neo-dbus-method-badge--${tone}`}>{children}</span>; }
function DbusMethodSourceBadge({ source }) { return <DbusMethodBadge>{source === "discovered" ? "Discovered" : "Manual"}</DbusMethodBadge>; }
function DbusMethodParameters({ title, parameters = [] }) {
  return <section className="neo-dbus-method-card__parameters"><h4>{title}</h4>{parameters.length ? <ul>{parameters.map((parameter, index) => { const validation = parameterValidationText(parameter.validation); const required = parameter.required === false ? "Optional" : "Required"; return <li key={`${title}-${parameter.name}-${index}`}><span>{parameter.name}: {dbusTypeLabel(parameter.type)}</span><DbusMethodBadge tone={parameter.required === false ? "optional" : "required"}>{required}</DbusMethodBadge>{validation ? <small>{validation}</small> : null}</li>; })}</ul> : <p>None</p>}</section>;
}
function DbusMethodReadOnlyDetails({ method }) {
  return <div className="neo-dbus-method-card__details"><DbusMethodParameters title="Inputs" parameters={method.inputs || []} /><DbusMethodParameters title="Outputs" parameters={method.outputs || []} /></div>;
}
function DbusInterfaceReferences({ references }) {
  if (!references.length) return null;
  return <section className="neo-dbus-interface-references" aria-label="DBus Interface references"><h4>References</h4>{references.map((reference, index) => <article key={`${reference.name}-${index}`}><strong>{reference.name}</strong><small>documentName: {reference.documentName === null ? "null" : reference.documentName}</small><small>calls: {reference.calls?.length ? reference.calls.join(", ") : "[]"}</small><small>invalidConfig: {String(Boolean(reference.invalidConfig))}</small></article>)}</section>;
}

function DbusMethodModal({ item, editable, persisted, references, onDraftMethodsChange, onChanged, onError, runApi, onClose }) {
  return <Modal title={`Methods (${item.methods?.length || 0})`} ariaLabel="DBus Methods" icon="account_tree" variant="dbus-methods" onClose={onClose}>
    {editable ? <DbusMethodEditor item={item} references={references} onDraftMethodsChange={persisted ? undefined : onDraftMethodsChange} onChanged={onChanged} onError={onError} runApi={runApi} /> : <section className="neo-dbus-method-list neo-dbus-method-list--scroll"><DbusInterfaceReferences references={references} />{(item.methods || []).map((method) => <article className="neo-dbus-method-card" key={method.id}><div><div className="neo-dbus-method-card__title"><strong>{method.member}</strong><DbusMethodSourceBadge source={method.source} /></div><DbusMethodReadOnlyDetails method={method} /></div></article>)}</section>}
  </Modal>;
}

function DbusMethodEditor({ item, references, onChanged, onError, runApi, onDraftMethodsChange }) {
  const [draft, setDraft] = useState(emptyDbusMethod);
  const [editingId, setEditingId] = useState("");
  const invalidReferences = references.filter((reference) => reference.invalidConfig);
  const interfaceBlocked = Boolean(item.builtIn || references.length);
  const methodReferences = (methodId) => referencesForMethod(references, methodId);
  const methodManual = (methodId) => (item.methods || []).find((method) => method.id === methodId)?.source === "manual";
  const methodBlocked = (methodId) => Boolean(item.builtIn || references.length || !methodManual(methodId) || methodReferences(methodId).length);
  const reason = (methodId) => item.builtIn ? "Built-in DBus Interfaces are read-only." : references.length ? `Referenced by ${references.map((reference) => reference.name).join(", ")}.` : methodId && !methodManual(methodId) ? "Discovered Methods are read-only." : methodReferences(methodId).length ? `Referenced by ${methodReferences(methodId).map((reference) => reference.name).join(", ")}.` : !methodId && invalidReferences.length ? `Invalid Job configuration: ${invalidReferences.map((reference) => reference.name).join(", ")}.` : undefined;
  const formBlocked = editingId ? methodBlocked(editingId) : interfaceBlocked;
  useEffect(() => { setDraft(emptyDbusMethod()); setEditingId(""); }, [item.id]);
  const updateParameter = (kind, index, patch) => setDraft((current) => ({ ...current, [kind]: current[kind].map((parameter, parameterIndex) => parameterIndex === index ? { ...parameter, ...patch } : parameter) }));
  const addParameter = (kind) => setDraft((current) => ({ ...current, [kind]: [...current[kind], { name: `${kind.slice(0, -1)}${current[kind].length + 1}`, type: "string" }] }));
  const removeParameter = (kind, index) => setDraft((current) => ({ ...current, [kind]: current[kind].filter((_, parameterIndex) => parameterIndex !== index) }));
  const startEdit = (method) => { if (methodBlocked(method.id)) return; setEditingId(method.id); setDraft({ ...method, inputs: method.inputs || [], outputs: method.outputs || [] }); };
  const reset = () => { setEditingId(""); setDraft(emptyDbusMethod()); };
  const save = async () => {
    if (formBlocked) return;
    try {
      const method = { ...draft, source: "manual" };
      if (onDraftMethodsChange) {
        onDraftMethodsChange(editingId ? item.methods.map((value) => value.id === editingId ? method : value) : [...item.methods, method]);
      } else if (editingId) await runApi((signal) => api.methods.update(item.id, editingId, method, { signal }));
      else await runApi((signal) => api.methods.create(item.id, method, { signal }));
      reset();
      if (!onDraftMethodsChange) await onChanged({ id: item.id });
    } catch (failure) { onError(failure); }
  };
  const remove = async (methodId) => {
    if (methodBlocked(methodId)) return;
    try {
      if (onDraftMethodsChange) onDraftMethodsChange(item.methods.filter((method) => method.id !== methodId));
      else await runApi((signal) => api.methods.remove(item.id, methodId, { signal }));
      if (editingId === methodId) reset();
      if (!onDraftMethodsChange) await onChanged({ id: item.id });
    } catch (failure) { onError(failure); }
  };
  const valid = Boolean(String(draft.id).trim() && String(draft.member).trim());
  return <section className="neo-dbus-method-editor" aria-label="DBus Interface methods">
    <div className="neo-dbus-method-editor__title"><h3>Methods</h3><span>{item.builtIn ? "READ ONLY" : null}</span></div>
    <DbusInterfaceReferences references={references} />
    <div className="neo-dbus-method-list">{(item.methods || []).map((method) => { const methodRefs = methodReferences(method.id); const blocked = methodBlocked(method.id); return <div className="neo-dbus-method-card" key={method.id}><div><div className="neo-dbus-method-card__title"><strong>{method.member}</strong><DbusMethodSourceBadge source={method.source} /></div>{methodRefs.length ? <small>Referenced by: {methodRefs.map((reference) => reference.name).join(", ")}</small> : null}<DbusMethodReadOnlyDetails method={method} /></div>{method.source === "manual" ? <span className="neo-db-server-card__actions"><IconButton className="neo-db-server-card__action" icon="edit" label="Edit Method" disabled={blocked} title={reason(method.id) || "Edit Method"} onClick={() => startEdit(method)} /><IconButton className="neo-db-server-card__action neo-db-server-card__action--danger" icon="delete" label="Delete Method" disabled={blocked} title={reason(method.id) || "Delete Method"} onClick={() => remove(method.id)} /></span> : null}</div>; })}</div>
    <div className="neo-dbus-method-editor__form"><h4>{editingId ? "Edit Method" : "Add Method"}</h4><div className="neo-form-grid"><Field label="Method ID"><Input value={draft.id} readOnly={Boolean(editingId) || item.builtIn} disabled={formBlocked} onChange={(id) => setDraft({ ...draft, id: id.toLowerCase() })} /></Field><Field label="DBus Member"><Input value={draft.member} disabled={formBlocked} onChange={(member) => setDraft({ ...draft, member })} /></Field></div>{["inputs", "outputs"].map((kind) => <section className="neo-dbus-method-editor__parameters" key={kind}><div><h4>{kind === "inputs" ? "Inputs" : "Outputs"}</h4><button className="neo-button" disabled={formBlocked} onClick={() => addParameter(kind)}>Add {kind === "inputs" ? "Input" : "Output"}</button></div>{draft[kind].map((parameter, index) => <div className="neo-dbus-method-parameter" key={`${kind}-${index}`}><Input aria-label={`${kind} parameter name`} value={parameter.name} disabled={formBlocked} onChange={(name) => updateParameter(kind, index, { name })} /><Input aria-label={`${kind} parameter type`} value={dbusTypeText(parameter.type)} disabled={formBlocked} onChange={(text) => updateParameter(kind, index, { type: parseDbusTypeText(text, parameter.type) })} /><IconButton icon="delete" label={`Remove ${kind} parameter ${parameter.name}`} disabled={formBlocked} onClick={() => removeParameter(kind, index)} /></div>)}</section>)}</div>
    <span className="neo-actions"><button className="neo-button neo-button--primary" disabled={formBlocked || !valid} title={editingId ? reason(editingId) : reason()} onClick={save}>{editingId ? "Save Method" : "Add Method"}</button>{editingId ? <button className="neo-button" disabled={formBlocked} onClick={reset}>Cancel</button> : null}</span>
  </section>;
}

function DbusInterfacesModal() {
  const app = useApp();
  const apiQueue = useSerialApiQueue();
  const loaded = useLoad((signal) => apiQueue.run((queueSignal) => api.interfaces.list({ signal: queueSignal }), { signal }), [apiQueue.run]);
  const [selectedId, setSelectedId] = useState("");
  const [details, setDetails] = useState({});
  const [mode, setMode] = useState("list");
  const [formItem, setFormItem] = useState(null);
  const [formReferences, setFormReferences] = useState([]);
  const [pendingDelete, setPendingDelete] = useState("");
  const [error, setError] = useState(null);
  const detailsRef = useRef({});
  detailsRef.current = details;
  const loadDetail = useCallback(async (id, { force = false, throwOnError = false } = {}) => {
    if (!id) return null;
    if (!force && detailsRef.current[id]) return detailsRef.current[id];
    try {
      const value = await apiQueue.run((signal) => (!force && detailsRef.current[id]
        ? detailsRef.current[id]
        : api.interfaces.get(id, { signal })));
      detailsRef.current = { ...detailsRef.current, [id]: value };
      setDetails(detailsRef.current);
      return value;
    } catch (failure) {
      if (failure?.name !== "AbortError") setError(failure);
      if (throwOnError) throw failure;
      return null;
    }
  }, [apiQueue.run]);
  const select = (id) => { setSelectedId(id); setError(null); };
  const openForm = async (id = "") => {
    if (!id) { setFormItem(null); setFormReferences([]); setMode("form"); return; }
    const value = await loadDetail(id, { force: true });
    select(id);
    if (!value) return;
    setFormItem(value.interface);
    setFormReferences(value.references || []);
    setMode("form");
  };
  const requestDelete = async (id) => {
    const value = await loadDetail(id, { force: true });
    select(id);
    const reason = interfaceDeleteBlockReason(value);
    if (reason) { setError({ reason }); return; }
    setPendingDelete(id);
  };
  const remove = async () => {
    const value = detailsRef.current[pendingDelete];
    const reason = interfaceDeleteBlockReason(value);
    if (reason) { setError({ reason }); setPendingDelete(""); return; }
    try {
      await apiQueue.run((signal) => api.interfaces.remove(value.interface.id, { signal }));
      setPendingDelete("");
      setSelectedId("");
      await refreshSelectedInterface("");
    } catch (failure) { setError(failure); }
  };
  const close = () => { apiQueue.cancel(); setMode("list"); app.closeCreateModal(); };
  const cancelForm = useCallback(() => {
    apiQueue.cancel();
    setFormItem(null);
    setFormReferences([]);
    setMode("list");
  }, [apiQueue.cancel]);
  const refreshSelectedInterface = async (id = selectedId) => {
    detailsRef.current = {};
    setDetails({});
    const reloaded = await loaded.reload();
    if (reloaded.status === "error") throw reloaded.error;
    if (reloaded.status !== "success") throw abortError();
    app.resourceChanged();
  };
  const saved = async (result, { keepOpen = false } = {}) => {
    const savedId = result?.id || result?.interfaces?.[0]?.id || formItem?.id || selectedId;
    if (savedId) setSelectedId(savedId);
    await refreshSelectedInterface(savedId);
    if (keepOpen) return;
    setFormItem(null);
    setFormReferences([]);
    setMode("list");
  };
  if (mode === "form") return <DbusInterfaceFormModal editing={Boolean(formItem)} initialValue={formItem} references={formReferences} readOnly={Boolean(formItem?.builtIn)} onSaved={saved} onCancel={cancelForm} runApi={apiQueue.run} />;
  return <><Modal title="DBus Interfaces" icon="account_tree" variant="dbus-interface" onClose={close}><Notice error={loaded.error || error} /><div className="neo-db-server-card-list">{loaded.loading ? <p className="neo-message" aria-live="polite">Loading DBus Interfaces…</p> : null}{!loaded.loading && !(loaded.data || []).length ? <p className="neo-message" role="status">No DBus Interfaces configured.</p> : null}{(loaded.data || []).map((item) => { const selected = item.id === selectedId; return <div className={`neo-db-server-card${selected ? " is-selected" : ""}`} key={item.id}><button className="neo-dbus-interface-card__select" type="button" aria-pressed={selected} onClick={() => select(item.id)}><div className="neo-db-server-card__info"><div className="neo-db-server-card__name"><Icon name="account_tree" /><strong>{item.name || item.interface}</strong>{item.interface?.startsWith("org.freedesktop.") ? <span className="neo-dbus-interface-card__badge">Standard</span> : null}</div><small>{item.interface}</small><small>{item.busType} · {item.destination}</small><small>{item.objectPath} · {item.methodCount} Methods · {item.builtIn ? "Built-in · Read only" : "User"}</small></div></button><span className="neo-db-server-card__actions"><IconButton className="neo-db-server-card__action" icon="edit" label="Edit DBus Interface" title={item.builtIn ? "View DBus Interface" : "Edit DBus Interface"} onClick={() => { void openForm(item.id); }} /><IconButton className="neo-db-server-card__action neo-db-server-card__action--danger" icon="delete" label="Delete DBus Interface" disabled={item.builtIn} title="Delete DBus Interface" onClick={() => { void requestDelete(item.id); }} /></span></div>; })}</div><footer className="neo-modal__footer"><button className="neo-button" onClick={close}>Close</button><button className="neo-button neo-button--primary" onClick={() => { void openForm(); }}><Icon name="add" />Add Interface</button></footer></Modal>{pendingDelete && details[pendingDelete]?.interface ? <DbusInterfaceDeleteConfirmModal item={details[pendingDelete].interface} references={details[pendingDelete].references || []} onCancel={() => setPendingDelete("")} onConfirm={remove} /> : null}</>;
}

/* Legacy Profile creation modal is intentionally not exposed by either product.
function ProfileCreateModal() {
  const app = useApp();
  const [draft, setDraft] = useState(createProfileDraft);
  const [error, setError] = useState(null);
  const save = async () => {
    try {
      await api.profiles.create({ ...draft, builtIn: false });
      app.resourceChanged();
      app.closeCreateModal();
    } catch (failure) { setError(failure); }
  };
  return <Modal title="New Profile" icon="account_tree" variant="profile-form" onClose={app.closeCreateModal}><Notice error={error} /><div className="neo-profile-form"><div className="neo-form-grid"><Field label="ID"><Input maxLength={100} value={draft.id} onChange={(id) => setDraft({ ...draft, id: id.toLowerCase() })} /></Field><Field label="Display Name"><Input value={draft.displayName} onChange={(displayName) => setDraft({ ...draft, displayName })} /></Field><Field label="Vendor"><Input value={draft.vendor} onChange={(vendor) => setDraft({ ...draft, vendor })} /></Field><Field label="Minimum Neo Version"><Input value={draft.compatibility.minNeoVersion} onChange={(minNeoVersion) => setDraft({ ...draft, compatibility: { minNeoVersion } })} /></Field><Field label="Bus Type"><select value={draft.defaults.busType} onChange={(event) => setDraft({ ...draft, defaults: { ...draft.defaults, busType: event.target.value } })}><option value="system">system</option><option value="session">session</option></select></Field><Field label="Destination"><Input value={draft.defaults.destination} onChange={(destination) => setDraft({ ...draft, defaults: { ...draft.defaults, destination } })} /></Field></div></div><footer className="neo-modal__footer"><button className="neo-button" onClick={app.closeCreateModal}>Cancel</button><button className="neo-button neo-button--primary" onClick={save}>Create Profile</button></footer></Modal>;
}
*/

function DatabaseServerDeleteConfirmModal({ name, onCancel, onConfirm }) {
  return <div className="neo-modal neo-modal--confirm" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="neo-modal__dialog neo-modal__dialog--database-confirm" role="dialog" aria-modal="true" aria-label="Delete Server"><header className="neo-modal__header"><div className="neo-modal__title"><Icon name="warning" /><h2>Delete Server</h2></div><IconButton className="neo-modal__close" icon="close" label="Close" onClick={onCancel} /></header><div className="neo-modal__body"><p>Are you sure you want to delete server &quot;{name}&quot;?</p></div><footer className="neo-modal__footer"><button className="neo-button" onClick={onCancel}>Cancel</button><button className="neo-button neo-button--danger" onClick={onConfirm}>Delete</button></footer></section></div>;
}

function DatabaseServersModal() {
  const app = useApp();
  const fixedProvider = app.provider?.jobMode === "fixed";
  const loaded = useLoad((signal) => Promise.all([api.db.servers.list({ signal }), api.settings.get({ signal })]), [app.resourceRevision]);
  const [mode, setMode] = useState("list");
  const [editing, setEditing] = useState("");
  const emptyDraft = { name: "", host: "127.0.0.1", port: 5656, user: "", password: "", defaultTable: "", valueColumn: "", stringValueColumn: "" };
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState(null);
  const [healthResults, setHealthResults] = useState({});
  const [pendingDelete, setPendingDelete] = useState("");
  const [defaultServer, setDefaultServer] = useState("");
  const [defaultTables, setDefaultTables] = useState([]);
  const [defaultColumns, setDefaultColumns] = useState([]);
  const [defaultTablesReady, setDefaultTablesReady] = useState(false);
  const [defaultTableListOpen, setDefaultTableListOpen] = useState(false);
  const resetForm = () => { setMode("list"); setEditing(""); setDraft(emptyDraft); setDefaultTables([]); setDefaultColumns([]); setDefaultTablesReady(false); setDefaultTableListOpen(false); setError(null); };
  const openCreate = () => { setEditing(""); setDraft(emptyDraft); setDefaultTables([]); setDefaultColumns([]); setDefaultTablesReady(false); setError(null); setMode("form"); };
  const openEdit = (server) => { setEditing(server.name); setDraft({ ...server, password: "" }); setError(null); setMode("form"); };
  useEffect(() => { setDefaultServer(loaded.data?.[1]?.defaults?.database?.server || ""); }, [loaded.data]);
  const loadDefaultColumns = async (table) => {
    if (!table) { setDefaultColumns([]); return; }
    try { const result = await api.db.preview.columns({ ...draft, table }); setDefaultColumns(result.columns || []); } catch (failure) { setError(failure); }
  };
  const loadDefaultTables = async () => {
    if (!String(draft.password || "").trim()) {
      setError(new Error("Enter the database password before testing the connection."));
      return;
    }
    try {
      setError(null);
      const result = await api.db.preview.tables(draft);
      const tables = result.tables || [];
      const selectedTable = String(draft.defaultTable || "").toUpperCase();
      setDefaultTables(tables);
      setDefaultTablesReady(true);
      if (selectedTable && tables.some((table) => String(table.name || table).toUpperCase() === selectedTable)) await loadDefaultColumns(selectedTable);
      else setDefaultColumns([]);
      app.notify("Connection successful. Available tables were loaded.", "success");
    } catch (failure) { setError(failure); }
  };
  const setDefault = async (server) => {
    try { const next = await api.settings.update({ ...loaded.data?.[1], defaults: { ...loaded.data?.[1]?.defaults, database: { server } } }); setDefaultServer(next.defaults.database.server); } catch (failure) { setError(failure); }
  };
  const save = async () => {
    try {
      if (editing) {
        try {
          await api.db.servers.update(editing, draft);
        } catch (failure) {
          if (failure?.code !== "LS_DATABASE_RESTART_REQUIRED") throw failure;
          const count = Array.isArray(failure?.details?.jobs) ? failure.details.jobs.length : 0;
          const message = `Saving this database configuration will restart ${count} running job${count === 1 ? "" : "s"}. Pending data will be flushed before restart. Continue?`;
          if (!globalThis.confirm(message)) return;
          await api.db.servers.update(editing, { ...draft, restartRunningJobs: true });
        }
      } else await api.db.servers.create(draft);
      app.resourceChanged();
      resetForm();
    } catch (failure) { setError(failure); }
  };
  const test = async (name) => {
    setHealthResults((previous) => ({ ...previous, [name]: "checking" }));
    try {
      setError(null);
      await api.db.connect(name);
      setHealthResults((previous) => ({ ...previous, [name]: "healthy" }));
    } catch (failure) {
      setHealthResults((previous) => ({ ...previous, [name]: "unhealthy" }));
      setError(failure);
    }
  };
  const remove = async (name) => {
    try { await api.db.servers.remove(name); setPendingDelete(""); app.resourceChanged(); await loaded.reload(); } catch (failure) { setError(failure); }
  };
  const valid = [draft.name, draft.host, draft.port, draft.user, draft.password].every((value) => String(value ?? "").trim());
  const defaultTableKnown = defaultTables.some((table) => String(table.name || table).toUpperCase() === String(draft.defaultTable || "").toUpperCase());
  const defaultColumnSelectionDisabled = !defaultTablesReady || !defaultTableKnown;
  const dataColumns = defaultColumns.filter((column) => !column.primaryKey && !column.basetime && !column.metadata);
  const numericColumns = dataColumns.filter((column) => column.numeric || column.kind === "value");
  const stringColumns = dataColumns.filter((column) => column.string || column.kind === "string-value");
  if (mode === "form") return <Modal title={editing ? "Edit Database Server" : "Add Database Server"} icon={editing ? "edit" : "add_circle"} variant="database-form" onClose={resetForm}><Notice error={error} /><div className="neo-db-server-form"><Field label="Name" wide><Input value={draft.name} readOnly={Boolean(editing)} onChange={(name) => setDraft({ ...draft, name })} /></Field><div className="neo-db-server-form__host"><Field className="neo-db-server-form__host-field" label="Host"><Input value={draft.host} onChange={(host) => setDraft({ ...draft, host })} /></Field><Field label="Port"><Input type="number" value={draft.port} onChange={(port) => setDraft({ ...draft, port: Number(port) })} /></Field></div><div className="neo-db-server-form__credentials"><Field label="User"><Input value={draft.user} onChange={(user) => setDraft({ ...draft, user })} /></Field><Field label="Password"><Input type="password" value={draft.password} onChange={(password) => setDraft({ ...draft, password })} /></Field></div><button type="button" className="neo-button" onClick={() => { void loadDefaultTables(); }}>Test Connection and Load Tables</button><div className="neo-form-grid"><Field label="Default Table"><div className="neo-combobox neo-default-table-combobox"><Input disabled={!defaultTablesReady} placeholder="Select or enter a default table..." value={draft.defaultTable} onClick={() => setDefaultTableListOpen(true)} onChange={(table) => setDraft({ ...draft, defaultTable: table.toUpperCase(), valueColumn: "", stringValueColumn: "" })} /><IconButton icon={defaultTableListOpen ? "expand_less" : "expand_more"} label="Toggle default table list" disabled={!defaultTablesReady} onClick={() => setDefaultTableListOpen((open) => !open)} />{defaultTableListOpen ? <div className="neo-combobox__list" role="listbox" aria-label="Available default tables">{defaultTables.map((table) => <button type="button" role="option" key={table.name || table} onClick={() => { const defaultTable = String(table.name || table).toUpperCase(); setDefaultTableListOpen(false); setDraft({ ...draft, defaultTable, valueColumn: "", stringValueColumn: "" }); void loadDefaultColumns(defaultTable); }}>{table.name || table}</button>)}</div> : null}</div></Field><Field label="Value Column"><ColumnSelect value={draft.valueColumn} groups={[{ label: "Numeric", columns: numericColumns }]} disabled={defaultColumnSelectionDisabled} onChange={(valueColumn) => setDraft({ ...draft, valueColumn })} /></Field><Field label="String Value Column (optional)"><ColumnSelect value={draft.stringValueColumn} groups={[{ label: "String", columns: stringColumns }]} disabled={defaultColumnSelectionDisabled} onChange={(stringValueColumn) => setDraft({ ...draft, stringValueColumn })} /></Field></div></div><footer className="neo-modal__footer"><button className="neo-button" onClick={resetForm}>Cancel</button><button className="neo-button neo-button--primary" disabled={!valid} onClick={save}>{editing ? "Update" : "Create"}</button></footer></Modal>;
  const servers = loaded.data?.[0] || [];
  return <><Modal title="Database Servers" icon="dns" variant="database" onClose={app.closeCreateModal}><Notice error={loaded.error || error} /><div className="neo-db-server-card-list">{servers.map((server) => { const health = healthResults[server.name]; return <div className="neo-db-server-card" key={server.name}><div className="neo-db-server-card__info"><div className="neo-db-server-card__name"><Icon name="database" /><strong>{server.name}</strong>{server.name === defaultServer ? <span className="neo-db-server-card__badge neo-db-server-card__badge--default">Default</span> : null}</div><small>{server.host}:{server.port} · {server.user}</small>{health ? <span className={`neo-db-server-status${health === "healthy" ? " neo-db-server-status--healthy" : health === "unhealthy" ? " neo-db-server-status--unhealthy" : ""}`} role="status"><span />{health === "checking" ? "Checking connection…" : health === "healthy" ? "Connection OK" : "Connection failed"}</span> : null}</div><span className="neo-db-server-card__actions">{!fixedProvider ? <IconButton className={`neo-db-server-card__action${server.name === defaultServer ? " neo-db-server-card__action--default" : ""}`} icon="star" label="Set default Database Server" onClick={() => setDefault(server.name)} /> : null}<IconButton className="neo-db-server-card__action" icon="electrical_services" label="Connection Test" onClick={() => test(server.name)} /><IconButton className="neo-db-server-card__action" icon="edit" label="Edit" onClick={() => openEdit(server)} /><IconButton className="neo-db-server-card__action neo-db-server-card__action--danger" icon="delete" label="Delete" disabled={fixedProvider || server.name === defaultServer} onClick={() => setPendingDelete(server.name)} /></span></div>; })}</div><footer className="neo-modal__footer"><button className="neo-button" onClick={app.closeCreateModal}>Close</button>{!fixedProvider ? <button className="neo-button neo-button--primary" onClick={openCreate}><Icon name="add" />Add Server</button> : null}</footer></Modal>{pendingDelete ? <DatabaseServerDeleteConfirmModal name={pendingDelete} onCancel={() => setPendingDelete("")} onConfirm={() => remove(pendingDelete)} /> : null}</>;
}

function DataViewer() {
  const { name = "" } = useParams();
  const loaded = useLoad((signal) => api.jobs.get(name, { signal }), [name]);
  if (loaded.loading && !loaded.data) return <main className="neo-main" aria-label="DBus Collector main"><p className="neo-message">Loading Data Viewer…</p></main>;
  if (loaded.error) return <main className="neo-main" aria-label="DBus Collector main"><Notice error={loaded.error} /></main>;
  return <DataViewerPage job={name} detail={loaded.data} />;
}

function LogsPage() {
  const params = useParams();
  const name = params.name || "";
  const navigate = useNavigate();
  const loaded = useLoad((signal) => name ? api.logs.list(name, { signal }) : api.logs.all({ signal }), [name]);
  const [file, setFile] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState(null);
  const [view, setView] = useState("content");
  const read = async (kind, targetFile = file) => { try { setError(null); const result = await api.logs[kind](name, targetFile); setContent(typeof result.content === "string" ? result.content : Array.isArray(result.lines) ? result.lines.join("\n") : ""); } catch (failure) { setError(failure); } };
  const files = loaded.data?.files || [];
  useEffect(() => {
    if (file || files.length === 0) return;
    const initialFile = files[0].name;
    setFile(initialFile);
    setView("content");
    void read("content", initialFile);
  }, [file, files]);
  const selectFile = (event) => {
    const nextFile = event.target.value;
    setFile(nextFile);
    setView("content");
    setContent("");
    if (nextFile) void read("content", nextFile);
  };
  const changeView = (kind) => { setView(kind); void read(kind); };
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title={name ? `Logs · ${name}` : "All Logs"} onBack={() => navigate(name ? `/jobs/${encodeURIComponent(name)}` : "/")}></MainHeader><Notice error={loaded.error || error} /><div className="neo-page-body"><section className="neo-panel"><h2>{name ? "LOG FILES" : "JOB LOGS"}</h2>{name ? <><select aria-label="Log file" value={file} onChange={selectFile}><option value="">Select file</option>{files.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select><span className="neo-actions"><button className={`neo-button${view === "content" ? " is-active" : ""}`} title="Read the current log file" aria-pressed={view === "content"} disabled={!file} onClick={() => changeView("content")}>Content</button><button className={`neo-button${view === "contentAll" ? " is-active" : ""}`} title="Read this log and its rotated files" aria-pressed={view === "contentAll"} disabled={!file} onClick={() => changeView("contentAll")}>All</button><button className={`neo-button${view === "tail" ? " is-active" : ""}`} title="Read the most recent log lines" aria-pressed={view === "tail"} disabled={!file} onClick={() => changeView("tail")}>Tail</button></span></> : <pre className="neo-code">{JSON.stringify(loaded.data?.jobs || [], null, 2)}</pre>}</section>{name ? <pre className="neo-code neo-log-content">{content || (file ? "Loading log content…" : "No log file is available.")}</pre> : null}</div></main>;
}

export function MainRoutes() {
  return <Routes><Route path="/" element={<Home />} /><Route path="/jobs/new" element={<JobForm mode="new" />} /><Route path="/jobs/:name/edit" element={<JobForm mode="edit" />} /><Route path="/jobs/:name" element={<JobDetail />} /><Route path="/db-servers" element={<DbServersPage />} /><Route path="/data/:name" element={<DataViewer />} /><Route path="/logs/:name" element={<LogsPage />} /><Route path="/logs" element={<LogsPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}

export { DbusInterfaceFormModal, DbusInterfacesModal, MemoryRouter };

export function CombinedApp() { return <AppProvider surface="index"><div className="neo-index"><ConnectedSide /><MainRoutes /></div><CreateModalLayer /><ToastLayer /></AppProvider>; }
export function MainApp() { return <AppProvider surface="main"><MainRoutes /><CreateModalLayer /><ToastLayer /></AppProvider>; }
export function SideApp() { return <AppProvider surface="side"><ConnectedSide /><ToastLayer /></AppProvider>; }
