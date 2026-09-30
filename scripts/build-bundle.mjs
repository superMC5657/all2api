/**
 * 打自包含 dist/：dist 即完整运行目录，拷走就能跑。
 * - dist/bundle.cjs：主包（esbuild 打平 hono 等依赖）
 * - dist/solver.cjs：验证码 solver（happy-dom 一起打平，undici 保持 external 按需加载）
 * - dist/zcode_system.json：system 块（bundle 内 bundleDir() 优先找它）
 * - dist/config.jsonc：可改的配置文件（已存在不覆盖；缺失则从仓库根拷，兜底 example）
 * - dist/bridges/qoder2api.exe：sidecar（必须外置物理文件，spawn 跑不了内存二进制）
 * 用法：pnpm build:bundle，然后 cd dist && node bundle.cjs
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

// 1. 主包
await build({
  entryPoints: [join(root, "src", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(dist, "bundle.cjs"),
  logLevel: "info",
});

// 2. solver 包（源为 CJS，目标机无需 node_modules）
await build({
  entryPoints: [join(root, "src", "providers", "zcode", "start-plan", "captcha-node", "solver.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(dist, "solver.cjs"),
  external: ["undici"],
  logLevel: "info",
});

// 3. system 块
const sysSrc = join(root, "src", "providers", "zcode", "start-plan", "zcode_system.json");
if (existsSync(sysSrc)) copyFileSync(sysSrc, join(dist, "zcode_system.json"));

// 4. 可改配置：已存在不覆盖（保留你在 dist 里改过的），缺失则从仓库根拷，兜底 example
const distCfg = join(dist, "config.jsonc");
if (!existsSync(distCfg)) {
  if (existsSync(join(root, "config.jsonc"))) copyFileSync(join(root, "config.jsonc"), distCfg);
  else if (existsSync(join(root, "config.example.jsonc"))) {
    copyFileSync(join(root, "config.example.jsonc"), distCfg);
    console.warn("[build:bundle] dist/config.jsonc 由 example 复制，记得改 apiKey/pat");
  }
}

// 5. sidecar：必须是 bundle 旁的物理文件（spawn 跑不了内存二进制）；只拷二进制，不拷凭据数据文件
mkdirSync(join(dist, "bridges"), { recursive: true });
const sidecar = join(root, "bridges", process.platform === "win32" ? "qoder2api.exe" : "qoder2api");
if (!existsSync(sidecar)) {
  console.log("[build:bundle] sidecar 缺失，自动现编（等同 pnpm build:sidecar）...");
  try {
    execFileSync(process.execPath, [join(root, "scripts", "build-sidecar.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    console.warn("[build:bundle] sidecar 现编失败（需 Go ≥1.22）——bundle 照出，装好 Go 后重跑本脚本");
  }
}
if (existsSync(sidecar)) copyFileSync(sidecar, join(dist, "bridges", basename(sidecar)));
else console.warn("[build:bundle] sidecar 仍缺失——装 Go 后跑 pnpm build:sidecar，再重跑本脚本");

console.log("[build:bundle] done -> dist/ 即完整运行目录（bundle.cjs + solver.cjs + zcode_system.json + config.jsonc + bridges/qoder2api.exe）");
