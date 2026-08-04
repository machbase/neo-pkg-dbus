export const apiBase = "/public/neo-pkg-dbus/cgi-bin/api";

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
    response = await fetch(`${apiBase}${path}`, options);
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
    update: (settings, options) => send("PUT", "/settings", settings, options),
  },
  profiles: {
    list: (options) => request("/profile/list", options),
    get: (id, options) => get("/profile", { id }, options),
    create: (profile, options) => send("POST", "/profile", profile, options),
    update: (profile, options) => send("PUT", "/profile", profile, options),
    remove: (id, options) => request(queryPath("/profile", { id }), { ...options, method: "DELETE" }),
  },
  methods: {
    list: (profileId, options) => get("/method/list", { profileId }, options),
    get: (profileId, id, options) => get("/method", { profileId, id }, options),
    create: (profileId, method, options) => send("POST", "/method", { profileId, method }, options),
    update: (profileId, method, options) => send("PUT", "/method", { profileId, method }, options),
    remove: (profileId, id, options) => request(queryPath("/method", { profileId, id }), { ...options, method: "DELETE" }),
  },
  jobs: {
    list: (options) => request("/job/list", options),
    get: (name, options) => get("/job", { name }, options),
    create: (name, config, options) => send("POST", "/job", { name, config }, options),
    update: (name, patch, options) => send("PUT", named("/job", name), Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "name")), options),
    remove: (name, options) => request(named("/job", name), { ...options, method: "DELETE" }),
    validate: (draft, options) => send("POST", "/job/validate", draft, options),
    install: (name, options) => send("POST", named("/job/install", name), undefined, options),
    start: (name, options) => send("POST", named("/job/start", name), undefined, options),
    stop: (name, options) => send("POST", named("/job/stop", name), undefined, options),
    lastRun: (name, options) => get("/job/last-run", { name }, options),
  },
  dbus: {
    call: (draft, options) => send("POST", "/dbus/call", {
      profile: draft.profile,
      method: draft.method,
      dbus: draft.dbus,
      inputs: draft.inputs,
    }, options),
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
    tables: {
      create: (table, options) => send("POST", "/db/table/create", table, options),
      list: (params, options) => get("/db/table/list", params, options),
      columns: (params, options) => get("/db/table/columns", params, options),
      tags: (params, options) => get("/db/table/tags", params, options),
      data: (params, options) => get("/db/table/data", params, options),
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
