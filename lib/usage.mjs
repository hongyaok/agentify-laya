// lib/usage.mjs — zero-dep usage recording for agentify-laya.
// Append-only JSONL under data/events.jsonl + in-memory aggregates.
// Never throws: every public function guards internally.
// Privacy: stores counts and timings only. No state, questions, answers, or headers.
import { mkdir, appendFile, readFile, writeFile, stat, rename } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MAX_EVENTS = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || "data");
let eventsFile = path.join(dataDir, "events.jsonl");
let keyFile = path.join(dataDir, "api-key.txt");

const events = [];
let apiKey = null;
let startedAt = Date.now();

function qTypesOf(questions) {
  const t = { choice: 0, score: 0, noul: 0 };
  if (questions && typeof questions === "object") {
    for (const q of Object.values(questions)) {
      if (q?.type === "choice") t.choice += 1;
      else if (q?.type === "score") t.score += 1;
      else if (q?.type === "noul") t.noul += 1;
    }
  }
  return t;
}

function qCountOf(questions) {
  if (!questions || typeof questions !== "object") return 0;
  return Object.keys(questions).length;
}

export function getDataDir() {
  return dataDir;
}

export async function initUsage(opts = {}) {
  try {
    // Read DATA_DIR lazily here (not at module top): server.mjs calls
    // process.loadEnvFile() after imports are hoisted, so a DATA_DIR set
    // in .env is only visible at this point, not during module evaluation.
    const raw = opts.dataDir || process.env.DATA_DIR || "data";
    dataDir = path.resolve(process.cwd(), raw);
    eventsFile = path.join(dataDir, "events.jsonl");
    keyFile = path.join(dataDir, "api-key.txt");
    await mkdir(dataDir, { recursive: true });
    await ensureApiKey();
    await loadTail(2000);
  } catch {
    // never break boot on usage init
  }
}

async function ensureApiKey() {
  try {
    apiKey = (await readFile(keyFile, "utf8")).trim();
    if (apiKey) return apiKey;
  } catch {}
  try {
    apiKey = process.env.LAYA_API_KEY?.trim() || `laya_${randomBytes(24).toString("hex")}`;
    await appendNewKey(apiKey);
    return apiKey;
  } catch {
    apiKey = apiKey || `laya_${randomBytes(24).toString("hex")}`;
    return apiKey;
  }
}

async function appendNewKey(key) {
  // Stable key: exclusive create wins, concurrent starts read the winner.
  try {
    await writeFile(keyFile, key + "\n", { flag: "wx" });
  } catch (e) {
    if (e?.code !== "EEXIST") return key;
  }
  try {
    const winner = (await readFile(keyFile, "utf8")).trim();
    apiKey = winner || key;
  } catch {
    apiKey = key;
  }
  return apiKey;
}

export function getApiKey() {
  return apiKey;
}

async function loadTail(maxLines) {
  try {
    const st = await stat(eventsFile).catch(() => null);
    if (!st) return;
    const raw = await readFile(eventsFile, "utf8").catch(() => "");
    if (!raw) return;
    const lines = raw.trim().split("\n").slice(-maxLines);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e && typeof e.ts === "number") {
          events.push(e);
        }
      } catch {}
    }
    while (events.length > MAX_EVENTS) events.shift();
  } catch {}
}

async function rotateIfNeeded() {
  try {
    const st = await stat(eventsFile).catch(() => null);
    if (st && st.size > MAX_FILE_BYTES) {
      await rename(eventsFile, eventsFile + ".1").catch(() => {});
    }
  } catch {}
}

export async function record(entry) {
  try {
    const now = Date.now();
    const e = {
      ts: entry.ts ?? now,
      iso: entry.iso ?? new Date(entry.ts ?? now).toISOString(),
      endpoint: entry.endpoint ?? "unknown",
      status: entry.status ?? 0,
      latency_ms: entry.latency_ms ?? 0,
      input_tokens: entry.input_tokens ?? 0,
      output_tokens: 0,
      q_count: entry.q_count ?? 0,
      q_types: entry.q_types ?? { choice: 0, score: 0, noul: 0 },
      mock: Boolean(entry.mock),
    };
    if (entry.error_code) e.error_code = String(entry.error_code);
    events.push(e);
    while (events.length > MAX_EVENTS) events.shift();
    await mkdir(dataDir, { recursive: true }).catch(() => {});
    await appendFile(eventsFile, JSON.stringify(e) + "\n", "utf8").catch(() => {});
    // cheap rotation check (no await chain blocking)
    rotateIfNeeded();
    return e;
  } catch {
    return null;
  }
}

export function buildRecord({ endpoint, status, latencyMs, usage, questions, mock, errorCode }) {
  return {
    endpoint,
    status,
    latency_ms: Math.round(latencyMs ?? 0),
    input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
    q_count: qCountOf(questions),
    q_types: qTypesOf(questions),
    mock: Boolean(mock),
    error_code: errorCode,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function getSummary() {
  const totalRequests = events.length;
  let totalInputTokens = 0;
  const byEndpoint = { "system-one": 0, chat: 0 };
  const byStatus = {};
  const qTypes = { choice: 0, score: 0, noul: 0 };
  const lat = [];
  let errors = 0;
  for (const e of events) {
    totalInputTokens += e.input_tokens || 0;
    if (e.endpoint === "system-one" || e.endpoint === "chat") {
      byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] || 0) + 1;
    }
    const code = String(e.status || 0);
    byStatus[code] = (byStatus[code] || 0) + 1;
    if (e.status >= 400) errors += 1;
    qTypes.choice += e.q_types?.choice || 0;
    qTypes.score += e.q_types?.score || 0;
    qTypes.noul += e.q_types?.noul || 0;
    lat.push(e.latency_ms || 0);
  }
  lat.sort((a, b) => a - b);
  const avg = lat.length ? lat.reduce((s, v) => s + v, 0) / lat.length : 0;
  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens: 0,
    outputNote: "Laya is classifier-only; output_tokens is always 0.",
    byEndpoint,
    byStatus,
    qTypes,
    errors,
    errorRate: totalRequests ? errors / totalRequests : 0,
    latency: {
      avg_ms: Math.round(avg * 10) / 10,
      p50_ms: percentile(lat, 50),
      p95_ms: percentile(lat, 95),
      max_ms: lat.length ? lat[lat.length - 1] : 0,
    },
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
  };
}

export function getSeries(range = "24h") {
  const hours = range === "7d" ? 24 * 7 : 24;
  const now = Date.now();
  const buckets = [];
  for (let i = hours - 1; i >= 0; i--) {
    const t = new Date(now - i * 3600 * 1000);
    t.setMinutes(0, 0, 0);
    buckets.push({ hour: t.toISOString(), requests: 0, input_tokens: 0, errors: 0 });
  }
  const idx = new Map(buckets.map((b, i) => [b.hour.slice(0, 13), i]));
  for (const e of events) {
    const key = new Date(e.ts);
    key.setMinutes(0, 0, 0);
    const k = key.toISOString().slice(0, 13);
    const i = idx.get(k);
    if (i !== undefined) {
      buckets[i].requests += 1;
      buckets[i].input_tokens += e.input_tokens || 0;
      if (e.status >= 400) buckets[i].errors += 1;
    }
  }
  return { range, buckets };
}

export function getHeatmap(days = 14) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400 * 1000);
    const next = d.getTime() + 86400 * 1000;
    let requests = 0;
    let tokens = 0;
    for (const e of events) {
      if (e.ts >= d.getTime() && e.ts < next) {
        requests += 1;
        tokens += e.input_tokens || 0;
      }
    }
    out.push({ day: d.toISOString().slice(0, 10), requests, input_tokens: tokens });
  }
  return { days, cells: out };
}

export function getLogs(limit = 100, offset = 0) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  const slice = events.slice().reverse().slice(off, off + n);
  return { total: events.length, limit: n, offset: off, logs: slice };
}
