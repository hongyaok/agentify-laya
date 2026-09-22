// lib/laya-client.mjs — lazy singleton wrapper around @receptron/laya.
// Mock path (MOCK_LAYA=1) returns deterministic, real-shaped answers.
// Real path dynamically imports @receptron/laya (never at top level).

const isMock = () => process.env.MOCK_LAYA === "1" || process.env.MOCK_LAYA === "true";

let instance = null; // loaded Laya instance (real path)
let loadPromise = null; // in-flight load (real path)
let modelDir = undefined; // resolved model dir (real path)

// Promise-chain mutex: serializes all systemOne calls.
let tail = Promise.resolve();
function withLock(fn) {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => {},
    () => {},
  );
  return run;
}

function mockSystemOne(state, questions) {
  void state;
  const answers = {};
  for (const [qid, q] of Object.entries(questions)) {
    if (q?.type === "choice") {
      const keys =
        Array.isArray(q.criteria) && q.criteria.length > 0
          ? q.criteria
          : q.criteria && typeof q.criteria === "object"
            ? Object.keys(q.criteria)
            : [];
      const first = keys[0];
      const probabilities = {};
      for (const k of keys) probabilities[k] = k === first ? 1.0 : 0.0;
      answers[qid] = {
        type: "choice",
        choice: first,
        probabilities,
        confidence: 1.0,
        rl_agent: { act_probability: 1.0 },
      };
    } else if (q?.type === "score") {
      const criteria = Array.isArray(q.criteria) ? q.criteria : [];
      const legend = {};
      criteria.forEach((c, i) => {
        legend[String(i)] = c;
      });
      const probabilities = {};
      criteria.forEach((_, i) => {
        probabilities[String(i)] = i === 1 ? 1.0 : 0.0;
      });
      answers[qid] = {
        type: "score",
        score: 1.0,
        legend,
        probabilities,
        confidence: 1.0,
        rl_agent: { act_probability: 1.0 },
      };
    } else if (q?.type === "noul") {
      answers[qid] = {
        type: "noul",
        noul: 0.0,
        rl_agent: { act_probability: 0 },
      };
    } else {
      throw new Error(
        `systemOne: question ${JSON.stringify(qid)} has unknown type ${JSON.stringify(q?.type)}`,
      );
    }
  }
  return {
    model: "laya",
    answers,
    usage: { input_tokens: 1, output_tokens: 0 },
  };
}

function validateQuestions(questions) {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw new Error("systemOne: questions must be a non-empty object map");
  }
  const keys = Object.keys(questions);
  if (keys.length === 0) {
    throw new Error("systemOne: at least one question is required");
  }
}

function realLoadOptions(overrides = {}) {
  const opts = { executionProviders: ["cpu"] };
  const cacheDir = process.env.LAYA_CACHE || overrides.cacheDir;
  const modelDirOpt = process.env.LAYA_MODEL_DIR || overrides.modelDir;
  const revision = process.env.LAYA_REVISION || overrides.revision || "main";
  const token = process.env.HF_TOKEN || overrides.token;
  if (cacheDir) opts.cacheDir = cacheDir;
  if (modelDirOpt) opts.modelDir = modelDirOpt;
  if (revision) opts.revision = revision;
  if (token) opts.token = token;
  if (overrides.repo) opts.repo = overrides.repo;
  if (overrides.subfolder) opts.subfolder = overrides.subfolder;
  opts.onProgress = ({ file, received, total }) => {
    const extra = total ? ` ${received}/${total}` : ` ${received}`;
    process.stderr.write(`[laya] ${file}${extra}\n`);
  };
  return opts;
}

async function doLoadReal(opts = {}) {
  const { Laya } = await import("@receptron/laya");
  const loadOpts = realLoadOptions(opts);
  const inst = await Laya.load(loadOpts);
  instance = inst;
  modelDir = inst?.modelDir;
  return inst;
}

export async function loadModel(opts = {}) {
  if (isMock()) return null;
  if (instance) return instance;
  if (loadPromise) return loadPromise;
  loadPromise = doLoadReal(opts).catch((err) => {
    loadPromise = null;
    throw err;
  });
  // Attach rejection guard against unhandled rejection on cached promise.
  loadPromise.catch(() => {});
  return loadPromise;
}

export async function systemOne(state, questions) {
  validateQuestions(questions);
  if (isMock()) {
    return withLock(() => mockSystemOne(state, questions));
  }
  // Load OUTSIDE the inference lock: loadModel has its own single-flight
  // promise and must never run nested inside withLock (cold-start deadlock).
  const inst = instance ?? (await loadModel());
  // Laya limit errors (<20 options, head/max len) propagate as-is.
  return withLock(() => inst.systemOne(state, questions));
}

export function getStatus() {
  const status = { loaded: isMock() ? true : instance !== null, mock: isMock() };
  if (!isMock() && modelDir !== undefined) status.modelDir = modelDir;
  return status;
}

export async function closeModel() {
  await withLock(async () => {
    if (isMock()) return;
    loadPromise = null;
    if (instance && typeof instance.close === "function") {
      await instance.close();
    }
    instance = null;
    modelDir = undefined;
  });
}
