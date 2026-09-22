import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadModel, systemOne, getStatus, closeModel } from "./lib/laya-client.mjs";
import {
  initUsage,
  record,
  buildRecord,
  getSummary,
  getSeries,
  getHeatmap,
  getLogs,
  getApiKey,
} from "./lib/usage.mjs";

try {
  process.loadEnvFile();
} catch {}

const PORT = parseInt(process.env.PORT ?? "3777", 10) || 0;
const HOST = process.env.HOST ?? "127.0.0.1";
const SKIP_WARMUP = process.env.SKIP_WARMUP === "1";
const BODY_LIMIT = 1024 * 1024;

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
let cachedIndexHtml = null;
const VENDOR_FILES = new Set(["react.min.js", "react-dom.min.js"]);
let cachedVendor = {};

async function serveVendor(name, res) {
  if (!VENDOR_FILES.has(name)) {
    return errRes(res, 404, "Not found", "invalid_request_error");
  }
  try {
    if (!cachedVendor[name]) {
      cachedVendor[name] = await readFile(path.join(ROOT_DIR, "public", "vendor", name), "utf8");
    }
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(cachedVendor[name]);
  } catch {
    return errRes(res, 404, "Vendor file missing. Run npm run setup.", "invalid_request_error");
  }
}

function maybeOpenBrowser(url) {
  if (process.env.NO_BROWSER === "1" || process.env.CI === "true") return;
  if (PORT === 0) return;
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") return;
  try {
    const opts = { stdio: "ignore", detached: true, windowsHide: true };
    let cmd;
    let args;
    if (process.platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, opts);
    child.on("error", () => {});
    child.unref();
  } catch {}
}

try {
  await initUsage();
} catch {}

function isMock() {
  const v = process.env.MOCK_LAYA;
  return v === "1" || v === "true";
}

function loadedFlag() {
  try {
    const s = getStatus();
    if (typeof s === "boolean") return s;
    if (s && typeof s === "object") {
      if (typeof s.loaded === "boolean") return s.loaded;
      if (typeof s.ready === "boolean") return s.ready;
    }
    return false;
  } catch {
    return false;
  }
}

// Single-flight model load
let loadPromise = null;
function ensureLoaded() {
  if (loadedFlag()) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = Promise.resolve()
      .then(() => loadModel())
      .catch((err) => {
        loadPromise = null;
        throw err;
      })
      .then(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function errRes(res, status, message, type = "invalid_request_error", code) {
  const error = { message, type };
  if (code !== undefined) error.code = code;
  sendJson(res, status, { error });
}

async function serveIndex(req, res) {
  try {
    if (!cachedIndexHtml) {
      cachedIndexHtml = await readFile(path.join(ROOT_DIR, "public", "index.html"), "utf8");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(cachedIndexHtml);
  } catch {
    return errRes(res, 404, "Dashboard not built", "invalid_request_error");
  }
}

function baseUrlFrom(req) {
  const host = req.headers?.host || `${HOST}:${PORT}`;
  return `http://${host}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"]);
    if (Number.isFinite(len) && len > BODY_LIMIT) {
      reject({ status: 413, message: "Request body too large" });
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        rejected = true;
        reject({ status: 413, message: "Request body too large" });
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject({ status: 400, message: "Invalid JSON body" });
      }
    });
    req.on("error", () => reject({ status: 400, message: "Error reading body" }));
  });
}

function isEmptyQuestions(q) {
  if (q === undefined || q === null) return true;
  if (Array.isArray(q)) return q.length === 0;
  if (typeof q === "object") return Object.keys(q).length === 0;
  return true;
}

function msgText(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  if (c === undefined || c === null) return "";
  return String(c);
}

function tryParseJson(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function resolveChatInput(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const userMsgs = messages.filter((m) => m?.role === "user");
  const sysMsgs = messages.filter((m) => m?.role === "system");

  // State
  let state;
  if (body?.laya?.state !== undefined) {
    state = body.laya.state;
  } else {
    const lastUser = userMsgs[userMsgs.length - 1];
    const parsed = lastUser ? tryParseJson(msgText(lastUser)) : null;
    if (parsed && typeof parsed === "object" && parsed.state !== undefined) {
      state = parsed.state;
    } else {
      const text = userMsgs.map(msgText).filter((t) => t).join("\n");
      state = { text };
    }
  }

  // Questions
  let questions;
  if (body?.laya?.questions !== undefined) {
    questions = body.laya.questions;
  } else {
    const lastUser = userMsgs[userMsgs.length - 1];
    const parsed = lastUser ? tryParseJson(msgText(lastUser)) : null;
    if (parsed && typeof parsed === "object" && parsed.questions !== undefined) {
      questions = parsed.questions;
    } else {
      for (const m of sysMsgs) {
        const p = tryParseJson(msgText(m));
        if (p && typeof p === "object" && p.questions !== undefined) {
          questions = p.questions;
          break;
        } else if (p && typeof p === "object" && !p.state && !p.laya) {
          // raw questions object (or array) sitting directly in system content
          if (Array.isArray(p) || Object.keys(p).length > 0) {
            questions = p;
            break;
          }
        }
      }
    }
  }
  return { state, questions };
}

function isLayaLimitError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.code === "laya_limit") return true;
  const msg = String(err.message ?? "");
  return /laya_limit|head_max_len|max_len|exceeds|too many options|too long/i.test(msg);
}

async function handleSystemOne(req, res) {
  const t0 = performance.now();
  const mock = isMock();
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    void record(buildRecord({ endpoint: "system-one", status: e.status ?? 400, latencyMs: performance.now() - t0, questions: undefined, mock, errorCode: "bad_request" }));
    return errRes(res, e.status ?? 400, e.message ?? "Bad request");
  }
  const questions = body?.questions;
  if (isEmptyQuestions(questions)) {
    void record(buildRecord({ endpoint: "system-one", status: 400, latencyMs: performance.now() - t0, questions, mock, errorCode: "missing_questions" }));
    return errRes(res, 400, "Missing or empty questions");
  }
  const state = body?.state;
  try {
    await ensureLoaded();
    const result = await systemOne(state, questions);
    void record(buildRecord({ endpoint: "system-one", status: 200, latencyMs: performance.now() - t0, usage: result?.usage, questions, mock }));
    sendJson(res, 200, { ...result, laya_usage: result?.usage });
  } catch (err) {
    if (isLayaLimitError(err)) {
      void record(buildRecord({ endpoint: "system-one", status: 400, latencyMs: performance.now() - t0, questions, mock, errorCode: "laya_limit" }));
      return errRes(res, 400, String(err?.message ?? "Laya limit exceeded"), "invalid_request_error", "laya_limit");
    }
    void record(buildRecord({ endpoint: "system-one", status: 500, latencyMs: performance.now() - t0, questions, mock, errorCode: "server_error" }));
    return errRes(res, 500, String(err?.message ?? "Internal server error"), "server_error");
  }
}

async function handleChat(req, res) {
  const t0 = performance.now();
  const mock = isMock();
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    void record(buildRecord({ endpoint: "chat", status: e.status ?? 400, latencyMs: performance.now() - t0, questions: undefined, mock, errorCode: "bad_request" }));
    return errRes(res, e.status ?? 400, e.message ?? "Bad request");
  }
  body = body ?? {};
  const { state, questions } = resolveChatInput(body);
  if (isEmptyQuestions(questions)) {
    void record(buildRecord({ endpoint: "chat", status: 400, latencyMs: performance.now() - t0, questions, mock, errorCode: "laya_questions_missing" }));
    return errRes(
      res,
      400,
      "Laya is classifier-only. Retry with POST /v1/system-one and a { state, questions } body, or add \"laya\": { \"questions\": {...} } to this request.",
      "invalid_request_error",
      "laya_questions_missing"
    );
  }
  let result;
  try {
    await ensureLoaded();
    result = await systemOne(state, questions);
  } catch (err) {
    if (isLayaLimitError(err)) {
      void record(buildRecord({ endpoint: "chat", status: 400, latencyMs: performance.now() - t0, questions, mock, errorCode: "laya_limit" }));
      return errRes(res, 400, String(err?.message ?? "Laya limit exceeded"), "invalid_request_error", "laya_limit");
    }
    void record(buildRecord({ endpoint: "chat", status: 500, latencyMs: performance.now() - t0, questions, mock, errorCode: "server_error" }));
    return errRes(res, 500, String(err?.message ?? "Internal server error"), "server_error");
  }

  const answers = result?.answers;
  const usage = result?.usage ?? {};
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const content = JSON.stringify(answers);
  const id = "chatcmpl-" + randomBytes(8).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  if (body?.stream === true) {
    void record(buildRecord({ endpoint: "chat", status: 200, latencyMs: performance.now() - t0, usage, questions, mock }));
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const envelope = { id, object: "chat.completion.chunk", created, model: "laya" };
    res.write(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  void record(buildRecord({ endpoint: "chat", status: 200, latencyMs: performance.now() - t0, usage, questions, mock }));
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: "laya",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: inputTokens, completion_tokens: 0, total_tokens: inputTokens },
    laya: { answers, usage },
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      return await serveIndex(req, res);
    }
    if (method === "GET" && path === "/healthz") {
      return sendJson(res, 200, { ok: true, model: "laya", mock: isMock(), loaded: loadedFlag() });
    }
    if (method === "GET" && path === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: [{ id: "laya", object: "model", owned_by: "local", created: Math.floor(Date.now() / 1000) }],
      });
    }
    if (method === "GET" && path === "/api/stats") {
      return sendJson(res, 200, getSummary());
    }
    if (method === "GET" && path === "/api/series") {
      const range = url.searchParams.get("range") === "7d" ? "7d" : "24h";
      return sendJson(res, 200, getSeries(range));
    }
    if (method === "GET" && path === "/api/heatmap") {
      const days = Math.max(1, Math.min(60, parseInt(url.searchParams.get("days") ?? "14", 10) || 14));
      return sendJson(res, 200, getHeatmap(days));
    }
    if (method === "GET" && path === "/api/logs") {
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10) || 100;
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
      return sendJson(res, 200, getLogs(limit, offset));
    }
    if (method === "GET" && path === "/api/config") {
      const base = baseUrlFrom(req);
      return sendJson(res, 200, {
        baseUrl: `${base}/v1`,
        systemOneUrl: `${base}/v1/system-one`,
        chatUrl: `${base}/v1/chat/completions`,
        dashboardUrl: `${base}/`,
        model: "laya",
        apiKey: getApiKey() || "",
        mock: isMock(),
        note: "API key is cosmetic: the server accepts any Authorization Bearer header. Localhost-only, no passwords.",
      });
    }
    if (method === "POST" && (path === "/v1/system-one" || path === "/v1/laya/system_one")) {
      return await handleSystemOne(req, res);
    }
    if (method === "POST" && path === "/v1/chat/completions") {
      return await handleChat(req, res);
    }

    if (method === "GET" && path.startsWith("/vendor/")) {
      const name = path.slice("/vendor/".length);
      if (name.includes("/") || name.includes("\\")) {
        return errRes(res, 404, "Not found", "invalid_request_error");
      }
      return await serveVendor(name, res);
    }

    const knownPaths = new Set(["/", "/index.html", "/healthz", "/v1/models", "/v1/system-one", "/v1/laya/system_one", "/v1/chat/completions", "/api/stats", "/api/series", "/api/heatmap", "/api/logs", "/api/config"]);
    if (knownPaths.has(path)) {
      return errRes(res, 405, `Method ${method} not allowed for ${path}`);
    }
    return errRes(res, 404, `Not found: ${path}`, "invalid_request_error");
  } catch (err) {
    if (!res.headersSent) return errRes(res, 500, String(err?.message ?? "Internal server error"), "server_error");
    res.end();
  }
});

function shutdown(signal) {
  Promise.resolve()
    .then(() => closeModel())
    .catch(() => {})
    .finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(`LISTENING ${actual}`);
  const dashUrl = `http://${HOST}:${actual}/`;
  console.error(`agentify-laya listening on http://${HOST}:${actual}`);
  console.error(`dashboard: ${dashUrl}`);
  maybeOpenBrowser(dashUrl);
});

if (!SKIP_WARMUP) {
  ensureLoaded().catch((err) => {
    console.error(`model warmup failed: ${err?.message ?? err}`);
  });
}
