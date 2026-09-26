import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { readQoderIdeIdentityFor } from "./credentials.js";
import { placeholderFor, REGION_ENV, type QoderRegion } from "./constants.js";

/**
 * Manages the Qoder-2API-Go sidecar binary: prepares its data.json (PAT + API key),
 * spawns it, waits for /health, and exposes a base URL for proxying.
 *
 * The sidecar implements Qoder's gateway protocol (RSA+AES session crypto, MD5
 * signatures) and speaks OpenAI-compatible HTTP — reimplementing that in TS is
 * not worth the risk, so all2api drives it as a local subprocess instead.
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

/** Placeholder == region id (see placeholderFor); kept here as doc only. */

/**
 * The sidecar binary is a build artifact, not source: it must never be
 * committed. On first start (fresh clone) it is compiled from the vendored
 * patched source in third_party/qoder2api — see that dir's VENDOR.md.
 * cn + intl bridges share one binary, so concurrent starts share one build.
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
  // default layout: <root>/bridges/qoder2api[.exe] → <root>/third_party/qoder2api
  const sourceDir = resolve(dirname(binary), "..", "third_party", "qoder2api");
  if (!existsSync(sourceDir)) {
    throw new Error(
      `qoder bridge binary ${binary} not found and vendored sidecar source missing at ${sourceDir} — see third_party/qoder2api/VENDOR.md`,
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
  /** "intl" runs the sidecar against the international (qoder.com) deployment. */
  region?: QoderRegion;
  timeoutMs?: number;
}): Promise<BridgeHandle> {
  const binary = resolve(opts.binaryPath);
  await ensureSidecarBinary(binary);

  const apiKey = opts.apiKey || `sk-bridge-${crypto.randomUUID().replaceAll("-", "")}`;
  const dataPath = resolve(opts.dataPath);

  // Merge into an existing data.json so admin-panel edits and stats survive restarts.
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
    // A real PAT wins over any IDE identity left in data.json by an earlier
    // no-PAT run (the Go side skips the PAT exchange whenever an identity is
    // present). A placeholder is not a real PAT — it only clears the
    // Go non-empty gate while the IDE identity does the actual auth.
    const isPlaceholder = pat === placeholderFor(region);
    if (!isPlaceholder) {
      delete data.securityOauthToken;
      delete data.refreshToken;
      delete data.uid;
      delete data.nickname;
      delete data.expireTime;
    }
  } else {
    // No PAT — reuse the desktop IDE's own login identity instead (cn and
    // intl alike). Stale identity fields are dropped first so a dead login
    // can never shadow a PAT later added via the sidecar admin panel.
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
      // Go builds no bridge for an empty PAT: the placeholder only clears
      // that non-empty gate — the session still bootstraps purely from the
      // IDE identity above, and no PAT exchange ever runs. A real PAT
      // (config or admin panel) always replaces this marker. cn and intl
      // alike (placeholder == region id, see placeholderFor).
      data.pat = placeholderFor(region);
      console.log(`[qoder-bridge] using ${region} IDE identity of ${ide.nickname} (expires ${ide.expireTime ? new Date(ide.expireTime).toISOString() : "unknown"}) — 已复用本机 Qoder IDE 登录（config 里 ${region} pat 为空即走此 IDE 身份，有真实 PAT 则 PAT 优先）`);
    } else {
      // Drop our own placeholder when the IDE login is gone — a stale marker
      // must never masquerade as a PAT. A real PAT (e.g. from the sidecar
      // admin panel) is left untouched so it takes effect.
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
      // not up yet
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
