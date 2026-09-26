/**
 * Cross-platform sidecar build: outputs `bridges/qoder2api` on Linux/macOS
 * and `bridges/qoder2api.exe` on Windows. Keeps the platform conditional in
 * one place instead of hardcoding `.exe` in the npm script.
 */
import { execFileSync } from "node:child_process";

// 平台后缀以 src/providers/qoder/constants.ts 为准（此处仅组装输出路径，不另定后缀规则）。
const out = `bridges/qoder2api${process.platform === "win32" ? ".exe" : ""}`;
execFileSync("go", ["build", "-o", `../../${out}`, "."], {
  cwd: new URL("../third_party/qoder2api", import.meta.url),
  stdio: "inherit",
});
console.log(`[build:sidecar] built ${out}`);
