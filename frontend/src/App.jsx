import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { api } from "./api";
import { createPackageChannel } from "./package-channel";
import { buildJobTree, bulkEditTags, chartEvidenceKey, createDefaultJobConfig, createMethodCall, createProfileDraft, displayGridRow, generateTrailingTags, hasCompleteNumericEvidence, hydrateJobConfig, jobActions, mergeGeneratedTags, parseSuccessValue, referencesBlockChanges, reorder, serializeJobConfig, serializeMethodDraft, successValueType, validateJobPreview, validateJobTags } from "./model";
import Icon from "./components/Icon";

const CHANNEL_NAME = "app:neo-pkg-dbus";
const AppContext = createContext(null);

const DEFAULT_PROFILE = {
  id: "ls-electric-plc", displayName: "LS Electric PLC", defaults: { busType: "system", destination: "ls.plc" },
  methods: [{ id: "get-device-data", displayName: "Get Device Data", inputs: [{ id: "dataCount", type: "uint16", required: true, validation: { minimum: 1 } }, { id: "memoryAddress", type: "string", required: true }], output: { decoder: "json", shape: "array", expectedCount: { source: "input", inputId: "dataCount" } }, tagGeneration: { capability: "ls-get-device-data", countInputId: "dataCount", addressInputId: "memoryAddress" } }],
};
const DEFAULT_CONFIG = createDefaultJobConfig(DEFAULT_PROFILE, "local-db");

function messageOf(error) {
  return error?.reason || error?.message || "Request could not be completed.";
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

export function AppProvider({ children, surface }) {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [createModal, setCreateModal] = useState("");
  const [resourceRevision, setResourceRevision] = useState(0);
  const channelRef = useRef(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async ({ signal } = {}) => {
    if (signal?.aborted) return false;
    const requestGeneration = refreshGeneration.current + 1;
    refreshGeneration.current = requestGeneration;
    setLoading(true);
    try {
      const values = await api.jobs.list({ signal });
      if (signal?.aborted || refreshGeneration.current !== requestGeneration) return false;
      setJobs(Array.isArray(values) ? values : []);
      setSelected((current) => current || values?.[0]?.name || "");
      setError(null);
      return true;
    } catch (failure) {
      if (signal?.aborted || refreshGeneration.current !== requestGeneration || failure?.name === "AbortError") return false;
      setError(failure);
      return false;
    } finally {
      if (refreshGeneration.current === requestGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const channel = createPackageChannel({ enabled: true, name: CHANNEL_NAME, onMessage(message) {
      if (message.type === "refresh") void refresh();
      if (message.type === "select-job") { setSelected(message.name); if (surface !== "side") navigate(`/jobs/${encodeURIComponent(message.name)}`); }
      if (message.type === "new-job" && surface !== "side") navigate("/jobs/new");
      if (message.type === "navigate" && surface !== "side") navigate(message.path);
      if (message.type === "open-create-modal" && surface !== "side") setCreateModal(message.target);
    } });
    channelRef.current = channel;
    return () => { channel.close(); channelRef.current = null; };
  }, [navigate, refresh, surface]);

  const selectJob = useCallback((name) => {
    setSelected(name);
    if (surface !== "side") navigate(`/jobs/${encodeURIComponent(name)}`);
    channelRef.current?.selectJob(name);
  }, [navigate, surface]);
  const newJob = useCallback(() => { if (surface !== "side") navigate("/jobs/new"); channelRef.current?.newJob(); }, [navigate, surface]);
  const go = useCallback((path) => { if (surface !== "side") navigate(path); channelRef.current?.navigate(path); }, [navigate, surface]);
  const openCreateModal = useCallback((target) => { if (surface !== "side") setCreateModal(target); channelRef.current?.openCreateModal(target); }, [surface]);
  const closeCreateModal = useCallback(() => setCreateModal(""), []);
  const resourceChanged = useCallback(() => setResourceRevision((value) => value + 1), []);
  const run = useCallback(async (operation, { signal, isCurrent = () => true, onError } = {}) => {
    if (signal?.aborted || !isCurrent()) return false;
    setError(null);
    try {
      await operation();
      if (signal?.aborted || !isCurrent()) return false;
      channelRef.current?.refresh();
      await refresh({ signal });
      return !signal?.aborted && isCurrent();
    } catch (failure) {
      if (!signal?.aborted && isCurrent() && failure?.name !== "AbortError") {
        if (onError) onError(failure); else setError(failure);
      }
      return false;
    }
  }, [refresh]);

  return <AppContext.Provider value={{ jobs, selected, loading, error, createModal, resourceRevision, refresh, selectJob, newJob, go, openCreateModal, closeCreateModal, resourceChanged, run }}>{children}</AppContext.Provider>;
}

function useApp() {
  return useContext(AppContext) || { jobs: [], selected: "", loading: false, error: null, createModal: "", resourceRevision: 0, refresh() {}, selectJob() {}, newJob() {}, go() {}, openCreateModal() {}, closeCreateModal() {}, resourceChanged() {}, run: async () => false };
}

function StatusText({ job }) {
  const state = job?.controllerState || "UNKNOWN";
  const key = state.toLowerCase().replaceAll("_", "-");
  return <span className={`neo-status neo-status--${key}`}>{state.replaceAll("_", " ")}</span>;
}

function IconButton({ icon, label, className = "", ...props }) {
  return <button className={`neo-icon-button ${className}`.trim()} type="button" aria-label={label} title={label} {...props}><Icon name={icon} /></button>;
}

function Modal({ title, icon, variant = "", onClose, children }) {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="neo-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`neo-modal__dialog${variant ? ` neo-modal__dialog--${variant}` : ""}`} role="dialog" aria-modal="true" aria-label={title}><header className="neo-modal__header"><div className="neo-modal__title">{icon ? <Icon name={icon} /> : null}<h2>{title}</h2></div><IconButton className="neo-modal__close" icon="close" label="Close" onClick={onClose} /></header><div className="neo-modal__body">{children}</div></section></div>;
}

export function JobSide({ jobs, selected, loading = false, error = null, onSelect, onNew, onOpenModal = () => {}, onRefresh, onToggle }) {
  return <aside className="neo-side" aria-label="DBus Collector jobs">
    <header className="neo-side__header"><span className="neo-package-mark"><Icon name="memory" /></span><strong title="neo-pkg-dbus">neo-pkg-dbus</strong><span className="neo-side__header-actions"><IconButton icon="add" label="New Job" onClick={onNew} /><IconButton icon="dns" label="New Database Server" onClick={() => onOpenModal("db-server")} /><IconButton icon="account_tree" label="New Profile" onClick={() => onOpenModal("profile")} /></span></header>
    <div className="neo-side__section"><span>JOBS</span><span className="neo-side__tools"><IconButton icon="refresh" label="Refresh" onClick={onRefresh} /></span></div>
    {loading ? <p className="neo-message" aria-live="polite">Loading jobs…</p> : null}
    {error ? <p className="neo-message neo-message--error" role="alert">{messageOf(error)}</p> : null}
    <div className="neo-job-list">
      {jobs.map((job) => {
        const actions = jobActions(job);
        const running = job.executionState === "running";
        return <div className={`neo-job-row${selected === job.name ? " is-selected" : ""}`} key={job.name}>
          <button className="neo-job-row__select" type="button" aria-pressed={selected === job.name} onClick={() => onSelect(job.name)} title={`${job.name} · ${job.controllerState || "UNKNOWN"}`}>
            <span>{job.name}</span><small>{job.controllerState || "UNKNOWN"}</small>
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
      await app.run(() => api.jobs[action](job.name, { signal: mutation.signal }), { signal: mutation.signal, isCurrent: mutation.isCurrent });
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
  if (!error && !children) return null;
  return <p className={`neo-message${error ? " neo-message--error" : ""}`} role={error ? "alert" : status ? "status" : undefined}>{error ? messageOf(error) : children}</p>;
}

function PageNav() {
  return <nav className="neo-nav" aria-label="Package sections">
    <Link to="/logs">Logs</Link>
  </nav>;
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
  const [mutationError, setMutationError] = useState(null);
  useEffect(() => { setMutationError(null); }, [name]);
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
  const job = loaded.data?.job;
  const lastRun = loaded.data?.lastRun ?? null;
  const lastRunError = loaded.data?.lastRunError ?? null;
  const actions = jobActions(job);
  const config = job?.config || {};
  const invalid = job?.error?.code === "JOB_INVALID_CONFIG";
  const mutate = async (action) => {
    if (action === "remove" && !window.confirm(`Delete ${name}?`)) return;
    const mutation = beginMutation();
    setMutationError(null);
    try {
      const ok = await app.run(
        () => action === "remove" ? api.jobs.remove(name, { signal: mutation.signal }) : api.jobs[action](name, { signal: mutation.signal }),
        { signal: mutation.signal, isCurrent: mutation.isCurrent, onError: setMutationError },
      );
      if (!mutation.isCurrent() || !ok) return;
      if (action === "remove") app.go("/"); else void loaded.reload();
    } finally {
      mutation.finish();
    }
  };
  return <main className="neo-main" aria-label="DBus Collector main">
    <MainHeader title={name || "Job"} subtitle={job ? `${job.profileId || config.profileId} · ${job.destination || config.dbus?.destination}` : "Job detail"}>
      {actions.install ? <button className="neo-button neo-button--primary" onClick={() => mutate("install")}>Install</button> : null}
      <Link className={`neo-button${!actions.edit ? " is-disabled" : ""}`} aria-disabled={!actions.edit} tabIndex={actions.edit ? 0 : -1} to={actions.edit ? `/jobs/${encodeURIComponent(name)}/edit` : "#"}>Edit</Link>
      <Link className="neo-button" to={`/data/${encodeURIComponent(name)}`}>Data Viewer</Link><Link className="neo-button" to={`/logs/${encodeURIComponent(name)}`}>Logs</Link>
      <button className="neo-button neo-button--danger" aria-label={`${name} Delete`} disabled={!actions.remove} onClick={() => mutate("remove")}>Delete</button>
    </MainHeader>
    <PageNav />
    {loaded.loading ? <p className="neo-message" aria-live="polite">Loading Job…</p> : null}<Notice error={loaded.error || mutationError} />
    {invalid ? <Notice error={{ reason: job.controllerDetail || "Stored Job name does not match its file. All changes are blocked." }} /> : null}
    {job ? <div className="neo-page-body">
      <section className="neo-summary-grid" aria-label="Job status">
        <Metric label="CONFIG" value={job.configState || "UNKNOWN"} /><Metric label="EXECUTION" value={job.executionState || "UNKNOWN"} /><Metric label="CONTROLLER" value={<StatusText job={job} />} />
        <Metric label="INTERVAL" value={`${config.schedule?.intervalMs ?? "—"} ms`} /><Metric label="METHOD CALLS" value={config.methodCalls?.length ?? job.methodCallCount ?? 0} /><Metric label="DATABASE" value={`${config.database?.server || "—"} / ${config.database?.table || "—"}`} />
      </section>
      <section className="neo-panel"><h2>LAST RUN</h2><Notice error={lastRunError} />{lastRun ? <><div className="neo-summary-grid neo-summary-grid--compact"><Metric label="STATUS" value={lastRun.status} /><Metric label="STARTED" value={lastRun.startedAt} /><Metric label="COMPLETED" value={lastRun.completedAt} /></div><table><thead><tr><th>Method</th><th>Status</th><th>Stored</th><th>Error</th></tr></thead><tbody>{(lastRun.methodCalls || lastRun.methods || []).map((method) => <tr key={method.id}><td>{method.name}</td><td>{method.status}</td><td>{method.storedCount}</td><td>{method.error || "—"}</td></tr>)}</tbody></table></> : <p>No run result yet</p>}</section>
    </div> : null}
  </main>;
}

function Metric({ label, value }) {
  return <div className="neo-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Field({ label, children, wide = false, className = "" }) { return <label className={`neo-field${wide ? " neo-field--wide" : ""} ${className}`.trim()}><span>{label}</span>{children}</label>; }
function Input({ value, onChange, ...props }) { return <input {...props} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />; }

function MethodCallsEditor({ calls, setCalls, onTest, methods = [], maxGeneratedTagsPerCall }) {
  const [dragged, setDragged] = useState(-1);
  const [selectedTags, setSelectedTags] = useState(() => new Map());
  const [bulk, setBulk] = useState({ prefix: "", suffix: "", find: "", replace: "", bias: "", multiplier: "", calcOrder: "bm" });
  const [preview, setPreview] = useState(null);
  const updateCall = (index, patch) => setCalls((current) => current.map((call, callIndex) => callIndex === index ? { ...call, ...patch } : call));
  const selections = (id) => selectedTags.get(id) || new Set();
  const selectTag = (id, tagIndex, checked) => setSelectedTags((current) => {
    const next = new Map(current);
    const values = new Set(next.get(id) || []);
    if (checked) values.add(tagIndex); else values.delete(tagIndex);
    next.set(id, values);
    return next;
  });
  const methodFor = (call) => methods.find((method) => method.id === call.methodId);
  const generate = (index, mode) => {
    const call = calls[index];
    const method = methodFor(call);
    const mapping = method?.tagGeneration;
    if (!mapping || mapping.capability !== "ls-get-device-data") return;
    const generated = generateTrailingTags(call.inputs[mapping.addressInputId], Number(call.inputs[mapping.countInputId]));
    if (generated.length < (call.tags || []).length && !window.confirm(`${call.tags.length - generated.length} Tag rows will be removed. Continue?`)) return;
    updateCall(index, { tags: mergeGeneratedTags(call.tags || [], generated, mode) });
  };
  const runBulkPreview = (index) => {
    const edit = Object.fromEntries(Object.entries(bulk).filter(([, value]) => value !== ""));
    const result = bulkEditTags(calls[index].tags || [], [...selections(calls[index].id)], edit);
    const jobErrors = validateJobPreview(calls, index, result.preview, methods, { maxGeneratedTagsPerCall });
    setPreview({ callIndex: index, ...result, errors: [...new Set([...result.errors, ...jobErrors])] });
  };
  const resetBulkPreview = (index) => {
    const result = bulkEditTags(calls[index].tags || [], [...selections(calls[index].id)], { reset: true });
    const jobErrors = validateJobPreview(calls, index, result.preview, methods, { maxGeneratedTagsPerCall });
    setPreview({ callIndex: index, ...result, errors: [...new Set([...result.errors, ...jobErrors])] });
  };
  const chooseMethod = (index, methodId) => {
    const method = methods.find((item) => item.id === methodId);
    if (!method) return;
    const replacement = createMethodCall(method, calls[index].id);
    updateCall(index, { methodId, inputs: replacement.inputs, tags: replacement.tags });
  };
  return <section className="neo-panel"><div className="neo-panel__title"><h2>METHOD CALLS</h2><button type="button" className="neo-button" disabled={!methods.length} onClick={() => setCalls((current) => [...current, createMethodCall(methods[0], `call-${methods[0].id}-${Date.now()}`)])}>Add Call</button></div>
    {calls.map((call, index) => <article className="neo-call" key={call.id} draggable onDragStart={() => setDragged(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { setCalls((current) => reorder(current, dragged, index)); setDragged(-1); }}>
      <div className="neo-call__head"><span className="neo-drag" aria-hidden="true"><Icon name="drag_indicator" /></span><strong>{index + 1}. {call.name}</strong><span className="neo-actions"><IconButton icon="arrow_upward" label={`${call.name} Move up`} disabled={index === 0} onClick={() => setCalls((current) => reorder(current, index, index - 1))} /><IconButton icon="arrow_downward" label={`${call.name} Move down`} disabled={index === calls.length - 1} onClick={() => setCalls((current) => reorder(current, index, index + 1))} /><IconButton icon="delete" label={`${call.name} Remove`} disabled={calls.length === 1} onClick={() => setCalls((current) => current.filter((_, callIndex) => callIndex !== index))} /></span></div>
      <div className="neo-form-grid"><Field label="Call Name"><Input value={call.name} onChange={(name) => updateCall(index, { name })} /></Field><Field label="Method"><select aria-label={`${call.name} Method`} value={call.methodId} onChange={(event) => chooseMethod(index, event.target.value)}>{methods.map((method) => <option value={method.id} key={method.id}>{method.displayName}</option>)}</select></Field>{(methodFor(call)?.inputs || []).map((input) => <Field label={`${input.id} (${input.type})`} key={input.id}>{input.type === "bool" ? <select value={String(Boolean(call.inputs[input.id]))} onChange={(event) => updateCall(index, { inputs: { ...call.inputs, [input.id]: event.target.value === "true" } })}><option value="true">true</option><option value="false">false</option></select> : <Input type={["uint64", "int64"].includes(input.type) || !/int|float|double|byte/.test(input.type) ? "text" : "number"} value={call.inputs[input.id]} onChange={(value) => updateCall(index, { inputs: { ...call.inputs, [input.id]: ["uint64", "int64"].includes(input.type) || !/int|float|double|byte/.test(input.type) ? value : Number(value) } })} />}</Field>)}</div>
      <div className="neo-toolbar">{methodFor(call)?.tagGeneration ? <><button type="button" className="neo-button" onClick={() => generate(index, "missing")}>Add Missing Only</button><button type="button" className="neo-button" onClick={() => generate(index, "all")}>Regenerate All</button></> : <button type="button" className="neo-button" onClick={() => { const count = (call.tags || []).length; updateCall(index, { tags: [...(call.tags || []), { outputIndex: count, sourceAddress: `${call.methodId}:${count}`, name: `${call.methodId}-${count + 1}`, bias: 0, multiplier: 1, calcOrder: "bm", nameEdited: false, transformEdited: false }] }); }}>Add Output Tag</button>}<button type="button" className="neo-button" onClick={() => setPreview(null)}>Cancel</button><button type="button" className="neo-button" onClick={() => onTest(call, methodFor(call))}>Test Call</button></div>
      <div className="neo-table-wrap"><table><thead><tr><th aria-label="Select Tag" /><th>Source</th><th>Name</th><th>Bias</th><th>Multiplier</th><th>Order</th></tr></thead><tbody>{(call.tags || []).map((tag, tagIndex) => <tr key={tag.outputIndex}><td><input type="checkbox" aria-label={`Select ${tag.name}`} checked={selections(call.id).has(tagIndex)} onChange={(event) => selectTag(call.id, tagIndex, event.target.checked)} /></td><td><Input value={tag.sourceAddress} onChange={(sourceAddress) => updateCall(index, { tags: call.tags.map((item, itemIndex) => itemIndex === tagIndex ? { ...item, sourceAddress } : item) })} /></td><td><Input value={tag.name} onChange={(name) => updateCall(index, { tags: call.tags.map((item, itemIndex) => itemIndex === tagIndex ? { ...item, name, nameEdited: true } : item) })} /></td><td><Input type="number" value={tag.bias} onChange={(bias) => updateCall(index, { tags: call.tags.map((item, itemIndex) => itemIndex === tagIndex ? { ...item, bias: Number(bias), transformEdited: true } : item) })} /></td><td><Input type="number" value={tag.multiplier} onChange={(multiplier) => updateCall(index, { tags: call.tags.map((item, itemIndex) => itemIndex === tagIndex ? { ...item, multiplier: Number(multiplier), transformEdited: true } : item) })} /></td><td><select value={tag.calcOrder} onChange={(event) => updateCall(index, { tags: call.tags.map((item, itemIndex) => itemIndex === tagIndex ? { ...item, calcOrder: event.target.value, transformEdited: true } : item) })}><option value="bm">bm</option><option value="mb">mb</option></select></td></tr>)}</tbody></table></div>
      <details><summary>Bulk Edit</summary><div className="neo-form-grid neo-form-grid--bulk"><Field label="Prefix"><Input value={bulk.prefix} onChange={(prefix) => setBulk({ ...bulk, prefix })} /></Field><Field label="Suffix"><Input value={bulk.suffix} onChange={(suffix) => setBulk({ ...bulk, suffix })} /></Field><Field label="Find"><Input value={bulk.find} onChange={(find) => setBulk({ ...bulk, find })} /></Field><Field label="Replace"><Input value={bulk.replace} onChange={(replace) => setBulk({ ...bulk, replace })} /></Field><Field label="Bias"><Input value={bulk.bias} onChange={(bias) => setBulk({ ...bulk, bias })} /></Field><Field label="Multiplier"><Input value={bulk.multiplier} onChange={(multiplier) => setBulk({ ...bulk, multiplier })} /></Field><Field label="Order"><select value={bulk.calcOrder} onChange={(event) => setBulk({ ...bulk, calcOrder: event.target.value })}><option value="bm">bm</option><option value="mb">mb</option></select></Field><Field label="Names (one per line)" wide><textarea value={bulk.lines || ""} onChange={(event) => setBulk({ ...bulk, lines: event.target.value })} /></Field></div><div className="neo-toolbar"><button type="button" className="neo-button" onClick={() => runBulkPreview(index)}>Preview</button><button type="button" className="neo-button" onClick={() => resetBulkPreview(index)}>Reset Transform</button></div></details>
      {preview?.callIndex === index ? <div className="neo-preview" role="status"><strong>{preview.changeCount} changes</strong>{preview.errors.map((error) => <p key={error}>{error}</p>)}<ul>{preview.preview.slice(0, 8).map((tag) => <li key={tag.outputIndex}>{tag.name}: {tag.calcOrder} {tag.bias} / {tag.multiplier}</li>)}</ul><button type="button" className="neo-button neo-button--primary" disabled={preview.errors.length > 0} onClick={() => { updateCall(index, { tags: preview.preview }); setPreview(null); }}>Apply</button><button type="button" className="neo-button" onClick={() => setPreview(null)}>Cancel</button></div> : null}
    </article>)}
  </section>;
}

function JobForm({ mode }) {
  const params = useParams();
  const navigate = useNavigate();
  const app = useApp();
  const editing = mode === "edit";
  const currentEditName = useRef(params.name || "");
  currentEditName.current = params.name || "";
  const beginSubmission = useRouteMutation(editing ? params.name : "new");
  const beginTestCall = useRouteMutation(editing ? params.name : "new");
  const loaded = useLoad((signal) => Promise.all([api.settings.get({ signal }), api.profiles.list({ signal }), api.db.servers.list({ signal }), editing ? api.jobs.get(params.name, { signal }) : Promise.resolve(null)]), [editing, params.name]);
  const [name, setName] = useState("");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [errors, setErrors] = useState([]);
  const [testResult, setTestResult] = useState(null);
  const [profileDetail, setProfileDetail] = useState(null);
  const [tables, setTables] = useState([]);
  const [columns, setColumns] = useState([]);
  const [connection, setConnection] = useState("");
  const [validationWarnings, setValidationWarnings] = useState([]);
  const [warningApprovalKey, setWarningApprovalKey] = useState("");
  useEffect(() => {
    setName("");
    setConfig(DEFAULT_CONFIG);
    setErrors([]);
    setTestResult(null);
    setProfileDetail(null);
    setTables([]);
    setColumns([]);
    setConnection("");
    setValidationWarnings([]);
    setWarningApprovalKey("");
  }, [editing, params.name]);
  useEffect(() => {
    if (!loaded.data) return;
    const [settings, profiles, , job] = loaded.data;
    if (editing && job?.name !== params.name) return;
    if (job) { setName(job.name); setConfig(hydrateJobConfig({ ...DEFAULT_CONFIG, ...job.config })); }
    else {
      const selectedProfile = profiles.find((profile) => profile.id === settings.defaultProfileId) || profiles[0];
      setConfig(createDefaultJobConfig(selectedProfile ? { ...DEFAULT_PROFILE, ...selectedProfile } : DEFAULT_PROFILE, loaded.data[2]?.[0]?.name || "local-db"));
    }
  }, [editing, loaded.data, params.name]);
  useEffect(() => {
    if (!config.profileId) return undefined;
    const controller = new AbortController();
    api.profiles.get(config.profileId, { signal: controller.signal }).then(setProfileDetail, () => setProfileDetail(null));
    return () => controller.abort();
  }, [config.profileId, params.name]);
  useEffect(() => {
    const profile = profileDetail?.profile;
    if (editing || !profile || profile.id !== config.profileId) return;
    setConfig((current) => ({ ...createDefaultJobConfig(profile, current.database.server), database: current.database }));
  }, [editing, profileDetail, config.profileId]);
  useEffect(() => {
    if (!config.database.server) { setTables([]); return undefined; }
    const controller = new AbortController();
    Promise.all([
      api.db.connect(config.database.server, { signal: controller.signal }),
      api.db.tables.list({ server: config.database.server }, { signal: controller.signal }),
    ]).then(([connected, values]) => { setConnection(connected.reason || "Connection available."); setTables(values.tables || values || []); }, (failure) => setConnection(messageOf(failure)));
    return () => controller.abort();
  }, [config.database.server, params.name]);
  useEffect(() => {
    if (!config.database.server || !config.database.table) { setColumns([]); return undefined; }
    const controller = new AbortController();
    api.db.tables.columns({ server: config.database.server, table: config.database.table }, { signal: controller.signal }).then((values) => setColumns(values.columns || values || []), () => setColumns([]));
    return () => controller.abort();
  }, [config.database.server, config.database.table, params.name]);
  const setNested = (group, key, value) => setConfig((current) => ({ ...current, [group]: { ...current[group], [key]: value } }));
  const save = async (event) => {
    event.preventDefault();
    const targetName = editing ? params.name : name;
    const submission = beginSubmission();
    try {
      if (editBlocked) {
        if (!editRoutePending) setErrors([editBlockMessage || "Job status must be checked before editing."]);
        return;
      }
      const validation = [];
      if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(name)) validation.push("Job name must use lowercase letters, numbers, _ or -.");
      if (!config.methodCalls.length) validation.push("At least one Method Call is required.");
      const methods = profileDetail?.profile?.methods || [];
      validation.push(...validateJobTags(config.methodCalls.map((call) => ({ ...call, method: methods.find((method) => method.id === call.methodId) })), {
        maxGeneratedTagsPerCall: loaded.data?.[0]?.limits?.maxGeneratedTagsPerCall,
      }));
      setErrors(validation);
      if (validation.length) return;
      const payload = serializeJobConfig(config);
      const validationResult = await api.jobs.validate({ name: targetName, config: payload }, { signal: submission.signal });
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
        if (!editing) { setErrors([messageOf(failure)]); return; }
        if (currentEditName.current !== targetName) return;
        const latest = await loaded.reload({ signal: submission.signal });
        if (latest.status === "aborted" || !submission.isCurrent() || currentEditName.current !== targetName) return;
        const latestJob = latest.status === "success" ? latest.data?.[3] : null;
        if (latestJob?.name === targetName) {
          setName(latestJob.name);
          setConfig(hydrateJobConfig({ ...DEFAULT_CONFIG, ...latestJob.config }));
          setErrors(["Another user saved this Job. The latest setting was reloaded. Review and save again."]);
        } else setErrors(["Another user saved this Job. The latest setting could not be reloaded. Refresh and try again."]);
      } else setErrors([messageOf(failure)]);
    } finally {
      submission.finish();
    }
  };
  const testCall = async (call, selectedMethod) => {
    const mutation = beginTestCall();
    const profile = profileDetail?.profile || { id: config.profileId };
    const method = selectedMethod || profile.methods?.find((item) => item.id === call.methodId) || { id: call.methodId };
    try {
      const result = await api.dbus.call({ profile, method, dbus: config.dbus, inputs: call.inputs }, { signal: mutation.signal });
      if (mutation.isCurrent()) setTestResult(result);
    } catch (failure) {
      if (mutation.isCurrent() && failure?.name !== "AbortError") setTestResult({ success: false, error: messageOf(failure) });
    } finally {
      mutation.finish();
    }
  };
  const servers = loaded.data?.[2] || [];
  const loadedEditJob = loaded.data?.[3];
  const editRoutePending = editing && (loaded.loading || loadedEditJob?.name !== params.name);
  const editReady = !editing || !editRoutePending;
  const editJob = editReady ? loadedEditJob : null;
  const editBlocked = editing && (!editReady || !editJob || editJob.statusKnown !== true
    || editJob.executionState === "running" || ["RUNNING", "STARTING", "STOPPING"].includes(editJob.controllerState));
  const editBlockMessage = !editBlocked || !editJob ? "" : editJob.statusKnown !== true
    ? "Job status is unknown. Refresh the page after the controller is available."
    : "Stop this Job before editing, then refresh the page.";
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title={editing ? `Edit ${params.name}` : "New Job"} onBack={() => navigate(-1)}><button className="neo-button neo-button--primary" type="submit" form="job-form" disabled={editBlocked} title={editBlockMessage || undefined}>{editing ? "Save" : "Create"}</button></MainHeader>
    {loaded.loading ? <p className="neo-message" aria-live="polite">Loading form…</p> : null}<Notice error={loaded.error} /><Notice status>{editBlockMessage}</Notice>{errors.length ? <div className="neo-message neo-message--error" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}</div> : null}{validationWarnings.length ? <div className="neo-message neo-message--warning" role="status"><p>Validation warnings found. Review them, then press {editing ? "Save" : "Create"} again to continue.</p>{validationWarnings.map((warning) => <p key={`${warning.code}-${JSON.stringify(warning.details || {})}`}>{warning.code}: {[...(warning.details?.jobs || []), ...(warning.details?.tags || [])].join(", ")}</p>)}</div> : null}
    <form id="job-form" className="neo-page-body" onSubmit={save}>
      <fieldset className="neo-form-lock" aria-label="Job editing controls" disabled={editBlocked}>
      <section className="neo-panel"><h2>JOB CONFIGURATION</h2><div className="neo-form-grid"><Field label="Job Name"><Input maxLength={100} value={name} readOnly={editing} disabled={editing} onChange={(value) => setName(value.toLowerCase())} /></Field><Field label="Service Name"><input value={`_dbu_${name}`} readOnly /></Field><Field label="Profile"><select value={config.profileId} onChange={(event) => setConfig({ ...config, profileId: event.target.value })}>{(loaded.data?.[1] || []).map((profile) => <option value={profile.id} key={profile.id}>{profile.displayName}</option>)}</select></Field><Field label="Bus Type"><select value={config.dbus.busType} onChange={(event) => setNested("dbus", "busType", event.target.value)}><option value="system">system</option><option value="session">session</option></select></Field><Field label="Destination"><Input value={config.dbus.destination} onChange={(value) => setNested("dbus", "destination", value)} /></Field><Field label="Run Interval (ms)"><Input type="number" min="1000" value={config.schedule.intervalMs} onChange={(value) => setNested("schedule", "intervalMs", Number(value))} /></Field><Field label="Retry Initial (ms)"><Input type="number" value={config.retry.initialDelayMs} onChange={(value) => setNested("retry", "initialDelayMs", Number(value))} /></Field><Field label="Retry Maximum (ms)"><Input type="number" value={config.retry.maximumDelayMs} onChange={(value) => setNested("retry", "maximumDelayMs", Number(value))} /></Field><Field label="Retry Multiplier"><Input type="number" value={config.retry.multiplier} onChange={(value) => setNested("retry", "multiplier", Number(value))} /></Field><Field label="Save Policy"><select value={config.execution.savePolicy} onChange={(event) => setNested("execution", "savePolicy", event.target.value)}><option value="perMethod">perMethod</option><option value="afterAllMethods">afterAllMethods</option></select></Field><Field label="Method Error"><input value="stop" readOnly /></Field></div></section>
      <section className="neo-panel"><h2>DATABASE MAPPING</h2><div className="neo-form-grid"><Field label="Registered Server"><select value={config.database.server} onChange={(event) => setNested("database", "server", event.target.value)}><option value="">Select server</option>{servers.map((server) => <option value={server.name} key={server.name}>{server.name}</option>)}</select></Field><Field label="Table"><select value={config.database.table} onChange={(event) => setNested("database", "table", event.target.value)}><option value={config.database.table}>{config.database.table || "Select table"}</option>{tables.map((table) => { const name = table.name || table; return <option value={name} key={name}>{name}</option>; })}</select></Field><Field label="Value Column"><select value={config.database.valueColumn} onChange={(event) => setNested("database", "valueColumn", event.target.value)}><option value={config.database.valueColumn}>{config.database.valueColumn || "Select column"}</option>{columns.filter((column) => column.numeric || column.kind === "value").map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></Field><Field label="String Value Column"><select value={config.database.stringValueColumn} onChange={(event) => setNested("database", "stringValueColumn", event.target.value)}><option value="">None</option>{columns.filter((column) => column.string || column.kind === "string-value").map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></Field></div>{connection ? <p role="status">{connection}</p> : null}</section>
      <MethodCallsEditor calls={config.methodCalls} methods={profileDetail?.profile?.methods || DEFAULT_PROFILE.methods} maxGeneratedTagsPerCall={loaded.data?.[0]?.limits?.maxGeneratedTagsPerCall} setCalls={(update) => setConfig((current) => ({ ...current, methodCalls: typeof update === "function" ? update(current.methodCalls) : update }))} onTest={testCall} />
      {testResult ? <section className="neo-panel"><h2>TEST CALL</h2><div className="neo-summary-grid neo-summary-grid--compact"><Metric label="SUCCESS" value={String(Boolean(testResult.success))} /><Metric label="DURATION" value={`${testResult.durationMs ?? "—"} ms`} /><Metric label="VALUES" value={testResult.valueCount ?? testResult.values?.length ?? 0} /></div><h3>Tag preview</h3><pre className="neo-code">{JSON.stringify(testResult.suggestedTags || testResult.values || [], null, 2)}</pre><details><summary>Raw body (diagnostic only)</summary><pre className="neo-code">{JSON.stringify(testResult.body ?? testResult.error, null, 2)}</pre></details></section> : null}
      </fieldset>
    </form>
  </main>;
}

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
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title="Profiles" subtitle="Built-in profiles are read-only." /><PageNav /><Notice error={loaded.error || error} /><Notice status>{message}</Notice><div className="neo-page-body neo-management">
    {settingsDraft ? <section className="neo-panel"><h2>SETTINGS</h2><div className="neo-form-grid"><Field label="Default Profile"><select aria-label="Default Profile" value={settingsDraft.defaultProfileId} onChange={(event) => setSettingsDraft({ ...settingsDraft, defaultProfileId: event.target.value })}>{(loaded.data?.[0] || []).map((profile) => <option value={profile.id} key={profile.id}>{profile.displayName}</option>)}</select></Field><Field label="Max Generated Tags"><Input aria-label="Max Generated Tags" type="number" value={settingsDraft.limits.maxGeneratedTagsPerCall} onChange={(value) => setSettingsDraft({ ...settingsDraft, limits: { ...settingsDraft.limits, maxGeneratedTagsPerCall: Number(value) } })} /></Field><Field label="Max Buffered Rows"><Input aria-label="Max Buffered Rows" type="number" value={settingsDraft.limits.maxBufferedRowsPerCycle} onChange={(value) => setSettingsDraft({ ...settingsDraft, limits: { ...settingsDraft.limits, maxBufferedRowsPerCycle: Number(value) } })} /></Field></div><button className="neo-button neo-button--primary" onClick={saveSettings}>Save Settings</button></section> : null}
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
    <h3>Inputs</h3>{draft.inputs.map((input, index) => <div className="neo-method-input" key={`${input.id}-${index}`}><Input aria-label="Method input ID" value={input.id} onChange={(id) => updateInput(index, { id })} /><select aria-label="Method input type" value={input.type} onChange={(event) => updateInput(index, { type: event.target.value })}>{["byte", "uint8", "uint16", "uint32", "uint64", "int16", "int32", "int64", "float32", "float64", "double", "bool", "string", "objectpath", "path", "signature"].map((type) => <option key={type}>{type}</option>)}</select><label><input type="checkbox" checked={input.required} onChange={(event) => updateInput(index, { required: event.target.checked })} /> Required</label><Input aria-label="Input minimum" value={input.validation?.minimum ?? ""} onChange={(minimum) => updateInput(index, { validation: { ...input.validation, minimum: ["uint64", "int64"].includes(input.type) ? minimum : Number(minimum) } })} /><Input aria-label="Input maximum" value={input.validation?.maximum ?? ""} onChange={(maximum) => updateInput(index, { validation: { ...input.validation, maximum: ["uint64", "int64"].includes(input.type) ? maximum : Number(maximum) } })} /><Input aria-label="Input pattern" value={input.validation?.pattern ?? ""} onChange={(pattern) => updateInput(index, { validation: { ...input.validation, pattern } })} /><IconButton icon="delete" label={`Remove input ${input.id}`} onClick={() => setDraft({ ...draft, inputs: draft.inputs.filter((_, inputIndex) => inputIndex !== index) })} /></div>)}<button className="neo-button" onClick={() => setDraft({ ...draft, inputs: [...draft.inputs, { id: `input${draft.inputs.length + 1}`, type: "string", required: true }] })}>Add Input</button>
    <h3>Output</h3><div className="neo-form-grid"><Field label="Decoder"><select value={draft.output.decoder} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, decoder: event.target.value } })}><option value="raw">raw</option><option value="json">json</option></select></Field><Field label="Shape"><select value={draft.output.shape} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, shape: event.target.value } })}><option value="scalar">scalar</option><option value="array">array</option><option value="object">object</option></select></Field><Field label="Path"><Input value={draft.output.path || ""} onChange={(path) => setDraft({ ...draft, output: { ...draft.output, path } })} /></Field><Field label="Returned Count Path"><Input value={draft.output.returnedCountPath || ""} onChange={(returnedCountPath) => setDraft({ ...draft, output: { ...draft.output, returnedCountPath } })} /></Field><Field label="Expected Count Input"><select value={draft.output.expectedCount?.inputId || ""} onChange={(event) => setDraft({ ...draft, output: { ...draft.output, expectedCount: event.target.value ? { source: "input", inputId: event.target.value } : undefined } })}><option value="">None</option>{draft.inputs.map((input) => <option key={input.id}>{input.id}</option>)}</select></Field><Field label="Success Path"><Input value={draft.output.success?.path || ""} onChange={(path) => setDraft({ ...draft, output: { ...draft.output, success: path ? { path, operator: "equals", value: draft.output.success?.value ?? 1 } : undefined } })} /></Field><Field label="Success Value Type"><select aria-label="Success value type" value={successType} onChange={(event) => { const type = event.target.value; updateSuccessValue(parseSuccessValue(type, type === "number" ? "0" : type === "boolean" ? "true" : "")); }}><option value="number">number</option><option value="boolean">boolean</option><option value="string">string</option><option value="null">null</option></select></Field><Field label="Success Value">{successType === "boolean" ? <select aria-label="Success Value" value={String(draft.output.success?.value)} onChange={(event) => updateSuccessValue(parseSuccessValue("boolean", event.target.value))}><option value="true">true</option><option value="false">false</option></select> : <Input aria-label="Success Value" type={successType === "number" ? "number" : "text"} readOnly={successType === "null"} value={successType === "null" ? "null" : draft.output.success?.value ?? ""} onChange={(value) => updateSuccessValue(parseSuccessValue(successType, value))} />}</Field></div>
    <h3>LS Tag Generation (optional)</h3><div className="neo-form-grid"><Field label="Capability"><select value={draft.tagGeneration?.capability || ""} onChange={(event) => setDraft({ ...draft, tagGeneration: event.target.value ? { capability: event.target.value, countInputId: draft.inputs[0]?.id || "", addressInputId: draft.inputs[1]?.id || "" } : undefined })}><option value="">None</option><option value="ls-get-device-data">ls-get-device-data</option></select></Field>{draft.tagGeneration ? <><Field label="Count Input"><select value={draft.tagGeneration.countInputId} onChange={(event) => setDraft({ ...draft, tagGeneration: { ...draft.tagGeneration, countInputId: event.target.value } })}>{draft.inputs.map((input) => <option key={input.id}>{input.id}</option>)}</select></Field><Field label="Address Input"><select value={draft.tagGeneration.addressInputId} onChange={(event) => setDraft({ ...draft, tagGeneration: { ...draft.tagGeneration, addressInputId: event.target.value } })}>{draft.inputs.map((input) => <option key={input.id}>{input.id}</option>)}</select></Field></> : null}</div>
    <span className="neo-actions"><button className="neo-button" disabled={profileBlocked} onClick={save}>{editing ? "Save Method" : "Add Method"}</button><button className="neo-button" disabled={profileBlocked} onClick={() => { setEditing(false); setDraft(emptyMethod()); }}>New Method</button></span></>;
}

function DbServersPage() {
  const app = useApp();
  const loaded = useLoad((signal) => api.db.servers.list({ signal }), [app.resourceRevision]);
  const [draft, setDraft] = useState({ name: "", host: "127.0.0.1", port: 5656, user: "", password: "", database: "" });
  const [editing, setEditing] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(null);
  const [tableDraft, setTableDraft] = useState({ server: "", table: "" });
  const [tables, setTables] = useState([]);
  const save = async () => { try { if (editing) await api.db.servers.update(editing, draft); else await api.db.servers.create(draft); setDraft({ name: "", host: "127.0.0.1", port: 5656, user: "", password: "", database: "" }); setEditing(""); loaded.reload(); } catch (failure) { setError(failure); } };
  const test = async (name) => { try { const result = await api.db.connect(name); setMessage(result.reason || `Connection to ${name} succeeded.`); } catch (failure) { setError(failure); } };
  const loadTables = async (server) => { if (!server) { setTables([]); return; } try { const values = await api.db.tables.list({ server }); setTables(values.tables || values || []); } catch (failure) { setError(failure); } };
  const createTable = async () => { try { await api.db.tables.create(tableDraft); setMessage(`${tableDraft.table} created.`); await loadTables(tableDraft.server); } catch (failure) { setError(failure); } };
  const serverForm = <section className="neo-panel"><h2>{editing ? `EDIT ${editing}` : "NEW SERVER"}</h2><div className="neo-form-grid">{Object.entries(draft).map(([key, value]) => <Field label={key.toUpperCase()} key={key}><Input type={key === "password" ? "password" : key === "port" ? "number" : "text"} value={value} readOnly={editing && key === "name"} onChange={(next) => setDraft({ ...draft, [key]: key === "port" ? Number(next) : next })} /></Field>)}</div><button className="neo-button neo-button--primary" onClick={save}>{editing ? "Save" : "Create"}</button></section>;
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title="Database Servers" subtitle="Passwords are write-only." /><PageNav /><Notice error={loaded.error || error} /><Notice status>{message}</Notice><div className="neo-page-body"><section className="neo-panel"><h2>REGISTERED DATABASE SERVERS</h2>{(loaded.data || []).map((server) => <div className="neo-list-row" key={server.name}><span><strong>{server.name}</strong> {server.host}:{server.port}</span><span className="neo-actions"><button className="neo-button" onClick={() => { setEditing(server.name); setDraft({ ...server, password: "" }); }}>Edit</button><button className="neo-button" onClick={() => test(server.name)}>Test Connection</button><button className="neo-button neo-button--danger" onClick={() => api.db.servers.remove(server.name).then(loaded.reload, setError)}>Delete</button></span></div>)}</section>{editing ? serverForm : null}<section className="neo-panel"><h2>CREATE TAG TABLE</h2><div className="neo-form-grid"><Field label="Server"><select aria-label="Table server" value={tableDraft.server} onChange={(event) => { const server = event.target.value; setTableDraft({ ...tableDraft, server }); void loadTables(server); }}><option value="">Select server</option>{(loaded.data || []).map((server) => <option key={server.name}>{server.name}</option>)}</select></Field><Field label="Table Name"><Input aria-label="Table name" value={tableDraft.table} onChange={(table) => setTableDraft({ ...tableDraft, table })} /></Field></div><button className="neo-button neo-button--primary" disabled={!tableDraft.server || !tableDraft.table} onClick={createTable}>Create TAG Table</button><p>Tables: {tables.map((table) => table.name || table).join(", ") || "None"}</p></section></div></main>;
}

function CreateModalLayer() {
  const app = useApp();
  if (app.createModal === "profile") return <ProfileCreateModal />;
  if (app.createModal === "db-server") return <DatabaseServersModal />;
  return null;
}

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

function DatabaseServerDeleteConfirmModal({ name, onCancel, onConfirm }) {
  return <div className="neo-modal neo-modal--confirm" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="neo-modal__dialog neo-modal__dialog--database-confirm" role="dialog" aria-modal="true" aria-label="Delete Server"><header className="neo-modal__header"><div className="neo-modal__title"><Icon name="warning" /><h2>Delete Server</h2></div><IconButton className="neo-modal__close" icon="close" label="Close" onClick={onCancel} /></header><div className="neo-modal__body"><p>Are you sure you want to delete server &quot;{name}&quot;?</p></div><footer className="neo-modal__footer"><button className="neo-button" onClick={onCancel}>Cancel</button><button className="neo-button neo-button--danger" onClick={onConfirm}>Delete</button></footer></section></div>;
}

function DatabaseServersModal() {
  const app = useApp();
  const loaded = useLoad((signal) => api.db.servers.list({ signal }), [app.resourceRevision]);
  const [mode, setMode] = useState("list");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState({ name: "", host: "127.0.0.1", port: 5656, user: "", password: "" });
  const [error, setError] = useState(null);
  const [healthResults, setHealthResults] = useState({});
  const [pendingDelete, setPendingDelete] = useState("");
  const resetForm = () => { setMode("list"); setEditing(""); setDraft({ name: "", host: "127.0.0.1", port: 5656, user: "", password: "" }); setError(null); };
  const openCreate = () => { setEditing(""); setDraft({ name: "", host: "127.0.0.1", port: 5656, user: "", password: "" }); setError(null); setMode("form"); };
  const openEdit = (server) => { setEditing(server.name); setDraft({ ...server, password: "" }); setError(null); setMode("form"); };
  const save = async () => {
    try {
      if (editing) await api.db.servers.update(editing, draft); else await api.db.servers.create(draft);
      app.resourceChanged();
      await loaded.reload();
      resetForm();
    } catch (failure) { setError(failure); }
  };
  const test = async (name) => {
    setHealthResults((previous) => ({ ...previous, [name]: "checking" }));
    try { await api.db.connect(name); setHealthResults((previous) => ({ ...previous, [name]: "healthy" })); } catch (failure) { setHealthResults((previous) => ({ ...previous, [name]: "unhealthy" })); }
  };
  const remove = async (name) => {
    try { await api.db.servers.remove(name); setPendingDelete(""); app.resourceChanged(); await loaded.reload(); } catch (failure) { setError(failure); }
  };
  if (mode === "form") return <Modal title={editing ? "Edit Database Server" : "Add Database Server"} icon={editing ? "edit" : "add_circle"} variant="database-form" onClose={resetForm}><Notice error={error} /><div className="neo-db-server-form"><Field label="Name" wide><Input value={draft.name} readOnly={Boolean(editing)} onChange={(name) => setDraft({ ...draft, name })} /></Field><div className="neo-db-server-form__host"><Field className="neo-db-server-form__host-field" label="Host"><Input value={draft.host} onChange={(host) => setDraft({ ...draft, host })} /></Field><Field label="Port"><Input type="number" value={draft.port} onChange={(port) => setDraft({ ...draft, port: Number(port) })} /></Field></div><div className="neo-db-server-form__credentials"><Field label="User"><Input value={draft.user} onChange={(user) => setDraft({ ...draft, user })} /></Field><Field label="Password"><Input type="password" value={draft.password} onChange={(password) => setDraft({ ...draft, password })} /></Field></div></div><footer className="neo-modal__footer"><button className="neo-button" onClick={resetForm}>Cancel</button><button className="neo-button neo-button--primary" onClick={save}>{editing ? "Update" : "Create"}</button></footer></Modal>;
  return <><Modal title="Database Servers" icon="dns" variant="database" onClose={app.closeCreateModal}><Notice error={loaded.error || error} /><div className="neo-db-server-card-list">{loaded.loading ? <p className="neo-message" aria-live="polite">Loading database servers…</p> : null}{!loaded.loading && !(loaded.data || []).length ? <p className="neo-message" role="status">No database servers configured.</p> : null}{(loaded.data || []).map((server) => <div className="neo-db-server-card" key={server.name}><div className="neo-db-server-card__info"><div className="neo-db-server-card__name"><Icon name="database" /><strong>{server.name}</strong>{healthResults[server.name] ? <span className={`neo-db-server-status neo-db-server-status--${healthResults[server.name]}`}><span />{healthResults[server.name] === "checking" ? "Checking..." : healthResults[server.name] === "healthy" ? "Connected" : "Failed"}</span> : null}</div><small>{server.host}:{server.port} · {server.user}</small></div><span className="neo-db-server-card__actions"><IconButton className="neo-db-server-card__action" icon="electrical_services" label="Connection Test" onClick={() => test(server.name)} /><IconButton className="neo-db-server-card__action" icon="edit" label="Edit" onClick={() => openEdit(server)} /><IconButton className="neo-db-server-card__action neo-db-server-card__action--danger" icon="delete" label="Delete" onClick={() => setPendingDelete(server.name)} /></span></div>)}</div><footer className="neo-modal__footer"><button className="neo-button" onClick={app.closeCreateModal}>Close</button><button className="neo-button neo-button--primary" onClick={openCreate}><Icon name="add" />Add Server</button></footer></Modal>{pendingDelete ? <DatabaseServerDeleteConfirmModal name={pendingDelete} onCancel={() => setPendingDelete("")} onConfirm={() => remove(pendingDelete)} /> : null}</>;
}

function VirtualRows({ rows }) {
  const parentRef = useRef(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 28, overscan: 8 });
  return <div className="neo-virtual" ref={parentRef} role="grid" aria-label="Data rows"><div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>{virtualizer.getVirtualItems().map((item) => { const row = displayGridRow(rows[item.index]); return <div className="neo-virtual__row" role="row" key={item.key} style={{ transform: `translateY(${item.start}px)` }}><span>{row.time}</span><span>{row.name}</span><span>{String(row.value)}</span></div>; })}</div></div>;
}

function Chart({ series }) {
  const ref = useRef(null);
  useEffect(() => { if (!ref.current) return undefined; const chart = echarts.init(ref.current); chart.setOption({ backgroundColor: "transparent", textStyle: { color: "#c4c4c4" }, tooltip: { trigger: "axis" }, xAxis: { type: "time" }, yAxis: { type: "value" }, series: (series || []).map((item) => ({ name: item.name, data: item.data || (item.points || []).map((point) => [point.time, point.value]), type: "line", showSymbol: false })) }); return () => chart.dispose(); }, [series]);
  return <div ref={ref} className="neo-chart" role="img" aria-label="Selected numeric Tag chart" />;
}

function DataViewer() {
  const { name = "" } = useParams();
  const loaded = useLoad((signal) => api.jobs.get(name, { signal }), [name]);
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState("grid");
  const [query, setQuery] = useState({ from: "", to: "", cursor: "", direction: "latest", rowsPerTag: 100 });
  const [result, setResult] = useState({ rows: [], series: [] });
  const [error, setError] = useState(null);
  const [chartEvidence, setChartEvidence] = useState(() => new Set());
  const [availableTags, setAvailableTags] = useState(null);
  const [availabilityMessage, setAvailabilityMessage] = useState("");
  const dataRequest = useLatestRequest();
  const config = loaded.data?.config || {};
  const tree = buildJobTree(name, config);
  const jobTagNames = (config.methodCalls || []).flatMap((call) => (call.tags || []).map((tag) => tag.name));
  const jobTagFingerprint = jobTagNames.join("\u0000");
  useEffect(() => {
    const { server, table } = config.database || {};
    if (!server || !table) { setAvailableTags(null); setAvailabilityMessage(""); return undefined; }
    const controller = new AbortController();
    api.db.tables.tags({ server, table }, { signal: controller.signal }).then((data) => {
      const stored = new Set((data?.tags || []).map((tag) => tag.name));
      setAvailableTags(new Set(jobTagNames.filter((tagName) => stored.has(tagName))));
      setAvailabilityMessage("");
    }, (failure) => {
      if (failure?.name === "AbortError") return;
      setAvailableTags(null);
      setAvailabilityMessage("Tag availability could not be checked. Grid and Chart queries are still available.");
    });
    return () => controller.abort();
  }, [config.database?.server, config.database?.table, jobTagFingerprint]);
  const resetPaging = (patch = {}) => {
    dataRequest.cancel();
    setQuery((current) => ({ ...current, ...patch, cursor: "" }));
    setResult({ rows: [], series: [], nextCursor: null, previousCursor: null });
  };
  const run = async (cursor = "") => {
    const request = dataRequest.begin();
    try {
      const params = { job: name, names: selected ? [selected] : [], from: query.from || undefined, to: query.to || undefined, cursor: cursor || undefined, direction: query.direction, rowsPerTag: query.rowsPerTag };
      const data = mode === "chart" ? await api.db.tables.chart(params, { signal: request.signal }) : await api.db.tables.data(params, { signal: request.signal });
      if (!request.isCurrent()) return;
      setResult(data || {});
      if (mode === "grid") setChartEvidence((current) => {
        const next = new Set(current);
        const key = chartEvidenceKey(selected, query.from, query.to);
        if (hasCompleteNumericEvidence(data, { name: selected, cursor })) next.add(key); else next.delete(key);
        return next;
      });
      setQuery((current) => ({ ...current, cursor: cursor || "" }));
    } catch (failure) {
      if (request.isCurrent() && failure?.name !== "AbortError") setError(failure);
    } finally {
      request.finish();
    }
  };
  const eligible = chartEvidence.has(chartEvidenceKey(selected, query.from, query.to));
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title={`Data Viewer · ${name}`}><Link className="neo-button" to={`/jobs/${encodeURIComponent(name)}`}>Job</Link></MainHeader><div className="neo-data-layout"><aside className="neo-tree" aria-label="Current Job tags">{tree.map((job) => <div key={job.name}><strong>{job.name}</strong>{job.calls.map((call) => <details open key={call.id}><summary>{call.name}</summary>{call.tags.map((tag) => { const available = availableTags === null ? undefined : availableTags.has(tag.name); return <button className={`${selected === tag.name ? "is-selected" : ""}${available === false ? " is-unavailable" : ""}`.trim()} data-available={available} title={available === false ? "Tag is not currently available in the mapped table." : undefined} key={tag.name} onClick={() => { setSelected(tag.name); setMode("grid"); resetPaging(); }}>{tag.name}</button>; })}</details>)}</div>)}</aside><section className="neo-data-content"><Notice error={loaded.error || error} /><Notice status>{availabilityMessage}</Notice><div className="neo-toolbar"><select aria-label="Viewer mode" value={mode} onChange={(event) => setMode(event.target.value)}><option value="grid">Grid</option><option value="chart">Chart</option></select><Input aria-label="Start time" placeholder="2026-08-01T00:00:00Z" value={query.from} onChange={(from) => resetPaging({ from })} /><Input aria-label="End time" placeholder="2026-08-01T00:00:00Z" value={query.to} onChange={(to) => resetPaging({ to })} /><select aria-label="Direction" value={query.direction} onChange={(event) => resetPaging({ direction: event.target.value })}><option value="latest">Latest</option><option value="oldest">Oldest</option></select><Input aria-label="Rows per tag" type="number" value={query.rowsPerTag} onChange={(rowsPerTag) => resetPaging({ rowsPerTag: Number(rowsPerTag) })} /><button className="neo-button neo-button--primary" disabled={!selected || (mode === "chart" && !eligible)} onClick={() => run()}>Load</button></div>{mode === "chart" && selected && !eligible ? <Notice status>Narrow the range, then load the entire numeric Tag in Grid before using Chart.</Notice> : null}<div className="neo-toolbar neo-pagination"><button className="neo-button" aria-label="Previous page" disabled={!result.previousCursor || mode !== "grid"} onClick={() => run(result.previousCursor)}>Previous</button><button className="neo-button" aria-label="Next page" disabled={!result.nextCursor || mode !== "grid"} onClick={() => run(result.nextCursor)}>Next</button></div>{mode === "chart" ? <Chart series={result.series || []} /> : <VirtualRows rows={result.rows || []} />}</section></div></main>;
}

function LogsPage() {
  const params = useParams();
  const name = params.name || "";
  const loaded = useLoad((signal) => name ? api.logs.list(name, { signal }) : api.logs.all({ signal }), [name]);
  const [file, setFile] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState(null);
  const read = async (kind) => { try { const result = await api.logs[kind](name, file); setContent(typeof result.content === "string" ? result.content : Array.isArray(result.lines) ? result.lines.join("\n") : ""); } catch (failure) { setError(failure); } };
  const files = loaded.data?.files || [];
  return <main className="neo-main" aria-label="DBus Collector main"><MainHeader title={name ? `Logs · ${name}` : "All Logs"}>{name ? <Link className="neo-button" to={`/jobs/${encodeURIComponent(name)}`}>Job</Link> : null}</MainHeader><PageNav /><Notice error={loaded.error || error} /><div className="neo-page-body"><section className="neo-panel"><h2>{name ? "LOG FILES" : "JOB LOGS"}</h2>{name ? <><select aria-label="Log file" value={file} onChange={(event) => setFile(event.target.value)}><option value="">Select file</option>{files.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select><span className="neo-actions"><button className="neo-button" disabled={!file} onClick={() => read("content")}>Content</button><button className="neo-button" disabled={!file} onClick={() => read("contentAll")}>All</button><button className="neo-button" disabled={!file} onClick={() => read("tail")}>Tail</button></span></> : <pre className="neo-code">{JSON.stringify(loaded.data?.jobs || [], null, 2)}</pre>}</section>{name ? <pre className="neo-code neo-log-content">{content || "Select a log file."}</pre> : null}</div></main>;
}

export function MainRoutes() {
  return <Routes><Route path="/" element={<Home />} /><Route path="/jobs/new" element={<JobForm mode="new" />} /><Route path="/jobs/:name/edit" element={<JobForm mode="edit" />} /><Route path="/jobs/:name" element={<JobDetail />} /><Route path="/profiles" element={<ProfilesPage />} /><Route path="/db-servers" element={<DbServersPage />} /><Route path="/data/:name" element={<DataViewer />} /><Route path="/logs/:name" element={<LogsPage />} /><Route path="/logs" element={<LogsPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>;
}

export { MemoryRouter };

export function CombinedApp() { return <AppProvider surface="index"><div className="neo-index"><ConnectedSide /><MainRoutes /></div><CreateModalLayer /></AppProvider>; }
export function MainApp() { return <AppProvider surface="main"><MainRoutes /><CreateModalLayer /></AppProvider>; }
export function SideApp() { return <AppProvider surface="side"><ConnectedSide /></AppProvider>; }
