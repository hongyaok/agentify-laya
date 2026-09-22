# agentify-laya — Build Plan (frozen contract v1)

## 1. Plain problem
Run Laya System-1 decision model locally and expose it behind a small
OpenAI-shaped HTTP server so existing tools (hermes, openclaw, claude code)
can call it for classification without pretending it can generate text.

Laya truth (from receptron/laya 0.1.2):
- `import { Laya } from "@receptron/laya"`
- `Laya.load({ modelDir?, repo="receptron/laya-onnx", subfolder?, revision="main", cacheDir?, token?, onProgress?, executionProviders=["cpu"], sessionOptions? })`
- `laya.systemOne(state: unknown, questions: Record<string,Question>) -> { model:"laya", answers, usage:{input_tokens, output_tokens:0} }`
- Question shapes:
  - choice: `{ type:"choice", instructions: string|object, criteria: Record<string,string|null> | string[] }`
  - score: `{ type:"score", instructions: string|object, criteria: string[] }`
  - noul: `{ type:"noul", instructions: string|object, criteria?: { true?:string, false?:string } }`
- Answer shapes:
  - choice: `{ type:"choice", choice, probabilities, confidence, rl_agent:{act_probability} }`
  - score: `{ type:"score", score, legend, probabilities, confidence, rl_agent }`
  - noul: `{ type:"noul", noul, rl_agent }`
- Limits: options must fit head_max_len 192 tokens, fewer than ~20 options per choice,
  state truncated to max_len 512. ~140ms warm per call. Bundle ~1.7GB fp32,
  cached under ~/.cache/receptron-laya (override LAYA_CACHE).
- `await laya.close()` releases session.

## 2. What must stay true
- Honest: Laya classifies, never generates. No fake streaming tokens.
- Clone + one command setup: `npm run setup`, then `npm start`.
- Zero extra runtime deps beyond @receptron/laya (use node:http).
- Works on Windows/macOS/Linux, Node >=20. LF line endings.
- Never commit weights, .env, or cache. Apache-2.0 weights notice kept.
- Mock mode for CI without 1.7GB download.

## 3. Frozen HTTP contract (v1)
Base: `http://127.0.0.1:3777`
- `GET /healthz` -> `{ ok:true, model:"laya", mock:bool, loaded:bool }`
- `GET /v1/models` -> `{ object:"list", data:[{ id:"laya", object:"model", owned_by:"local", created:<now> }] }`
- `POST /v1/system-one` (canonical) + alias `POST /v1/laya/system_one`
  req: `{ state: unknown, questions: Record<string,Question> }`
  res: full SystemOneResult `{ model:"laya", answers, usage }` + `laya_usage`
  errors: 400 on missing/empty questions, bad question shape, or Laya limit throw.
- `POST /v1/chat/completions` (compat shim):
  req accepts OpenAI shape `{ model?, messages:[{role,content}], stream?, laya?:{state,questions} }`
  state resolution order:
    1. `body.laya.state` if present
    2. last user message content parsed as JSON with `.state`
    3. concatenated user messages as `{ text: "..." }`
  questions resolution order:
    1. `body.laya.questions` if present
    2. last user message JSON `.questions`
    3. system message content parsed as JSON `.questions` or raw questions object
  if no questions after all fallbacks -> 400 `{ error:{ message:"Laya is classifier-only...", type:"invalid_request_error", code:"laya_questions_missing" } }`
  res non-stream: `{ id:"chatcmpl-...", object:"chat.completion", created, model:"laya", choices:[{ index:0, message:{ role:"assistant", content:"<JSON string of answers>" }, finish_reason:"stop" }], usage:{ prompt_tokens, completion_tokens:0, total_tokens }, laya:{ answers, usage } }`
  res stream=true: SSE `Content-Type: text/event-stream`, one `data: {json chunk with delta}` then `data: [DONE]`. Same payload, choices[0].delta.content = full JSON string.
- Auth: accept any `Authorization: Bearer xxx`, ignore. Document `OPENAI_API_KEY=anything`.
- Errors always JSON `{ error:{ message, type, code? } }`. Laya limit errors -> 400, otherwise 500.
- Concurrency: single shared Laya instance behind promise-chain mutex.

## 4. Env vars
- PORT=3777, HOST=127.0.0.1
- LAYA_CACHE (cache root), LAYA_MODEL_DIR (local bundle dir, skips download),
  LAYA_REVISION=main (pinned revision passed as revision), HF_TOKEN,
  MOCK_LAYA=1 (deterministic stub, no download), SKIP_WARMUP=1

## 5. Files (disjoint ownership)
- T1 `lib/laya-client.mjs`: exports `loadModel(opts?)`, `systemOne(state,questions)`, `getStatus()`, `closeModel()`. Real path uses @receptron/laya. Mock path returns deterministic answers (echo choice first option p=1.0, score 1.0, noul 0.0) with usage {input_tokens:1, output_tokens:0}. Serializes calls via mutex. Reads LAYA_* env.
- T2 `server.mjs`: node:http only, loads .env via process.loadEnvFile try/catch, lazy loadModel on first request + eager on boot (unless SKIP), routes above, SSE, JSON body limit 1MB, graceful close.
- T3 `scripts/warmup.mjs` (prefetch + one systemOne to warm, progress to stderr, respects LAYA_MODEL_DIR/MOCK) + `scripts/smoke.mjs` (spawns server with MOCK_LAYA=1 on ephemeral port, asserts /healthz, /v1/models, /v1/system-one, alias, /v1/chat/completions non-stream + stream, asserts shapes, kills server, exit non-zero on fail).
- T4 `skills/agentify-laya/SKILL.md` (Hermes SKILL.md frontmatter) + `README.md` + `examples/curl.sh` + `examples/node.mjs`. README must include: what Laya is/is-not, quickstart clone/setup/start, curl examples for all endpoints, hermes/openclaw/claude-code integration (OPENAI_BASE_URL=http://127.0.0.1:3777/v1, model laya, classifier-only note), env table, revision pinning, 2GB RAM note, Apache-2.0 weights notice, limits.
- Skill content: WHEN to call (routing/triage to fixed set, urgency score, binary gates, need calibrated prob, cheap pre-filter ~140ms local private) / WHEN NOT (generation, code, multi-hop reasoning, >20 options, long options >192 tokens, non-English unless multilingual). Include curl + node snippets using {"state","questions"} convention and choice/score/noul schemas.

## 6. Acceptance gate
- `MOCK_LAYA=1 npm run smoke` (which runs scripts/smoke.mjs) passes on Windows.
- No weights/.env committed. `git status` clean except intended files.
- Then initial commit + `git push -u origin main`.

## 7. Project root
C:/Users/hongy/Desktop/agentify-laya
Existing files (do not rewrite): package.json, .env.example, .gitattributes, .gitignore, LICENSE, NOTICE
Node 24, npm 11. No gh CLI. Push via credential-manager HTTPS (already works).
Local git user: hongyaok / hongyaok@gmail.com (keep local, do not touch global which is swapped).
