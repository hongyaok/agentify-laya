# agentify-laya

Run the **Laya System-1 decision model** locally behind a small OpenAI-shaped HTTP server, so existing tools (hermes, openclaw, claude-code) can call it for classification.

## What Laya is / is-not

**Laya is:** a classifier-only System-1 model. Given a `state` and a set of `questions`, it returns calibrated `choice` / `score` / `noul` answers with probabilities — fast (~140 ms warm), local, and private. Ideal as a cheap pre-filter: routing, triage, urgency scoring, binary gates.

**Laya is not:** a generator. It never writes text, code, or summaries, never does multi-hop reasoning, and never streams real tokens. `POST /v1/chat/completions` is a **compat shim**: the assistant `content` is a JSON string of the classification answers, `completion_tokens` is always `0`, and `stream:true` sends the full JSON in one SSE chunk followed by `data: [DONE]`.

## Quickstart

```bash
git clone https://github.com/hongyaok/agentify-laya.git
cd agentify-laya
npm run setup   # npm install + prefetch ~1.7 GB weights + warmup
npm start       # serve on http://127.0.0.1:3777
```

CI / docs without the download:

```bash
MOCK_LAYA=1 npm run smoke
```

`MOCK_LAYA=1` runs a deterministic stub (choice → first option at p=1.0, score → 1.0, noul → 0.0). No weights downloaded.

## Dashboard

`npm start` serves a React usage dashboard at `http://127.0.0.1:3777/` and auto-opens your browser. Disable with `NO_BROWSER=1` (or `CI=true`). No build step: React 18 UMD is copied into gitignored `public/vendor/` by `npm run setup` (or `node scripts/setup-vendor.mjs`). Usage counts/timings live in gitignored `data/`; request bodies are never stored.

## Endpoints

Base: `http://127.0.0.1:3777`

### GET /healthz

```bash
curl -s http://127.0.0.1:3777/healthz
# {"ok":true,"model":"laya","mock":false,"loaded":true}
```

### GET /v1/models

```bash
curl -s http://127.0.0.1:3777/v1/models
# {"object":"list","data":[{"id":"laya","object":"model","owned_by":"local","created":...}]}
```

### POST /v1/system-one (canonical)

Alias: `POST /v1/laya/system_one` (same handler).

```bash
curl -s -H 'Content-Type: application/json' -d '{
  "state": { "text": "My invoice is wrong and I want a refund" },
  "questions": {
    "route":   { "type": "choice", "instructions": "Classify the ticket.", "criteria": ["billing", "tech", "cancel"] },
    "urgency": { "type": "score",  "instructions": "Rate urgency 0-1.", "criteria": ["low", "medium", "high"] },
    "gate":    { "type": "noul",   "instructions": "Needs a human?", "criteria": { "true": "needs human review", "false": "auto-handle is fine" } }
  }
}' http://127.0.0.1:3777/v1/system-one
```

Response: `{ "model": "laya", "answers": { ... }, "usage": { "input_tokens": N, "output_tokens": 0 }, "laya_usage": { ... } }`.

Choice criteria may be an object mapping label → description (`{"billing": "payment issues", ...}`) or a plain array. `noul` criteria is optional.

### POST /v1/chat/completions (compat shim, non-stream)

`state` resolution: `body.laya.state` → last user message parsed as JSON `.state` → concatenated user messages as `{ "text": "..." }`.
`questions` resolution: `body.laya.questions` → last user message JSON `.questions` → system message JSON `.questions` (or raw questions object).
Missing questions → `400 { "error": { "message": "Laya is classifier-only...", "type": "invalid_request_error", "code": "laya_questions_missing" } }`.

```bash
curl -s -H 'Content-Type: application/json' -d '{
  "model": "laya",
  "messages": [{ "role": "user", "content": "My invoice is wrong" }],
  "laya": {
    "state": { "text": "My invoice is wrong" },
    "questions": {
      "route": { "type": "choice", "instructions": "Classify.", "criteria": ["billing", "tech"] }
    }
  }
}' http://127.0.0.1:3777/v1/chat/completions
```

Response: OpenAI shape with `choices[0].message.content` = JSON string of `answers`, `usage.completion_tokens = 0`, plus a `laya: { answers, usage }` sidecar. `temperature` / `max_tokens` are accepted and ignored. Any `Authorization: Bearer <token>` header is accepted and ignored.

### POST /v1/chat/completions (stream)

Same request with `"stream": true`. SSE response (`Content-Type: text/event-stream`): one `data: {...}` chunk whose `choices[0].delta.content` is the full answers JSON, then `data: [DONE]`.

```bash
curl -sN -H 'Content-Type: application/json' -H 'Accept: text/event-stream' -d '{
  "model": "laya",
  "stream": true,
  "messages": [{ "role": "user", "content": "My invoice is wrong" }],
  "laya": {
    "state": { "text": "My invoice is wrong" },
    "questions": {
      "route": { "type": "choice", "instructions": "Classify.", "criteria": ["billing", "tech"] }
    }
  }
}' http://127.0.0.1:3777/v1/chat/completions
```

Errors are always JSON: `{ "error": { "message": ..., "type": ..., "code": ... } }`. Laya limit violations → 400, otherwise 500.

## Integration (hermes / openclaw / claude-code)

Point any OpenAI-compatible client at the shim. It is classifier-only: expect a JSON string of answers, not prose.

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3777/v1
export OPENAI_API_KEY=anything   # accepted and ignored
```

- `model`: `laya`
- `temperature`, `max_tokens`: accepted, ignored.
- You MUST supply `questions` (via `laya.questions`, or embedded JSON in the user/system message) — otherwise `400 laya_questions_missing`.
- Parse `choices[0].message.content` as JSON to get `answers`.

```js
// node (global fetch, Node >= 20)
const res = await fetch("http://127.0.0.1:3777/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer anything" },
  body: JSON.stringify({
    model: "laya",
    messages: [{ role: "user", content: "My invoice is wrong" }],
    laya: {
      state: { text: "My invoice is wrong" },
      questions: { route: { type: "choice", instructions: "Classify.", criteria: ["billing", "tech"] } },
    },
  }),
});
const out = await res.json();
const answers = JSON.parse(out.choices[0].message.content);
console.log(answers.route.choice, answers.route.probabilities);
```

Note for claude-code: it natively targets Anthropic (`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`), not `OPENAI_BASE_URL`. Use the variables above only with an OpenAI-compatible client or an OpenAI→Anthropic shim; otherwise call `/v1/system-one` directly.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3777` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `LAYA_CACHE` | `~/.cache/receptron-laya` | Cache root for the ~1.7 GB ONNX bundle |
| `LAYA_MODEL_DIR` | _(unset)_ | Local bundle dir (must hold `laya.onnx`, `laya.onnx.data`, `laya_config.json`, `tokenizer/`); skips download |
| `LAYA_REVISION` | `main` | Pinned Hugging Face revision passed as `revision` |
| `HF_TOKEN` | _(unset)_ | Token for gated/private HF repos |
| `MOCK_LAYA` | _(unset)_ | `1` → deterministic stub, no download (CI/smoke) |
| `SKIP_WARMUP` | _(unset)_ | `1` → skip eager model load on boot (lazy-load on first request) |
| `DATA_DIR` | `data` | Directory for usage store (`events.jsonl` + `api-key.txt`); gitignored |
| `LAYA_API_KEY` | _(generated)_ | Override for the cosmetic API key shown in the dashboard |
| `NO_BROWSER` | _(unset)_ | `1` stops `npm start` auto-opening the dashboard browser |

See `.env.example` for a copy-paste template (loaded via `process.loadEnvFile`, never committed — `.env` is gitignored).

### Revision pinning

Set `LAYA_REVISION` to a commit SHA (or tag) for reproducible weights, e.g. `LAYA_REVISION=<sha> npm start`. The value is passed through as the HF `revision`. Default `main` tracks upstream.

## Resources

- Weights: ~1.7 GB fp32, downloaded on first run from `receptron/laya-onnx`, cached under `~/.cache/receptron-laya` (override with `LAYA_CACHE`, or skip the download with `LAYA_MODEL_DIR`). Allow ~2 GB RAM. Warm call ≈ 140 ms.
- Model weights are published by Convai Innovations under **Apache-2.0** and are **not shipped** in this repo. Code here is MIT (see `LICENSE`); see `NOTICE` for upstream links.

## Limits

- `<20` options per `choice` question; each option must fit `head_max_len` 192 tokens (else 400).
- State truncated to `max_len` 512 tokens.
- JSON body limit 1 MB; missing/empty `questions` → 400.
- Classifier-only: no generation, no real token streaming (`completion_tokens: 0`).
- English input expected unless a multilingual Laya subfolder is confirmed.
- Single shared Laya instance behind a promise-chain mutex; concurrent requests serialize.

## License

MIT — see `LICENSE`. Model weights: Apache-2.0, Convai Innovations, downloaded at setup (see `NOTICE`).
