import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CodeBuddy / WorkBuddy (Tencent) desktop credential handling.
 *
 * The desktop app stores one JSON auth file per account under
 * CodeBuddyExtension/Data/Public/auth/*.info. Since WorkBuddy 5.6 the
 * accessToken/refreshToken fields are wrapped as {$wbEncrypted:1, envelope}
 * (AES-256-GCM). The key never lives in the file: it is fetched at runtime
 * from the app's own Electron binary, whose private `workbuddyStorage`
 * binding exposes {version:1, atRestSecretKey} when run with
 * ELECTRON_RUN_AS_NODE=1. Everything below was verified live against 5.6.2
 * (Windows + macOS, see README appendix and dsh-workbuddy-connect for the
 * original transcription).
 */

const BACKEND = "https://copilot.tencent.com";
const DEFAULT_DOMAIN = "www.codebuddy.cn";
const REFRESH_MARGIN_MS = 60_000;

// ---------- envelope crypto ----------

export interface WorkBuddyEnvelope {
  suite: number;
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** Authenticated-context AAD for suite-1 field envelopes (WBEV1 framing). */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.alloc(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"),
    Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2, 0, 0]),
  ]);
}

export function parseEnvelope(value: unknown): WorkBuddyEnvelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const wrapped = value as Record<string, unknown>;
  if (wrapped["$wbEncrypted"] !== 1 || typeof wrapped["envelope"] !== "string") return undefined;
  let inner: Record<string, unknown>;
  try {
    inner = JSON.parse(Buffer.from(wrapped["envelope"], "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof inner["suite"] !== "number" || inner["suite"] !== 1) return undefined;
  if (typeof inner["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(inner["keyId"])) return undefined;
  const nonce = Buffer.from(String(inner["nonce"] ?? ""), "base64");
  const authTag = Buffer.from(String(inner["authTag"] ?? ""), "base64");
  const ciphertext = Buffer.from(String(inner["ciphertext"] ?? ""), "base64");
  if (nonce.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) return undefined;
  return { suite: 1, keyId: inner["keyId"], nonce, authTag, ciphertext };
}

export function isOpenEnvelope(value: unknown): value is { $wbEncrypted: 1; envelope: string } {
  return parseEnvelope(value) !== undefined;
}

export function openEnvelope(key: Buffer, envelope: WorkBuddyEnvelope): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Seal a field back in the exact format the desktop app writes (suite 1). */
export function sealField(key: Buffer, keyId: string, plaintext: string): { $wbEncrypted: 1; envelope: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(buildAuthenticatedContextAad(keyId, 1));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const inner = {
    suite: 1,
    keyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(inner), "utf8").toString("base64") };
}

// ---------- at-rest key extraction (spawns the app's own Electron) ----------

const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

async function firstExisting(paths: (string | undefined)[]): Promise<string | undefined> {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

async function electronFromWindowsRegistry(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  for (const hive of ["HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]) {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile("reg", ["query", hive, "/s", "/f", "WorkBuddy"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
          err ? reject(err) : resolve(out),
        );
      });
      const iconLine = stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("DisplayIcon") && /workbuddy\.exe/i.test(l));
      if (!iconLine) continue;
      const value = iconLine.split("REG_SZ")[1]?.trim() ?? "";
      const exe = value.split(",")[0]?.trim();
      if (exe && existsSync(exe)) return exe;
    } catch {
      // registry unreadable — try next hive
    }
  }
  return undefined;
}

/** Locate the WorkBuddy desktop Electron binary. */
export async function findWorkBuddyElectron(configured?: string): Promise<string> {
  const envPath = process.env["WORKBUDDY_ELECTRON_BIN"]?.trim() || undefined;
  const platformDefault =
    process.platform === "darwin"
      ? "/Applications/WorkBuddy.app/Contents/MacOS/Electron"
      : process.platform === "win32"
        ? join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Tencent", "WorkBuddy", "WorkBuddy.exe")
        : undefined;

  const found = await firstExisting([
    configured,
    envPath,
    platformDefault,
    await electronFromWindowsRegistry(),
  ]);
  if (found) return found;
  throw new Error(
    "WorkBuddy desktop binary not found — install/login the desktop app once, or set providers.codebuddy.electronPath (env: WORKBUDDY_ELECTRON_BIN)",
  );
}

export interface AtRestKey {
  key: Buffer;
  keyId: string;
}

/**
 * Resolves and caches the at-rest protector key. One Electron spawn per
 * process per resolved key; re-resolved only when an envelope names another
 * key id (key rotation).
 */
export class AtRestKeyProvider {
  private inflight: Promise<AtRestKey> | undefined;
  private cache: AtRestKey | undefined;

  constructor(
    private readonly electronPath?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async forKey(envelopeKeyId: string): Promise<AtRestKey> {
    const cached = this.cache;
    if (cached && cached.keyId === envelopeKeyId) return cached;
    this.inflight ??= this.resolve().finally(() => {
      this.inflight = undefined;
    });
    const resolved = await this.inflight;
    if (resolved.keyId !== envelopeKeyId) {
      throw new Error(
        `at-rest key mismatch: envelope keyId ${envelopeKeyId} but current install ${resolved.keyId} — the credential was sealed by a different WorkBuddy installation`,
      );
    }
    this.cache = resolved;
    return resolved;
  }

  private async resolve(): Promise<AtRestKey> {
    const binary = await findWorkBuddyElectron(this.electronPath);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        ["-e", HELPER_SCRIPT],
        {
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
        (err, out) => (err ? reject(new Error(`WorkBuddy key helper (${binary}) failed: ${(err as Error).message}`)) : resolve(out)),
      );
    });
    const payload = JSON.parse(stdout.trim()) as { version?: number; atRestSecretKey?: string };
    if (payload.version !== 1 || typeof payload.atRestSecretKey !== "string" || payload.atRestSecretKey === "") {
      throw new Error("WorkBuddy key helper returned an unusable payload (expected {version:1, atRestSecretKey})");
    }
    const key = createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();
    const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return { key, keyId };
  }
}

// ---------- auth document ----------

export interface CodeBuddyAccount {
  uid?: string;
  nickname?: string;
  enterpriseId?: string;
  [key: string]: unknown;
}

export interface CodeBuddyAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  domain: string;
  enterpriseId: string;
  uid: string;
}

export class CodeBuddyCredentials {
  private readonly keyProvider: AtRestKeyProvider;
  private cached: { doc: Record<string, unknown>; mtime: number } | null = null;
  private decrypted: CodeBuddyAuth | null = null;
  private inflightRefresh: Promise<void> | undefined;
  private readonly refreshUrl = `${BACKEND}/v2/plugin/auth/token/refresh`;

  constructor(
    private readonly authDir?: string,
    electronPath?: string,
    private readonly userAgent = "all2api/0.1",
  ) {
    this.keyProvider = new AtRestKeyProvider(electronPath);
  }

  /** First *.info file in the auth dir (platform default when not configured). */
  authFile(): string {
    const dir =
      this.authDir ??
      (process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")
        : process.platform === "win32"
          ? join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "CodeBuddyExtension", "Data", "Public", "auth")
          : join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "CodeBuddyExtension", "Data", "Public", "auth"));
    if (!existsSync(dir)) {
      throw new Error(`CodeBuddy/WorkBuddy auth dir not found: ${dir} — log in to the desktop app first`);
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".info"))
      .sort();
    if (files.length === 0) throw new Error(`no *.info credential file in ${dir} — log in to the desktop app first`);
    return join(dir, files[0]!);
  }

  private load(): { doc: Record<string, unknown>; mtime: number } {
    const file = this.authFile();
    const mtime = Math.floor((statMtimeMs(file)));
    if (this.cached && this.cached.mtime === mtime) return this.cached;
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    this.cached = { doc, mtime };
    this.decrypted = null;
    return this.cached;
  }

  /** Decrypt (when needed) and return the current account + token fields. */
  async get(): Promise<CodeBuddyAuth> {
    const { doc } = this.load();
    if (this.decrypted) return this.decrypted;

    const auth = (doc["auth"] ?? doc) as Record<string, unknown>;
    const account = (doc["account"] ?? {}) as CodeBuddyAccount;
    const fields: Array<"accessToken" | "refreshToken"> = ["accessToken", "refreshToken"];
    const out: Record<string, string> = {};

    for (const field of fields) {
      const value = auth[field];
      if (typeof value === "string") {
        out[field] = value;
        continue;
      }
      const envelope = parseEnvelope(value);
      if (!envelope) throw new Error(`auth.${field} is neither plaintext nor a decodable $wbEncrypted envelope`);
      const { key } = await this.keyProvider.forKey(envelope.keyId);
      const opened = openEnvelope(key, envelope);
      if (opened === undefined) throw new Error(`failed to open auth.${field} (keyId ${envelope.keyId}) — wrong key or corrupted envelope`);
      out[field] = opened;
    }

    this.decrypted = {
      accessToken: out["accessToken"] ?? "",
      refreshToken: out["refreshToken"] ?? "",
      expiresAt: Number(auth["expiresAt"] ?? 0),
      domain: String(auth["domain"] ?? DEFAULT_DOMAIN),
      enterpriseId: String(account["enterpriseId"] ?? ""),
      uid: String(account["uid"] ?? ""),
    };
    return this.decrypted;
  }

  isExpired(creds: CodeBuddyAuth): boolean {
    return creds.expiresAt > 0 && Date.now() >= creds.expiresAt - REFRESH_MARGIN_MS;
  }

  /** Backend request headers; refreshes the token first when near expiry. */
  async headers(): Promise<Record<string, string>> {
    let creds = await this.get();
    if (this.isExpired(creds)) await this.refresh();
    creds = await this.get();
    return {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${creds.accessToken}`,
      "x-user-id": creds.uid,
      "x-enterprise-id": creds.enterpriseId,
      "x-tenant-id": creds.enterpriseId,
      "x-domain": creds.domain,
      "user-agent": this.userAgent,
    };
  }

  /** Force a refresh (used on 401 retries). Single-flight. */
  async refresh(): Promise<void> {
    this.inflightRefresh ??= this.doRefresh().finally(() => {
      this.inflightRefresh = undefined;
    });
    return this.inflightRefresh;
  }

  private async doRefresh(): Promise<void> {
    const creds = await this.get();
    if (!creds.refreshToken) throw new Error("no refresh token available — log in to the desktop app again");
    const res = await fetch(this.refreshUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${creds.accessToken}`,
        "x-user-id": creds.uid,
        "x-enterprise-id": creds.enterpriseId,
        "x-tenant-id": creds.enterpriseId,
        "x-domain": creds.domain,
        "x-refresh-token": creds.refreshToken,
        "x-auth-refresh-source": "plugin",
        "user-agent": this.userAgent,
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: Record<string, unknown> };
    if (json.code !== 0 || !json.data) {
      throw new Error(`token refresh rejected (${res.status}): ${json.msg ?? "empty response"} — log in to the desktop app again`);
    }
    this.writeBack(json.data);
  }

  /** Merge refresh response into the auth doc and write it back in its original shape. */
  private async writeBack(newAuth: Record<string, unknown>): Promise<void> {
    const file = this.authFile();
    const { doc, mtime } = this.load();
    const auth = (doc["auth"] ?? doc) as Record<string, unknown>;

    const now = Date.now();
    const expiresIn = Number(newAuth["expiresIn"] ?? 0);
    const merged: Record<string, unknown> = {
      ...auth,
      ...newAuth,
      domain: String(newAuth["domain"] ?? auth["domain"] ?? DEFAULT_DOMAIN),
      lastRefreshTime: now,
    };
    if (!merged["expiresAt"] && expiresIn > 0) merged["expiresAt"] = now + expiresIn * 1000;
    if (!merged["refreshExpiresAt"] && Number(newAuth["refreshExpiresIn"] ?? 0) > 0) {
      merged["refreshExpiresAt"] = now + Number(newAuth["refreshExpiresIn"]) * 1000;
    }

    // Re-seal whatever fields were encrypted originally, under the current key
    // (already resolved during get(), so forKey returns from cache).
    const sealed: Record<string, unknown> = { ...merged };
    for (const field of ["accessToken", "refreshToken"] as const) {
      const original = auth[field];
      const value = merged[field];
      if (typeof value !== "string") continue;
      if (isOpenEnvelope(original)) {
        const envelope = parseEnvelope(original)!;
        const { key } = await this.keyProvider.forKey(envelope.keyId);
        sealed[field] = sealField(key, envelope.keyId, value);
      }
    }

    doc["auth"] = sealed;
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    renameSync(tmp, file);
    this.cached = { doc, mtime: statMtimeMs(file) };
    this.decrypted = null;
  }
}

function statMtimeMs(file: string): number {
  return statSync(file).mtimeMs;
}
