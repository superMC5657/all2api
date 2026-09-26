/**
 * 跨平台 sidecar 构建：在 Linux/macOS 输出 `bridges/qoder2api`，
 * 在 Windows 输出 `bridges/qoder2api.exe`。把平台条件收敛在一处，
 * 而不在 npm script 里硬编码 `.exe`。
 */
import { execFileSync } from "node:child_process";

// 平台后缀以 src/providers/qoder/constants.ts 为准（此处仅组装输出路径，不另定后缀规则）。
const out = `bridges/qoder2api${process.platform === "win32" ? ".exe" : ""}`;
execFileSync("go", ["build", "-o", `../../${out}`, "."], {
  cwd: new URL("../third_party/qoder2api", import.meta.url),
  stdio: "inherit",
});
console.log(`[build:sidecar] built ${out}`);
