// scripts/setup-vendor.mjs — copy React UMD builds into public/vendor/.
// Keeps public/vendor/ gitignored: fresh clones regenerate via `npm run setup`.
import { mkdir, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pairs = [
  ["node_modules/react/umd/react.production.min.js", "public/vendor/react.min.js"],
  ["node_modules/react-dom/umd/react-dom.production.min.js", "public/vendor/react-dom.min.js"],
];

await mkdir(path.join(ROOT, "public", "vendor"), { recursive: true });
for (const [src, dest] of pairs) {
  const from = path.join(ROOT, src);
  const to = path.join(ROOT, dest);
  try {
    await stat(from);
  } catch {
    console.error(`FAIL: missing ${src}. Run npm install first.`);
    process.exit(1);
  }
  await copyFile(from, to);
  console.error(`vendor: ${src} -> ${dest}`);
}
console.error("vendor ok");
