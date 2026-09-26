import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { readQoderIdeIdentityFor } from "./credentials.js";
import { placeholderFor, REGION_ENV, type QoderRegion } from "./constants.js";

/**
 * 管理 Qoder-2API-Go sidecar 二进制：准备其 data.json（PAT + API key），
 * 拉起子进程，等待 /health 就绪，并对外暴露用于转发的 base URL。
 *
 * 该 sidecar 实现了 Qoder 网关协议（RSA+AES 会话加密、MD5 签名），
 * 并提供 OpenAI 兼容 HTTP 接口——用 TS 重写实现风险太大，
 * 因此 all2api 将其作为本地子进程驱动。
 */
export interface BridgeHandle {
  baseUrl: string;
  apiKey: string;
  hasPat: boolean;
  stop(): void;
}

interface BridgeDataFile {
  host: string;
  port: number;
  pat?: string;
  password?: string;
  api_keys?: Array<{ id: string; key: string; note?: string; created_at?: number }>;
  securityOauthToken?: string;
  refreshToken?: string;
  uid?: string;
  nickname?: string;
  expireTime?: number;
  [key: string]: unknown;
}

/** 占位符 == region id（见 placeholderFor）；此处仅作说明保留。 */

/**
 * sidecar 二进制是构建产物而非源码：绝不能提交入库。首次启动时（全新克隆），
 * 它由 third_party/qoder2api 中 vendored 的补丁源码编译而来——详见 third_party/qoder2api.VENDOR.md。
 * cn 与 intl 桥接共用同一个二进制，因此并发启动时共用一次构建。
 */
const sidecarBuilds = new Map<string, Promise<string>>();

async function ensureSidecarBinary(binary: string): Promise<string> {
  if (existsSync(binary)) return binary;
  let pending = sidecarBuilds.get(binary);
  if (!pending) {
    pending = buildSidecar(binary).finally(() => sidecarBuilds.delete(binary));
    sidecarBuilds.set(binary, pending);
  }
  return pending;
}

async function buildSidecar(binary: string): Promise<string> {
  // 默认布局：<root>/bridges/qoder2api[.exe] → <root>/third_party/qoder2api
  const sourceDir = resolve(dirname(binary), "..", "third_party", "qoder2api");
  if (!existsSync(sourceDir)) {
    throw new Error(
      `qoder bridge binary ${binary} not found and vendored sidecar source missing at ${sourceDir} — see third_party/qoder2api.VENDOR.md`,
    );
  }
  console.log(`[qoder-bridge] sidecar binary not found — building from ${sourceDir} ...`);
  mkdirSync(dirname(binary), { recursive: true });
  await new Promise<void>((done, fail) => {
    const go = spawn("go", ["build", "-o", binary, "."], { cwd: sourceDir, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    go.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    go.once("error", (err) =>
      fail(new Error(`go toolchain unavailable (${err.message}) — install Go ≥1.22, or build manually: pnpm build:sidecar`)),
    );
    go.once("exit", (code) =>
      code === 0 ? done() : fail(new Error(`go build failed (exit ${code}):\n${stderr.slice(-2000)}`)),
    );
  });
  if (!existsSync(binary)) throw new Error("go build reported success but the binary is still missing");
  console.log(`[qoder-bridge] sidecar built: ${binary}`);
  return binary;
}

export async function startBridge(opts: {
  binaryPath: string;
  dataPath: string;
  pat?: string;
  port: number;
  apiKey?: string;
  /** "intl" 表示将 sidecar 指向国际版（qoder.com）部署。 */
  region?: QoderRegion;
  timeoutMs?: number;
}): Promise<BridgeHandle> {
  const binary = resolve(opts.binaryPath);
  await ensureSidecarBinary(binary);

  const apiKey = opts.apiKey || `sk-bridge-${crypto.randomUUID().replaceAll("-", "")}`;
  const dataPath = resolve(opts.dataPath);

  // 合并到已有的 data.json，使管理后台的修改与统计在重启后保留。
  let data: Partial<BridgeDataFile> = {};
  if (existsSync(dataPath)) {
    try {
      data = JSON.parse(readFileSync(dataPath, "utf8")) as Partial<BridgeDataFile>;
    } catch {
      data = {};
    }
  }
  data.host = "127.0.0.1";
  data.port = opts.port;
  const pat = opts.pat?.trim() ?? "";
  const region: QoderRegion = opts.region ?? "cn";
  if (pat) {
    data.pat = pat;
    // 真实 PAT 优先于此前无 PAT 运行残留在 data.json 中的 IDE 身份
    //（Go 侧只要存在身份就会跳过 PAT 交换）。占位符不是真实 PAT——
    // 它仅用于通过 Go 非空门槛校验，实际鉴权仍由 IDE 身份完成。
    const isPlaceholder = pat === placeholderFor(region);
    if (!isPlaceholder) {
      delete data.securityOauthToken;
      delete data.refreshToken;
      delete data.uid;
      delete data.nickname;
      delete data.expireTime;
    }
  } else {
    // 无 PAT——改为复用桌面版 IDE 自身的登录身份（cn 与 intl 皆如此）。
    // 先清除过期身份字段，以免失效登录遮挡后续在 sidecar 管理后台添加的 PAT。
    delete data.securityOauthToken;
    delete data.refreshToken;
    delete data.uid;
    delete data.nickname;
    delete data.expireTime;
    const ide = readQoderIdeIdentityFor(region);
    if (ide) {
      data.securityOauthToken = ide.token;
      data.refreshToken = ide.refreshToken;
      data.uid = ide.uid;
      data.nickname = ide.nickname;
      data.expireTime = ide.expireTime;
      // PAT 为空时 Go 不会建桥：占位符仅用于通过该非空门槛——
      // 会话仍完全基于上述 IDE 身份启动，不会执行任何 PAT 交换。真实 PAT
      //（config 或管理后台）总会替换此标记。cn 与 intl 皆如此
      //（占位符 == region id，见 placeholderFor）。
      data.pat = placeholderFor(region);
      console.log(`[qoder-bridge] using ${region} IDE identity of ${ide.nickname} (expires ${ide.expireTime ? new Date(ide.expireTime).toISOString() : "unknown"}) — 已复用本机 Qoder IDE 登录（config 里 ${region} pat 为空即走此 IDE 身份，有真实 PAT 则 PAT 优先）`);
    } else {
      // IDE 登录失效时清除我们自己的占位符——过期标记绝不能冒充 PAT。
      // 真实 PAT（如来自 sidecar 管理后台）保持不动以便生效。
      if (data.pat === placeholderFor(region)) delete data.pat;
      const NO_IDE_WARN: Record<QoderRegion, string> = {
        intl:
          "[qoder-bridge] no PAT and no logged-in intl Qoder IDE found — set providers.qoderIntl.pat to the \"intl\" placeholder or a real PAT（中文：intl 未填 PAT 且没读到本机 IDE 登录，请在 config.json 的 providers.qoderIntl.pat 填 \"intl\" 占位或真实 PAT，也可先登录海外版 Qoder IDE 后重启）",
        cn: "[qoder-bridge] no PAT and no logged-in Qoder CN IDE found — fill providers.qoder.pat with a pt-… PAT, or log in the Qoder CN desktop app and restart（中文：国内版既无 PAT 也没读到本机 Qoder CN 登录，请在 config.json 的 providers.qoder.pat 填写 pt-…，或登录国内版 Qoder 桌面端后重启）",
      };
      console.warn(NO_IDE_WARN[region]);
    }
  }
  if (!data.password) data.password = crypto.randomUUID();
  const keys = Array.isArray(data.api_keys) ? data.api_keys.filter((k) => k.key !== apiKey) : [];
  keys.push({ id: "all2api", key: apiKey, note: "managed by all2api", created_at: Math.floor(Date.now() / 1000) });
  const merged: BridgeDataFile = {
    host: "127.0.0.1",
    port: opts.port,
    ...data,
    api_keys: keys,
  };
  writeFileSync(dataPath, JSON.stringify(merged, null, 2) + "\n");

  const child: ChildProcess = spawn(binary, [], {
    cwd: resolve(dataPath, ".."),
    env: {
      ...process.env,
      QODER_HOST: "127.0.0.1",
      QODER_PORT: String(opts.port),
      QODER_DATA_PATH: dataPath,
      ...REGION_ENV[region],
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[qoder-bridge] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[qoder-bridge] ${chunk}`));
  child.once("exit", (code) => console.warn(`[qoder-bridge] exited with code ${code}`));

  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let health: { status?: string; has_pat?: boolean } = {};
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        health = (await res.json()) as { status?: string; has_pat?: boolean };
        if (health.status === "ok") break;
      }
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const hasPat = health.has_pat === true || !!data.securityOauthToken;
  if (health.status !== "ok") {
    child.kill();
    throw new Error("qoder bridge did not become healthy in time — check [qoder-bridge] log lines above");
  }
  if (!hasPat) {
    const NO_PAT_WARN: Record<QoderRegion, string> = {
      intl: "[qoder-bridge] no PAT configured — set providers.qoderIntl.pat to the \"intl\" placeholder or a real PAT in config.json（中文：intl 缺 PAT（空 = 起不来），请在 config.json 的 providers.qoderIntl.pat 填 \"intl\" 占位或真实 PAT）",
      cn: `[qoder-bridge] no PAT configured and no Qoder CN desktop login found — set providers.qoder.pat in config.json (or via the bridge admin panel), or log in the Qoder CN desktop app, then restart all2api（中文：国内版缺 PAT 且无本机 IDE 登录（PAT 与 IDE 登录二选一），请在 config.json 的 providers.qoder.pat 填写，或打开 http://127.0.0.1:${opts.port}/admin 管理后台填写后重启，或登录国内版 Qoder 桌面端后重启）`,
    };
    console.warn(NO_PAT_WARN[region]);
  }

  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once("exit", stop);
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });

  return { baseUrl, apiKey, hasPat, stop };
}
