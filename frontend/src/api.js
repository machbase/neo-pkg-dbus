export const apiBase = "/public/neo-pkg-dbus/cgi-bin/api";
export const REQUEST_TIMEOUT_MS = 10000;

export class ApiError extends Error {
  constructor({ kind, status, message, data = null }) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.data = data;
  }
}

function actionPath(path, name) {
  return `${path}?${new URLSearchParams({ name }).toString()}`;
}

function errorKind(response, payload, controllerOn503) {
  if (payload && payload.kind === "controller") return "controller";
  return (controllerOn503 && response.status === 503)
    || (response.status >= 500 && payload && payload.data && typeof payload.data === "object")
    ? "controller"
    : "cgi";
}

function errorMessage(payload) {
  return (payload && payload.data && payload.data.error)
    || (payload && payload.error)
    || "Request could not be completed.";
}

function requestSignal(parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

async function request(path, options = {}, { controllerOn503 = false } = {}) {
  const controlled = requestSignal(options.signal);
  const requestOptions = { ...options, signal: controlled.signal };
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, requestOptions);
  } catch (error) {
    controlled.cleanup();
    if (controlled.timedOut()) {
      throw new ApiError({
        kind: "network",
        status: null,
        message: "Request timed out.",
      });
    }
    if (error && error.name === "AbortError") throw error;
    throw new ApiError({
      kind: "network",
      status: null,
      message: error && error.message ? error.message : "Network request failed.",
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    controlled.cleanup();
    if (controlled.timedOut()) {
      throw new ApiError({
        kind: "network",
        status: null,
        message: "Request timed out.",
      });
    }
    if (error && error.name === "AbortError") throw error;
    throw new ApiError({
      kind: "cgi",
      status: response.status,
      message: "Unable to read server response.",
    });
  }
  controlled.cleanup();
  if (!response.ok || !payload || payload.ok !== true) {
    throw new ApiError({
      kind: errorKind(response, payload, controllerOn503),
      status: response.status,
      message: errorMessage(payload),
      data: payload && payload.data !== undefined ? payload.data : null,
    });
  }
  return payload.data;
}

function post(path, body, signal, context) {
  const options = { method: "POST", signal };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return request(path, options, context);
}

export const jobsApi = {
  list: ({ signal } = {}) => request("/jobs/list", { signal }),
  health: ({ signal } = {}) => request("/health", { signal }),
  create: (name, config, { signal } = {}) => post("/jobs/create", { name, config }, signal),
  update: (name, config, { signal } = {}) => post("/jobs/update", { name, config }, signal),
  start: (name, { signal } = {}) => post(actionPath("/jobs/start", name), undefined, signal),
  stop: (name, { signal } = {}) => post(actionPath("/jobs/stop", name), undefined, signal),
  remove: (name, { signal } = {}) => post(actionPath("/jobs/delete", name), undefined, signal),
};

export const serviceApi = {
  health: ({ signal } = {}) => request("/health", { signal }, { controllerOn503: true }),
  start: ({ signal } = {}) => post("/service/start", undefined, signal, { controllerOn503: true }),
  stop: ({ signal } = {}) => post("/service/stop", undefined, signal, { controllerOn503: true }),
};
