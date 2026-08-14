import { api } from "../api";

function normalizedNames(names) {
  return Array.isArray(names)
    ? names.map((name) => String(name || "").trim()).filter(Boolean)
    : names;
}

export function listTableTags({ job, server, table }) {
  return api.db.tables.tags({ job, server, table });
}

export function queryTagData({ job, server, table, names, valueColumn, stringValueColumn, direction, from, to, page, pageSize, boundedRange, cursorSide, cursorTime, cursorName, cursorOffset }) {
  return api.db.tables.data({
    job, server, table, names: normalizedNames(names), valueColumn, stringValueColumn,
    direction, from, to, page: boundedRange ? undefined : page, pageSize, boundedRange,
    cursorSide, cursorTime, cursorName, cursorOffset,
  });
}

export async function queryTagBoundaryTime({ job, server, table, names, direction }) {
  const data = await api.db.tables.stat({ job, server, table, names: normalizedNames(names) });
  return (direction === "oldest" ? data?.minTime : data?.maxTime) || null;
}

export function queryTagDataTotal({ job, server, table, names, valueColumn, stringValueColumn, direction, from, to, pageSize }) {
  return api.db.tables.data({
    job, server, table, names: normalizedNames(names), includeTotal: true,
    valueColumn, stringValueColumn, direction, from, to, pageSize,
  });
}

function toEpochMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return Number.NaN;
    return Math.abs(value) > 100000000000000 ? value / 1000000 : value;
  }
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? toEpochMs(numeric) : Date.parse(text);
}

export function buildSeriesFromChartRows(rows = []) {
  const seriesByName = new Map();
  rows.forEach((row) => {
    if (!Array.isArray(row) || row.length < 3) return;
    const time = toEpochMs(row[0]);
    const name = String(row[1] ?? "").trim();
    const value = row[2] === null || row[2] === "" ? null : Number(row[2]);
    if (!name || !Number.isFinite(time) || (value !== null && !Number.isFinite(value))) return;
    if (!seriesByName.has(name)) seriesByName.set(name, []);
    seriesByName.get(name).push([time, value]);
  });
  return Array.from(seriesByName.entries()).map(([name, data]) => ({
    name,
    data: data.sort((left, right) => left[0] - right[0]),
  }));
}

async function queryNeoWeb(query) {
  let token = "";
  let consoleId = "";
  try {
    token = globalThis.localStorage?.getItem?.("accessToken") || "";
    consoleId = globalThis.localStorage?.getItem?.("consoleId") || "";
  } catch (_) {}
  if (!token) throw new Error("Neo Web login is required before running chart queries.");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  if (consoleId) headers["X-Console-Id"] = consoleId;
  const response = await fetch(`/web/api/query?q=${encodeURIComponent(query)}`, { headers });
  const payload = await response.json();
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.reason || payload?.message || `Web API request failed (${response.status})`);
  }
  return Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
}

// Kept with the raw-row chart path so an embedded Neo Web screen can execute
// the same validated Chart query as the original OPC UA Data Viewer.
export async function queryTagChartData({ job, server, table, names, valueColumn, stringValueColumn, from, to }) {
  const chart = await api.db.tables.chart({
    job, server, table, names: normalizedNames(names), valueColumn, stringValueColumn, from, to,
  });
  const rows = await queryNeoWeb(chart.query);
  return { ...chart, rows, series: buildSeriesFromChartRows(rows) };
}
