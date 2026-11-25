import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filesToCopy = [
  ["electron/agent/sdkBridge.mjs", "dist-electron/agent/sdkBridge.mjs"],
];

const dirsToCopy = [
  ["src/assets/sites", "dist-electron/assets/sites"],
];

for (const [srcRel, destRel] of filesToCopy) {
  const src = path.join(rootDir, srcRel);
  const dest = path.join(rootDir, destRel);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

for (const [srcRel, destRel] of dirsToCopy) {
  const srcDir = path.join(rootDir, srcRel);
  const destDir = path.join(rootDir, destRel);
  if (!fs.existsSync(srcDir)) continue;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    const srcFile = path.join(srcDir, entry);
    if (!fs.statSync(srcFile).isFile()) continue;
    fs.copyFileSync(srcFile, path.join(destDir, entry));
  }
}
