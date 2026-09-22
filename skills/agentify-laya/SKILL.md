---
name: agentify-laya
description: Use when routing or triaging input to a fixed label set, scoring urgency/priority, running binary gates, or needing calibrated classification probabilities from a cheap (~140ms) local private pre-filter. Classifier-only; never generates text.
version: 0.1.0
license: MIT
---

# agentify-laya

Laya is a **classifier-only System-1 model**. It picks / scores / gates — it never generates text.
This skill calls a local OpenAI-shaped server (default `http://127.0.0.1:3777`) that wraps Laya.

## WHEN to call

- Routing / triage to a **fixed set** of labels (e.g. `{"billing","tech","cancel"}`).
- Urgency / priority **score** (0–1 or 1–5 scale).
- Binary gates (e.g. `needs_human`, `is_spam`) via `noul`.
- You need a **calibrated probability** (`probabilities`, `confidence`, `rl_agent.act_probability`).
- You want a cheap (~140ms warm), **local, private pre-filter** before a big model.

## WHEN NOT to call

- Any text generation, summarization, code writing, or multi-hop reasoning.
- More than ~20 options in one `choice` question.
- Any option longer than ~192 tokens (`head_max_len`).
- State longer than ~512 tokens (truncated server-side).
- Non-English input, unless a multilingual Laya subfolder is confirmed.
- Do not expect token streaming: the chat shim returns the full answers JSON in one chunk.

## Laya truth

- Library: `@receptron/laya` (`Laya.load({ modelDir?, repo="receptron/laya-onnx", revision?, cacheDir?, ... })`, then `laya.systemOne(state, questions)`).
- Weights: ~1.7 GB fp32 from `receptron/laya-onnx`, cached under `~/.cache/receptron-laya` (override `LAYA_CACHE`). ~2 GB RAM. ~140 ms warm per call.
- Request convention is always `{ "state": ..., "questions": { ... } }`.

## Question schemas

```json
{
  "route":   { "type": "choice", "instructions": "Classify the ticket.", "criteria": { "billing": "payment/invoice issues", "tech": "bugs/errors", "cancel": "wants to cancel" } },
  "urgency": { "type": "score",  "instructions": "Rate urgency 0-1.", "criteria": ["low", "medium", "high"] },
  "gate":    { "type": "noul",   "instructions": "Needs a human?", "criteria": { "true": "needs human review", "false": "auto-handle is fine" } }
}
```

`criteria` for `choice` may also be a plain array: `"criteria": ["billing", "tech", "cancel"]`.
`criteria` for `noul` is optional.

## Answer schemas

```json
{
  "route":   { "type": "choice", "choice": "tech", "probabilities": { "tech": 0.91 }, "confidence": 0.91, "rl_agent": { "act_probability": 0.91 } },
  "urgency": { "type": "score",  "score": 0.8, "legend": {}, "probabilities": {}, "confidence": 0.8, "rl_agent": { "act_probability": 0.8 } },
  "gate":    { "type": "noul",   "noul": 0.2, "rl_agent": { "act_probability": 0.2 } }
}
```

`POST /v1/system-one` (alias `POST /v1/laya/system_one`) returns `{ "model": "laya", "answers": {...}, "usage": { "input_tokens": N, "output_tokens": 0 } }`.

## curl

```bash
BASE=http://127.0.0.1:3777
curl -s $BASE/healthz
curl -s -H 'Content-Type: application/json' -d '{
  "state": { "text": "My invoice is wrong and I want a refund" },
  "questions": {
    "route": { "type": "choice", "instructions": "Classify the ticket.", "criteria": ["billing", "tech", "cancel"] }
  }
}' $BASE/v1/system-one
```

Chat-completions shim (classifier-only: assistant `content` is a JSON string of answers, `completion_tokens` is 0):

```bash
curl -s -H 'Content-Type: application/json' -d '{
  "model": "laya",
  "messages": [{ "role": "user", "content": "My invoice is wrong" }],
  "laya": {
    "state": { "text": "My invoice is wrong" },
    "questions": { "route": { "type": "choice", "instructions": "Classify.", "criteria": ["billing", "tech"] } }
  }
}' $BASE/v1/chat/completions
```

## node

```js
const BASE = "http://127.0.0.1:3777";
const body = {
  state: { text: "My invoice is wrong and I want a refund" },
  questions: {
    route: { type: "choice", instructions: "Classify the ticket.", criteria: ["billing", "tech", "cancel"] },
    urgency: { type: "score", instructions: "Rate urgency 0-1.", criteria: ["low", "medium", "high"] },
  },
};
const res = await fetch(`${BASE}/v1/system-one`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const { answers, usage } = await res.json();
console.log(answers.route.choice, answers.route.probabilities, usage);
```

## Limits (hard fail as 400)

- `<20` options per `choice`; each option must fit `head_max_len` 192 tokens.
- State truncated to `max_len` 512 tokens. JSON body limit 1 MB.
- Missing/empty `questions` on the chat shim → `400 { "error": { "code": "laya_questions_missing", ... } }`.
- Any `Authorization: Bearer <token>` header is accepted and ignored (`OPENAI_API_KEY=anything`).
