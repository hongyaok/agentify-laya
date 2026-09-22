// scripts/check-dash.mjs — syntax-check the inline <script> in public/index.html.
// Extracts the script block, writes it to a temp .mjs, runs node --check on it.
import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) {
  console.error("FAIL: no inline <script> found in public/index.html");
  process.exit(1);
}
const tmp = path.join(os.tmpdir(), `dash-check-${Date.now()}.mjs`);
await writeFile(tmp, m[1], "utf8");
const r = spawnSync(process.execPath, ["--check", tmp], { stdio: "inherit" });
await unlink(tmp).catch(() => {});
if (r.status !== 0) {
  console.error("FAIL: dashboard inline script has syntax errors");
  process.exit(r.status ?? 1);
}
console.error("PASS: dashboard inline script syntax ok");
