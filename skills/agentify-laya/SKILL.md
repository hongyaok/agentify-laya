---
name: agentify-laya
description: Use when routing, triage, scoring, or gating.
version: 0.4.0
license: MIT
author: hongyaok
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [classification, triage, decision-model]
---

# agentify-laya

> RULE: Laya is your classifier subagent for decisions; invoke it over HTTP with curl/fetch via the `terminal` tool, not via `delegate_task` spawn, not as your main model. PREFER `POST /v1/system-one`
> with an explicit `{ state, questions }` body. Plain chat calls
> without `questions` always fail with `400 laya_questions_missing` - by design.

Laya is a **classifier-only System-1 service**. You consult it like a specialist for a probability: when you face a small-set choice, score, or gate, you fold its calibrated answer into your own reasoning. It never generates
text. Server default: `http://127.0.0.1:3777`. Start it with `npm start`.

## WHEN to consult

- Routing / triage to a **fixed set** of labels (`billing`, `tech`, `cancel`).
- Urgency / priority **score** on an ordered scale.
- Binary gates (`needs_human`, `is_spam`) via `noul`.
- You need a **calibrated probability** (`probabilities`, `confidence`).
- You want a cheap (~140ms warm), **local, private gut-check** before committing.

## WHEN NOT to consult

- Any text generation, summarization, code writing, or multi-hop reasoning.
- More than ~20 options in one `choice` question.
- Any option longer than ~192 tokens. State longer than ~512 tokens.
- Non-English input, unless a multilingual Laya subfolder is confirmed.
- Do not expect streaming: the chat shim returns answers JSON in one chunk.

## Consult-then-decide protocol

1. Spot the small-set decision in your task (route label, urgency, gate).
2. Call `POST /v1/system-one` with the content as `state` and one typed
   question per decision (batch them — one call = one forward pass).
3. Read `answers.<qid>.choice/score/noul` plus `probabilities`/`confidence`.
4. Weigh it: high confidence → adopt as evidence and cite the probability;
   flat distribution (top choice < ~0.5) → trust your own reasoning or
   escalate. Laya informs the decision, it does not make it.

## Preferred call: POST /v1/system-one

```bash
curl -s http://127.0.0.1:3777/v1/system-one \
  -H 'Content-Type: application/json' -d '{
    "state": { "text": "My invoice is wrong and I want a refund" },
    "questions": {
      "route": { "type": "choice", "instructions": "Classify the ticket.",
        "criteria": { "billing": "payment/invoice issues", "tech": "bugs/errors", "cancel": "wants to cancel" } },
      "urgency": { "type": "score", "instructions": "Rate urgency.",
        "criteria": ["low", "medium", "high"] },
      "gate": { "type": "noul", "instructions": "Needs a human?" }
    }
  }'
```

PowerShell (Windows quoting):

```powershell
$body = @{ state = @{ text = "My invoice is wrong" }
  questions = @{ route = @{ type = "choice"; instructions = "Classify."
    criteria = @("billing","tech","cancel") } } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "http://127.0.0.1:3777/v1/system-one" `
  -Method Post -ContentType "application/json" -Body $body
```

Node (global fetch):

```js
const res = await fetch("http://127.0.0.1:3777/v1/system-one", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ state: { text: "My invoice is wrong" },
    questions: { route: { type: "choice", instructions: "Classify.",
      criteria: ["billing","tech"] } } }),
});
const { answers } = await res.json();
// answers.route.choice, answers.route.probabilities, answers.route.confidence
```

`criteria` for `choice`: object map label→description, or plain array.
`criteria` for `score`: ordered array, index 0 = lowest.
`criteria` for `noul`: optional `{ "true": "...", "false": "..." }`.

## Reading answers and acting

- `choice`: `{ choice, probabilities, confidence, rl_agent: { act_probability } }`.
  Act when `confidence` is high and top `probabilities` mass is concentrated.
- `score`: expected level `score` + `legend` + per-level `probabilities`.
- `noul`: calibrated P(true) in `noul`. Treat >0.7 as true-leaning,
  <0.3 as false-leaning, else uncertain.
- Worked example: ticket says "third time writing, will dispute".
  Consult → `route.choice=billing (0.94)`, `urgency.score=2.4/3`,
  `gate.noul=0.82`. Decision note: "Laya: billing 0.94, high urgency,
  P(needs-human)=0.82 → route to billing queue with priority."
- Response also carries `usage: { input_tokens, output_tokens: 0 }`
  and alias `laya_usage`. Output tokens are always 0 (classifier-only).

## Fallback: /v1/chat/completions (OpenAI-shaped shim)

Use ONLY inside OpenAI-compatible tooling you cannot change. You MUST
include `laya.questions`, or it 400s. `content` comes back as a JSON
string of answers, `completion_tokens` is always 0.

```bash
curl -s http://127.0.0.1:3777/v1/chat/completions \
  -H 'Content-Type: application/json' -d '{
    "model": "laya",
    "messages": [{ "role": "user", "content": "My invoice is wrong" }],
    "laya": {
      "state": { "text": "My invoice is wrong" },
      "questions": { "route": { "type": "choice",
        "instructions": "Classify.", "criteria": ["billing","tech"] } }
    }
  }'
```

The shim also accepts `questions` as JSON inside the last user message
or a system message, but explicit `laya.questions` is the reliable path.
`questions`-in-message only works when the ENTIRE message content is the raw JSON object — no prose before/after, no code fences — otherwise the parse is skipped and you get the same 400. Explicit `laya.questions` avoids the trap.
Ordinary chat traffic with no `questions` anywhere → `400`.

## Error playbook

- `400 { code: laya_questions_missing }` → you sent `messages` with no
  `questions`. Resend via `/v1/system-one` with `{ state, questions }`,
  or add `laya.questions` to the chat body.
- `400 Missing or empty questions` (system-one) → same fix.
- `400 { code: laya_limit }` → shrink: <20 options, each option ≤192
  tokens, state ≤512 tokens.
- Connection refused → server is down. Run `npm start`, check `/healthz`.

## Install (required — otherwise Hermes never sees this)

Copy this folder into the active agent skills dir, e.g.
`$HERMES_HOME/skills/agentify-laya/SKILL.md`, then start a new session
(skills load at session start). Keep your chat model pointed at a real
chat model — Laya cannot answer turns with prose.
