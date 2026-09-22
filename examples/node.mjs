// agentify-laya node example. Run with: BASE=http://127.0.0.1:3777 node examples/node.mjs
// Zero deps, Node >= 20 (global fetch). Works against MOCK_LAYA=1.
const BASE = process.env.BASE ?? "http://127.0.0.1:3777";

const body = {
  state: { text: "My invoice is wrong and I want a refund" },
  questions: {
    route: { type: "choice", instructions: "Classify the ticket.", criteria: ["billing", "tech", "cancel"] },
    urgency: { type: "score", instructions: "Rate urgency 0-1.", criteria: ["low", "medium", "high"] },
  },
};

const sysRes = await fetch(`${BASE}/v1/system-one`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
if (!sysRes.ok) throw new Error(`system-one failed: ${sysRes.status} ${await sysRes.text()}`);
const { answers, usage } = await sysRes.json();
console.log("route:", answers.route.choice, answers.route.probabilities);
console.log("urgency:", answers.urgency.score ?? answers.urgency);
console.log("usage:", usage);

const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer anything" },
  body: JSON.stringify({
    model: "laya",
    messages: [{ role: "user", content: "My invoice is wrong" }],
    laya: {
      state: { text: "My invoice is wrong" },
      questions: { route: { type: "choice", instructions: "Classify.", criteria: ["billing", "tech"] } },
    },
  }),
});
if (!chatRes.ok) throw new Error(`chat failed: ${chatRes.status} ${await chatRes.text()}`);
const chat = await chatRes.json();
console.log("chat content:", chat.choices[0].message.content);
console.log("chat usage:", chat.usage);
