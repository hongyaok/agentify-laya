// scripts/smoke.mjs — mock-mode gate for agentify-laya.
// Spawns server.mjs with MOCK_LAYA=1 on an ephemeral port, asserts all routes.
// Always kills the child. Exit 1 on any failure. Windows-safe (process.execPath).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  process.stderr.write(`PASS: ${msg}\n`);
}

async function waitForListening(child, timeoutMs = 30000) {
  let buf = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for LISTENING line")), timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early code=${code} out=${buf}`)));
  });
}

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, MOCK_LAYA: "1", PORT: "0", SKIP_WARMUP: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let failed = false;
try {
  const port = await waitForListening(child);
  const base = `http://127.0.0.1:${port}`;
  assert(Number.isFinite(port) && port > 0, `server listening on port ${port}`);

  const get = async (p) => {
    const r = await fetch(`${base}${p}`);
    const j = await r.json();
    return { status: r.status, body: j };
  };
  const post = async (p, payload, opts = {}) => {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, text, json, headers: r.headers };
  };

  // 1. healthz
  {
    const { status, body } = await get("/healthz");
    assert(status === 200 && body.ok === true && body.model === "laya", "GET /healthz ok");
  }
  // 2. models
  {
    const { status, body } = await get("/v1/models");
    assert(status === 200 && body.object === "list" && body.data?.some((m) => m.id === "laya"), "GET /v1/models lists laya");
  }
  // 3. system-one canonical
  const q = {
    dept: { type: "choice", instructions: "route?", criteria: { billing: "pay", support: "help" } },
    urg: { type: "score", instructions: "urgent?", criteria: ["low", "high"] },
    risk: { type: "noul", instructions: "risk?" },
  };
  {
    const { status, json } = await post("/v1/system-one", { state: { text: "refund late" }, questions: q });
    assert(status === 200, "POST /v1/system-one 200");
    assert(json?.answers?.dept?.choice === "billing", "system-one choice picks first mock option");
    assert(typeof json?.answers?.urg?.score === "number", "system-one score is a number");
    assert(typeof json?.answers?.risk?.noul === "number", "system-one noul is a number");
  }
  // 4. alias
  {
    const { status } = await post("/v1/laya/system_one", { state: { text: "x" }, questions: q });
    assert(status === 200, "POST /v1/laya/system_one alias 200");
  }
  // 5. chat non-stream via embedded JSON
  {
    const { status, json } = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: JSON.stringify({ state: { text: "hi" }, questions: { r: { type: "noul", instructions: "risk?" } } }) }],
    });
    assert(status === 200, "POST /v1/chat/completions 200");
    const content = json?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    assert(typeof parsed?.r?.noul === "number", "chat content parses to answers JSON");
    assert(json?.usage?.completion_tokens === 0, "chat completion_tokens is 0");
  }
  // 6. chat missing questions -> 400
  {
    const { status, json } = await post("/v1/chat/completions", {
      messages: [{ role: "user", content: "just some plain text" }],
    });
    assert(status === 400 && json?.error?.code === "laya_questions_missing", "chat without questions 400 laya_questions_missing");
  }
  // 7. chat stream
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        laya: { state: { text: "hi" }, questions: { r: { type: "noul", instructions: "risk?" } } },
      }),
    });
    const text = await r.text();
    assert(r.status === 200 && text.includes("data:") && text.includes("data: [DONE]"), "chat stream SSE has data + DONE");
  }
  process.stderr.write("SMOKE OK\n");
} catch (err) {
  failed = true;
  process.stderr.write(`FAIL: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
}
if (failed) process.exit(1);
