import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { readQoderIdeIdentity } from "./ide-credentials.js";

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

export async function startBridge(opts: {
  binaryPath: string;
  dataPath: string;
  pat?: string;
  port: number;
  apiKey?: string;
  /** "intl" runs the sidecar against the international (qoder.com) deployment. */
  region?: "cn" | "intl";
  timeoutMs?: number;
}): Promise<BridgeHandle> {
  const binary = resolve(opts.binaryPath);
  if (!existsSync(binary)) {
    throw new Error(
      `qoder bridge binary not found at ${binary} — build it from Qoder-2API-Go (go build -o bridges/qoder2api.exe .) or download a release`,
    );
  }

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
  if (opts.pat?.trim()) data.pat = opts.pat.trim();
  if (opts.region === "intl" && !opts.pat?.trim()) {
    // INTL: no PAT — reuse the desktop IDE's own login identity instead.
    const ide = readQoderIdeIdentity();
    if (ide) {
      data.securityOauthToken = ide.token;
      data.refreshToken = ide.refreshToken;
      data.uid = ide.uid;
      data.nickname = ide.nickname;
      data.expireTime = ide.expireTime;
      console.log(`[qoder-bridge] using intl IDE identity of ${ide.nickname} (expires ${ide.expireTime ? new Date(ide.expireTime).toISOString() : "unknown"})`);
    } else {
      console.warn("[qoder-bridge] no PAT and no logged-in intl Qoder IDE found — set providers.qoderIntl.pat or log in to the IDE");
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
      ...(opts.region === "intl" ? { QODER_REGION: "intl" } : {}),
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
    console.warn(
      "[qoder-bridge] no PAT configured — set providers.qoder.pat in config.json (or via the bridge admin panel), then restart all2api",
    );
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
