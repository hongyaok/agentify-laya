// scripts/warmup.mjs — prefetch the ~1.7GB bundle and warm one inference.
// Works under MOCK_LAYA=1 with no download (mock path).
try {
  process.loadEnvFile();
} catch {}

const { loadModel, systemOne, closeModel } = await import("../lib/laya-client.mjs");

try {
  await loadModel();
  const result = await systemOne(
    { text: "warmup" },
    { ok: { type: "noul", instructions: "Is this a warmup check?" } }
  );
  process.stderr.write(`[warmup] ok noul=${result.answers.ok.noul}\n`);
  await closeModel();
} catch (err) {
  process.stderr.write(`[warmup] FAIL: ${err?.message ?? err}\n`);
  process.exit(1);
}
