#!/usr/bin/env bash
# agentify-laya curl examples. Run with: BASE=http://127.0.0.1:3777 bash examples/curl.sh
# (Git Bash / WSL on Windows; plain cmd.exe won't parse the single-quoted JSON.)
set -e
BASE="${BASE:-http://127.0.0.1:3777}"

echo "== GET /healthz =="
curl -s "$BASE/healthz"; echo

echo "== GET /v1/models =="
curl -s "$BASE/v1/models"; echo

echo "== POST /v1/system-one =="
curl -s -H 'Content-Type: application/json' -d '{
  "state": { "text": "My invoice is wrong and I want a refund" },
  "questions": {
    "route": { "type": "choice", "instructions": "Classify the ticket.", "criteria": ["billing", "tech", "cancel"] },
    "urgency": { "type": "score", "instructions": "Rate urgency 0-1.", "criteria": ["low", "medium", "high"] }
  }
}' "$BASE/v1/system-one"; echo

echo "== POST /v1/laya/system_one (alias) =="
curl -s -H 'Content-Type: application/json' -d '{
  "state": { "text": "My invoice is wrong and I want a refund" },
  "questions": {
    "route": { "type": "choice", "instructions": "Classify the ticket.", "criteria": ["billing", "tech", "cancel"] }
  }
}' "$BASE/v1/laya/system_one"; echo

echo "== POST /v1/chat/completions (non-stream) =="
curl -s -H 'Content-Type: application/json' -d '{
  "model": "laya",
  "messages": [{ "role": "user", "content": "My invoice is wrong" }],
  "laya": {
    "state": { "text": "My invoice is wrong" },
    "questions": {
      "route": { "type": "choice", "instructions": "Classify.", "criteria": ["billing", "tech"] }
    }
  }
}' "$BASE/v1/chat/completions"; echo

echo "== POST /v1/chat/completions (stream) =="
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
}' "$BASE/v1/chat/completions"; echo
