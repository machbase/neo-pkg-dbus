const defaultApiBase = "/public/neo-pkg-dbus/cgi-bin/api";
const publicPackagePaths = ["/public/neo-pkg-dbus"];

export function resolveApiBase(pathname = globalThis.location?.pathname) {
  if (typeof pathname !== "string") return defaultApiBase;
  const packagePath = pathname.match(/^\/public\/[^/]+(?=\/|$)/)?.[0];
  return publicPackagePaths.includes(packagePath) ? `${packagePath}/cgi-bin/api` : defaultApiBase;
}

export const apiBase = resolveApiBase();

export class ApiError extends Error {
  constructor({ status = null, code = "REQUEST_FAILED", reason = "Request could not be completed.", details = {} }) {
    super(reason);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details || {};
  }
}

function queryPath(path, values = {}) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

async function request(path, { method = "GET", body, signal } = {}) {
  const options = { method, signal };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${resolveApiBase()}${path}`, options);
  } catch (failure) {
    if (failure && failure.name === "AbortError") throw failure;
    throw new ApiError({ code: "NETWORK_ERROR", reason: failure?.message || "Network request failed." });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    throw new ApiError({ status: response.status, code: "INVALID_RESPONSE", reason: "Unable to read server response." });
  }
  if (!response.ok || !payload || payload.ok !== true) {
    throw new ApiError({
      status: response.status,
      code: payload?.code || "REQUEST_FAILED",
      reason: payload?.reason || "Request could not be completed.",
      details: payload?.details || {},
    });
  }
  return payload.data;
}

const get = (path, values, options = {}) => request(queryPath(path, values), options);
const send = (method, path, body, options = {}) => request(path, { ...options, method, body });
const named = (path, name) => queryPath(path, { name });

export const api = {
  settings: {
    get: (options) => request("/settings", options),
    update: (settings, options) => send("PUT", "/settings", { limits: settings?.limits || {}, ...(settings?.defaults ? { defaults: settings.defaults } : {}), ...(settings?.logging ? { logging: settings.logging } : {}) }, options),
  },
  interfaces: {
    list: (options) => request("/dbus-interface/list", options),
    get: (id, options) => get("/dbus-interface", { id }, options),
    discover: (connection, options) => send("POST", "/dbus-interface/discover", connection, options),
    create: (value, options) => send("POST", "/dbus-interface", value, options),
    update: (value, options) => send("PUT", "/dbus-interface", value, options),
    updateDiscovered: (value, options) => send("PUT", "/dbus-interface?discover=true", value, options),
    remove: (id, options) => request(queryPath("/dbus-interface", { id }), { ...options, method: "DELETE" }),
  },
  methods: {
    create: (interfaceId, method, options) => send("POST", "/dbus-method", { interfaceId, method }, options),
    update: (interfaceId, methodId, method, options) => send("PUT", "/dbus-method", { interfaceId, methodId, method }, options),
    remove: (interfaceId, methodId, options) => request(queryPath("/dbus-method", { interfaceId, methodId }), { ...options, method: "DELETE" }),
  },
  jobs: {
    list: (options) => request("/job/list", options),
    get: (name, options) => get("/job", { name }, options),
    status: (name, options) => get("/job/status", { name }, options),
    create: (name, config, options) => send("POST", "/job", { name, config }, options),
    update: (name, patch, options) => send("PUT", named("/job", name), Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "name")), options),
    updateLogLevel: (name, patch, options) => send("PUT", named("/job/log", name), patch, options),
    remove: (name, options) => request(named("/job", name), { ...options, method: "DELETE" }),
    validate: (draft, options) => send("POST", "/job/validate", draft, options),
    start: (name, options) => send("POST", named("/job/start", name), undefined, options),
    stop: (name, options) => send("POST", named("/job/stop", name), undefined, options),
    lastRun: (name, options) => get("/job/last-run", { name }, options),
    clearOverrun: (name, options) => send("POST", named("/job/overrun/reset", name), undefined, options),
  },
  dbus: {
    call: ({ interfaceId, methodId, inputs }, options) => send("POST", "/dbus/call", { interfaceId, methodId, inputs }, options),
  },
  db: {
    servers: {
      list: (options) => request("/db/server/list", options),
      get: (name, options) => get("/db/server", { name }, options),
      create: (server, options) => send("POST", "/db/server", server, options),
      update: (name, server, options) => send("PUT", queryPath("/db/server", { name }), server, options),
      remove: (name, options) => request(queryPath("/db/server", { name }), { ...options, method: "DELETE" }),
    },
    connect: (server, options) => get("/db/connect", { server }, options),
    preview: {
      tables: (connection, options) => send("POST", "/db/preview/tables", connection, options),
      columns: (request, options) => send("POST", "/db/preview/columns", request, options),
    },
    tables: {
      create: (table, options) => send("POST", "/db/table/create", table, options),
      list: (params, options) => get("/db/table/list", params, options),
      columns: (params, options) => get("/db/table/columns", params, options),
      tags: (params, options) => get("/db/table/tags", params, options),
      data: (params, options) => get("/db/table/data", params, options),
      stat: (params, options) => get("/db/table/stat", params, options),
      chart: (params, options) => get("/db/table/chart", params, options),
    },
  },
  logs: {
    all: (options) => request("/log/all", options),
    list: (name, options) => get("/log/list", { name }, options),
    content: (name, file, options) => get("/log/content", { name, file }, options),
    contentAll: (name, file, options) => get("/log/content/all", { name, file }, options),
    tail: (name, file, options) => get("/log/tail", { name, file }, options),
  },
};
