import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CodeBuddy / WorkBuddy（腾讯）桌面端凭据处理。
 *
 * 桌面应用在 CodeBuddyExtension/Data/Public/auth/*.info 下为每个账号保存一个 JSON auth 文件。
 * 自 WorkBuddy 5.6 起，accessToken/refreshToken 字段被封装为 {$wbEncrypted:1, envelope}
 * 形式（AES-256-GCM）。密钥从不存放在文件中，而是在运行时从应用自身的 Electron
 * 二进制文件中获取：其私有 `workbuddyStorage` 绑定在以 ELECTRON_RUN_AS_NODE=1
 * 运行时会暴露 {version:1, atRestSecretKey}。以下全部逻辑已针对 5.6.2
 * 实机验证通过（Windows + macOS，详见 README 附录与 dsh-workbuddy-connect 中的原始记录）。
 */

const BACKEND = "https://copilot.tencent.com";
const DEFAULT_DOMAIN = "www.codebuddy.cn";
const REFRESH_MARGIN_MS = 60_000;

// ---------- 信封（envelope）加解密 ----------

export interface WorkBuddyEnvelope {
  suite: number;
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/** suite-1 字段信封（envelope）的认证上下文 AAD（WBEV1 帧格式）。 */
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

/** 按桌面端写入的精确格式重新密封（seal）字段（suite 1）。 */
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

// ---------- 静态密钥提取（会拉起应用自身的 Electron） ----------

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
      // 注册表不可读——尝试下一个 hive
    }
  }
  return undefined;
}

/** 定位 WorkBuddy 桌面端 Electron 二进制文件。 */
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
    "WorkBuddy desktop binary not found — install/login the desktop app once, or set WORKBUDDY_ELECTRON_BIN env var",
  );
}

export interface AtRestKey {
  key: Buffer;
  keyId: string;
}

/**
 * 解析并缓存静态保护密钥（at-rest protector key）。每个进程对每个已解析密钥只拉起一次
 * Electron；仅当信封（envelope）中出现另一个密钥 ID（key rotation，密钥轮换）时才重新解析。
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

// ---------- auth 文档 ----------

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

  /** auth 目录下的第一个 *.info 文件（未配置时使用各平台默认值）。 */
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

  /** 按需解密并返回当前账号与 token 字段。 */
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

  /** 后端请求头；接近过期时先刷新 token。 */
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

  /** 强制刷新（用于 401 重试）。单飞（Single-flight）防并发。 */
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

  /** 将刷新响应合并到 auth 文档并按原始结构写回。 */
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

    // 用当前密钥重新密封（re-seal）原本加密过的字段
    //（get() 期间已解析过密钥，因此 forKey 会命中缓存）。
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
