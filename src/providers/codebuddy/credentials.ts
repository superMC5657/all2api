import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { readVscdbAuth, type VscdbSourceOptions } from "./vscdb.js";

/**
 * CodeBuddy / WorkBuddy（腾讯）桌面端凭据处理。
 *
 * 桌面应用在 <App>Extension/Data/Public/auth/*.info 下为每个账号保存一个 JSON auth 文件
 * （CodeBuddy 与 WorkBuddy 双 App 目录都要探测，首个存在且含 *.info 的即用）。
 * 自 WorkBuddy 5.6 起，accessToken/refreshToken 字段被封装为 {$wbEncrypted:1, envelope}
 * 形式（AES-256-GCM）。密钥从不存放在文件中，而是在运行时从应用自身的 Electron
 * 二进制文件中获取：其私有存储绑定在以 ELECTRON_RUN_AS_NODE=1
 * 运行时会暴露 {version:1, atRestSecretKey}（按序尝试 workbuddy 系 → codebuddy 系
 * → buddy 系绑定名，任一命中即用）。以下全部逻辑已针对 5.6.2
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

/**
 * at-rest 密钥的 Electron linked-binding 候选名（按序尝试）。
 * WorkBuddy 5.6 实机为 `electron_browser_workbuddy_storage`；CodeBuddy 系
 * 的绑定名未经实机确认，故把 `codebuddy` 变体与常见短名一并列为候选；
 * buddycn（VSCode 系，大概率无私有绑定）候选追加在最后，不动 Win 优先序。
 * 首个返回 {version:1, atRestSecretKey} 的即用（任一命中即可）。
 */
export const AT_REST_KEY_BINDINGS = [
  "electron_browser_workbuddy_storage",
  "electron_browser_codebuddy_storage",
  "workbuddy_storage",
  "codebuddy_storage",
  "electron_browser_buddy_storage",
  "buddy_storage",
];

/** 组装 `-e` helper：按序尝试绑定名，首个可用 payload 直接 stdout 输出（附带命中的 binding 名）。 */
export function buildKeyHelperScript(extraBindingFirst?: string): string {
  const names = [extraBindingFirst?.trim(), ...AT_REST_KEY_BINDINGS].filter((n): n is string => !!n);
  const list = JSON.stringify([...new Set(names)]);
  return (
    `const names=${list};` +
    `let out="";let win="";` +
    `for (const n of names){` +
    `try{` +
    `const s=String(process._linkedBinding(n).loggerGet());` +
    `const p=JSON.parse(s);` +
    `if(p&&p.version===1&&typeof p.atRestSecretKey==="string"&&p.atRestSecretKey!==""){out=p.atRestSecretKey;win=n;break;}` +
    `}catch(e){}` +
    `}` +
    `if(!out)throw new Error("no usable at-rest key binding ("+names.join(", ")+")");` +
    `process.stdout.write(JSON.stringify({version:1,atRestSecretKey:out,binding:win}));`
  );
}

/** Windows 注册表卸载项中按序查找 WorkBuddy / CodeBuddy 的安装路径（双 App 都要探测）。 */
async function electronFromWindowsRegistry(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const found: string[] = [];
  // WorkBuddy 在前（保留原有优先顺序），CodeBuddy 随后；任一命中即后续按序取用
  const apps: Array<{ query: string; exeRe: RegExp }> = [
    { query: "WorkBuddy", exeRe: /workbuddy\.exe/i },
    { query: "CodeBuddy", exeRe: /codebuddy\.exe/i },
  ];
  for (const app of apps) {
    for (const hive of ["HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"]) {
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile("reg", ["query", hive, "/s", "/f", app.query], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
            err ? reject(err) : resolve(out),
          );
        });
        const iconLine = stdout
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("DisplayIcon") && app.exeRe.test(l));
        if (!iconLine) continue;
        const value = iconLine.split("REG_SZ")[1]?.trim() ?? "";
        const exe = value.split(",")[0]?.trim();
        if (exe && existsSync(exe)) found.push(exe);
      } catch {
        // 注册表不可读——尝试下一个 hive / App
      }
    }
  }
  return found;
}

/** Windows 双 App Electron 二进制默认安装位（WorkBuddy 在前以保留原优先顺序）。 */
function windowsElectronDefaults(): string[] {
  const programFiles = [
    process.env["ProgramFiles"] ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  ];
  const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const out: string[] = [];
  for (const pf of programFiles) {
    out.push(join(pf, "Tencent", "WorkBuddy", "WorkBuddy.exe"));
  }
  for (const pf of programFiles) {
    out.push(join(pf, "Tencent", "CodeBuddy", "CodeBuddy.exe"));
  }
  out.push(
    join(localAppData, "Tencent", "WorkBuddy", "WorkBuddy.exe"),
    join(localAppData, "Tencent", "CodeBuddy", "CodeBuddy.exe"),
    join(localAppData, "Programs", "WorkBuddy", "WorkBuddy.exe"),
    join(localAppData, "Programs", "CodeBuddy", "CodeBuddy.exe"),
  );
  return out;
}

/** Linux 下 PATH 扫描（等价于 `which <name>`，不额外拉起进程）。 */
function pathLookup(names: string[]): string[] {
  const out: string[] = [];
  const dirs = (process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin").split(":");
  for (const name of names) {
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (existsSync(candidate)) out.push(candidate);
    }
  }
  // 常见但常不在 PATH 的安装位由 linuxElectronCandidates 显式列出
  return out;
}

/** 扫描 /opt 下 CodeBuddy/WorkBuddy/buddy 前缀目录里的可执行候选。 */
function optDirCandidates(): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/opt");
  } catch {
    return out;
  }
  const binaries = ["codebuddy", "CodeBuddy", "workbuddy", "WorkBuddy", "electron", "Electron"];
  for (const entry of entries) {
    if (!/^(codebuddy|workbuddy|buddy)/i.test(entry)) continue;
    for (const bin of binaries) out.push(join("/opt", entry, bin));
  }
  // 无版本号的常规安装位（/opt 下无匹配时的兜底）
  for (const bin of binaries) {
    out.push(join("/opt", "CodeBuddy", bin));
    out.push(join("/opt", "WorkBuddy", bin));
  }
  return out;
}

/** /usr/share 下 codebuddy/workbuddy/buddy 数据目录里的可执行候选。 */
function usrShareCandidates(): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync("/usr/share");
  } catch {
    return out;
  }
  const binaries = ["codebuddy", "CodeBuddy", "workbuddy", "WorkBuddy"];
  for (const entry of entries) {
    if (!/^(codebuddy|workbuddy|buddy)/i.test(entry)) continue;
    for (const bin of binaries) out.push(join("/usr/share", entry, bin));
  }
  return out;
}

/**
 * 解析 .desktop 桌面项的 Exec 首 token（去引号与 %U 等 field code）。
 * 只收录指向 codebuddy/workbuddy/buddy 的条目，避免误拾无关应用。
 */
function desktopExecCandidates(): string[] {
  const out: string[] = [];
  const dirs = [join(homedir(), ".local", "share", "applications"), "/usr/share/applications"];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".desktop")) continue;
      let text = "";
      try {
        text = readFileSync(join(dir, file), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("Exec=")) continue;
        const raw = trimmed.slice("Exec=".length).trim();
        // 首 token：支持引号包裹路径
        const match = raw.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
        const binary = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
        if (!binary) continue;
        const cleaned = binary.replace(/%[a-zA-Z]/g, "").trim();
        if (!cleaned) continue;
        if (!/(codebuddy|workbuddy|buddy)/i.test(cleaned)) continue;
        out.push(cleaned);
      }
    }
  }
  return out;
}

/** Linux 版 Electron 二进制候选（尽力探测；找不到由调用方抛原错）。 */
function linuxElectronCandidates(): string[] {
  return [
    // 本机实测（dpkg codebuddy-cn 4.12.0）：真实二进制位于此；/usr/bin/buddycn
    // 仅为指向它的符号链接，故显式真实路径置前，确保命中 canonical 路径
    "/usr/share/buddycn/bin/buddycn",
    "/usr/share/buddycn/bin/buddycn-desktop",
    ...pathLookup(["codebuddy", "CodeBuddy", "workbuddy", "WorkBuddy", "buddycn", "buddycn-desktop"]),
    ...optDirCandidates(),
    ...usrShareCandidates(),
    ...desktopExecCandidates(),
    "/usr/bin/codebuddy",
    "/usr/local/bin/codebuddy",
    "/snap/bin/codebuddy",
    join(homedir(), ".local", "bin", "codebuddy"),
    "/usr/bin/workbuddy",
    "/usr/local/bin/workbuddy",
    "/snap/bin/workbuddy",
    join(homedir(), ".local", "bin", "workbuddy"),
  ];
}

/** electron 维度是否被钉（env / 配置任一非空；linux 下 env 在前，win/darwin 下配置在前，保持原优先序）。 */
export function electronPinnedPath(configured?: string): string | undefined {
  const envPath = process.env["WORKBUDDY_ELECTRON_BIN"]?.trim() || undefined;
  const cfgPath = configured?.trim() || undefined;
  if (process.platform === "linux") return envPath ?? cfgPath;
  return cfgPath ?? envPath;
}

/** 按现有优先序枚举全部已存在的 Electron 二进制（去重）；被钉时只含被钉项（缺失直接抛，不掉自动探测）。 */
export async function listElectronBinaries(configured?: string): Promise<string[]> {
  const pinned = electronPinnedPath(configured);
  if (pinned) {
    if (!existsSync(pinned)) {
      throw new Error(
        `WorkBuddy desktop binary not found（显式指定）: ${pinned} — install/login the desktop app once, or set WORKBUDDY_ELECTRON_BIN env var`,
      );
    }
    return [pinned];
  }
  const ordered =
    process.platform === "linux"
      ? [...linuxElectronCandidates()]
      : process.platform === "darwin"
        ? ["/Applications/WorkBuddy.app/Contents/MacOS/Electron"]
        : [...windowsElectronDefaults(), ...(await electronFromWindowsRegistry())];
  const out = [...new Set(ordered.filter((p) => p && existsSync(p)))];
  if (out.length === 0) {
    throw new Error(
      "WorkBuddy desktop binary not found — install/login the desktop app once, or set WORKBUDDY_ELECTRON_BIN env var",
    );
  }
  return out;
}

/** 定位 WorkBuddy 桌面端 Electron 二进制文件（首个命中；被钉时只认被钉项）。 */
export async function findWorkBuddyElectron(configured?: string): Promise<string> {
  return (await listElectronBinaries(configured))[0]!;
}

export interface AtRestKey {
  key: Buffer;
  keyId: string;
}

/** 逐二进制解析结果（附带命中的 binding 名与二进制路径，供配对 tried 记录）。 */
export interface ResolvedAtRestKey extends AtRestKey {
  binding: string;
  binary: string;
}

/**
 * 解析并缓存静态保护密钥（at-rest protector key）。每个进程对每个已解析密钥只拉起一次
 * Electron；仅当信封（envelope）中出现另一个密钥 ID（key rotation，密钥轮换）时才重新解析。
 */
export class AtRestKeyProvider {
  private inflight: Promise<AtRestKey> | undefined;
  private cache: AtRestKey | undefined;
  private perBinaryCache = new Map<string, ResolvedAtRestKey>();
  private perBinaryInflight = new Map<string, Promise<ResolvedAtRestKey>>();

  constructor(
    private readonly electronPath?: string,
    private readonly timeoutMs = 10_000,
    private readonly keyBinding?: string,
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

  /**
   * 从指定二进制解析密钥（不做 keyId 校验，由配对循环比对；成功才缓存，单飞按二进制隔离）。
   * forceRefresh=true 时绕过缓存重拉一次（命中 key rotation 时用）。
   */
  async resolveForBinary(binary: string, forceRefresh = false): Promise<ResolvedAtRestKey> {
    if (!forceRefresh) {
      const hit = this.perBinaryCache.get(binary);
      if (hit) return hit;
    }
    let p = this.perBinaryInflight.get(binary);
    if (!p) {
      p = this.resolveWith(binary).finally(() => {
        this.perBinaryInflight.delete(binary);
      });
      this.perBinaryInflight.set(binary, p);
    }
    const resolved = await p;
    this.perBinaryCache.set(binary, resolved);
    return resolved;
  }

  private async resolve(): Promise<AtRestKey> {
    const binary = await findWorkBuddyElectron(this.electronPath);
    return this.resolveWith(binary);
  }

  private async resolveWith(binary: string): Promise<ResolvedAtRestKey> {
    const helper = buildKeyHelperScript(this.keyBinding);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        binary,
        ["-e", helper],
        {
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
        (err, out) => (err ? reject(new Error(`WorkBuddy key helper (${binary}) failed: ${(err as Error).message}`)) : resolve(out)),
      );
    });
    const payload = JSON.parse(stdout.trim()) as { version?: number; atRestSecretKey?: string; binding?: string };
    if (payload.version !== 1 || typeof payload.atRestSecretKey !== "string" || payload.atRestSecretKey === "") {
      throw new Error("WorkBuddy key helper returned an unusable payload (expected {version:1, atRestSecretKey})");
    }
    const key = createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();
    const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return { key, keyId, binding: payload.binding || "unknown", binary };
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
  private infoStates = new Map<string, { doc: Record<string, unknown>; mtime: number; auth: CodeBuddyAuth | undefined; key: AtRestKey | undefined }>();
  private vscdbCached: CodeBuddyAuth | null = null;
  private lastSource: "info" | "vscdb" | undefined;
  private lastInfoFile: string | undefined;
  private lastResolvedKey: AtRestKey | undefined;
  private inflightRefresh: Promise<void> | undefined;
  private readonly refreshUrl = `${BACKEND}/v2/plugin/auth/token/refresh`;

  constructor(
    private readonly authDir?: string,
    private readonly electronPath?: string,
    private readonly userAgent = "all2api/0.1",
    keyBinding?: string,
    private readonly vscdb?: VscdbSourceOptions,
  ) {
    this.keyProvider = new AtRestKeyProvider(electronPath, undefined, keyBinding);
  }

  private vscdbOptions(): VscdbSourceOptions {
    return {
      dbPath: this.vscdb?.dbPath,
      key: this.vscdb?.key,
      app: this.vscdb?.app,
      vscdbDir: this.vscdb?.vscdbDir,
      keyringSecret: this.vscdb?.keyringSecret,
      timeoutMs: this.vscdb?.timeoutMs,
    };
  }

  /** auth 维度 .info 侧是否被钉（显式位置任一非空即独占，不掉自动探测）。 */
  private isAuthInfoPinned(): boolean {
    return !!(this.authDir?.trim() || process.env["WORKBUDDY_AUTH_FILE"]?.trim());
  }

  /** auth 维度 vscdb 侧是否被钉。 */
  private isVscdbPinned(): boolean {
    return !!(this.vscdb?.dbPath?.trim() || process.env["CODEBUDDY_VSCDB"]?.trim());
  }

  /** electron 维度是否被钉（被钉时二进制只用被钉项）。 */
  private isElectronPinned(): boolean {
    return electronPinnedPath(this.electronPath) !== undefined;
  }

  /** 显式指定的 auth 位置：文件直接用，目录取其下全部 *.info（缺失/无命中直接抛，含显式指定文案）。 */
  private explicitAuthFiles(): string[] {
    const explicit = this.authDir?.trim() || process.env["WORKBUDDY_AUTH_FILE"]?.trim() || undefined;
    if (!explicit) return [];
    if (!existsSync(explicit)) {
      throw new Error(`CodeBuddy/WorkBuddy auth dir not found: ${explicit} — log in to the desktop app first（显式指定）`);
    }
    try {
      if (statSync(explicit).isFile()) return [explicit];
    } catch {
      throw new Error(`CodeBuddy/WorkBuddy auth dir not found: ${explicit} — log in to the desktop app first（显式指定）`);
    }
    const files = readdirSync(explicit)
      .filter((f) => f.endsWith(".info"))
      .sort()
      .map((f) => join(explicit, f));
    if (files.length === 0) {
      throw new Error(`no *.info credential file in ${explicit} — log in to the desktop app first（显式指定）`);
    }
    return files;
  }

  /** 显式指定的 auth 位置（首个；兼容旧行为）。 */
  private explicitAuthFile(): string | undefined {
    const files = this.explicitAuthFiles();
    return files.length > 0 ? files[0] : undefined;
  }

  /** 各平台自动探测的 auth 目录优先序（Win: CodeBuddy→WorkBuddy；Linux: 双 App×双 XDG）。 */
  private autoAuthDirs(): string[] {
    if (process.platform === "darwin") {
      return [join(homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
    }
    if (process.platform === "win32") {
      // Windows 双 App auth 目录都要探测（CodeBuddy 在前以保留原优先顺序）
      const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      return [
        join(localAppData, "CodeBuddyExtension", "Data", "Public", "auth"),
        join(localAppData, "WorkBuddyExtension", "Data", "Public", "auth"),
      ];
    }
    // Linux：双 App × 双 XDG 基址，同基址下 CodeBuddy 在前
    const bases = [
      process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
      join(homedir(), ".local", "share"),
      process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
      join(homedir(), ".config"),
    ];
    const candidates: string[] = [];
    for (const base of bases) {
      for (const appDir of ["CodeBuddyExtension", "WorkBuddyExtension"]) {
        candidates.push(join(base, appDir, "Data", "Public", "auth"));
      }
    }
    return candidates;
  }

  /** auth 目录下的第一个 *.info 文件（未配置时使用各平台默认值；兼容旧行为）。 */
  authFile(): string {
    const explicit = this.explicitAuthFile();
    if (explicit) return explicit;
    if (process.platform === "darwin") {
      return requireInfoFile(this.autoAuthDirs()[0]!);
    }
    return probeAuthDirs(this.autoAuthDirs());
  }

  /** 配对用的全部 .info 候选（被钉时仅被钉源；自动时按目录优先序枚举全部）。 */
  private listAuthFiles(): string[] {
    const pinned = this.explicitAuthFiles();
    if (pinned.length > 0) return pinned;
    const { files, existing, unique } = collectInfoFiles(this.autoAuthDirs());
    if (files.length === 0) throwNoAuthFiles(unique, existing);
    return files;
  }

  /** 配对用的二进制候选（被钉时仅被钉项；自动时按现有优先序枚举全部已存在项）。 */
  private async listBinaries(): Promise<string[]> {
    return listElectronBinaries(this.electronPath);
  }

  /**
   * 按需解密并返回当前账号与 token 字段。
   * .info 优先（自动探测时配对逐个试）；仅其不可用时 fallback 到 vscdb。
   * 显式钉独占：auth 被钉只试被钉源，vscdb 被钉跳过 .info，两维都钉则全独占。
   */
  async get(): Promise<CodeBuddyAuth> {
    const authPinned = this.isAuthInfoPinned();
    const vscdbPinned = this.isVscdbPinned();
    if (!authPinned && !vscdbPinned) {
      try {
        return await this.getFromInfoPairs();
      } catch (infoError) {
        return await this.getFromVscdbFallback(infoError);
      }
    }
    if (authPinned && !vscdbPinned) {
      // auth 被钉：只试被钉源，失败直接抛，不掉自动探测/vscdb
      return this.getFromInfoPairs();
    }
    if (!authPinned && vscdbPinned) {
      // vscdb 被钉：跳过 .info 探测
      const auth = await readVscdbAuth(this.vscdbOptions());
      this.vscdbCached = auth;
      this.lastSource = "vscdb";
      return auth;
    }
    try {
      return await this.getFromInfoPairs();
    } catch (infoError) {
      return await this.getFromVscdbFallback(infoError);
    }
  }

  private async getFromVscdbFallback(infoError: unknown): Promise<CodeBuddyAuth> {
    if (this.vscdbCached) {
      this.lastSource = "vscdb";
      return this.vscdbCached;
    }
    try {
      const auth = await readVscdbAuth(this.vscdbOptions());
      this.vscdbCached = auth;
      this.lastSource = "vscdb";
      return auth;
    } catch (vscdbError) {
      const infoMsg = infoError instanceof Error ? infoError.message : String(infoError);
      const vscdbMsg = vscdbError instanceof Error ? vscdbError.message : String(vscdbError);
      throw new Error(`${infoMsg} (vscdb fallback also failed: ${vscdbMsg})`);
    }
  }

  /** 钉配置提示（耗尽时附带；已钉时标独占语义）。 */
  private pinHint(): string {
    if (this.isAuthInfoPinned() || this.isVscdbPinned() || this.isElectronPinned()) {
      return "（显式指定独占：仅试被钉源）";
    }
    return "（可用 authDir / WORKBUDDY_AUTH_FILE / WORKBUDDY_ELECTRON_BIN / electronPath 显式指定）";
  }

  /**
   * 配对逐个试：外层按 auth 文件优先序，内层按二进制优先序。
   * envelope 需二进制解出的 keyId 对上才解密；对不上记一笔继续，不抛错；全部试尽才抛。
   * 明文文件无需二进制，直接校验返回。命中才缓存（lastSource/lastInfoFile/lastResolvedKey）。
   */
  private async getFromInfoPairs(): Promise<CodeBuddyAuth> {
    const files = this.listAuthFiles();
    const tried: string[] = [];
    let binaries: string[] | undefined;
    let binariesError: unknown;
    let attemptedPair = false;
    const resolvedMemo = new Map<string, ResolvedAtRestKey | undefined>();
    const resolveMemo = async (binary: string): Promise<ResolvedAtRestKey | undefined> => {
      if (!resolvedMemo.has(binary)) {
        try {
          resolvedMemo.set(binary, await this.keyProvider.resolveForBinary(binary));
        } catch {
          resolvedMemo.set(binary, undefined);
        }
      }
      return resolvedMemo.get(binary);
    };
    const ensureBinaries = async (): Promise<string[]> => {
      if (!binaries) {
        try {
          binaries = await this.listBinaries();
        } catch (e) {
          binaries = [];
          binariesError = e;
        }
      }
      return binaries;
    };

    for (const file of files) {
      const aBase = basename(file);
      let st = this.infoStates.get(file);
      try {
        const mtime = Math.floor(statMtimeMs(file));
        if (!st || st.mtime !== mtime) {
          const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
          st = { doc, mtime, auth: undefined, key: undefined };
          this.infoStates.set(file, st);
        }
      } catch {
        tried.push(`${aBase}×(unreadable)`);
        continue;
      }
      if (st.auth) {
        this.lastSource = "info";
        this.lastInfoFile = file;
        this.lastResolvedKey = st.key;
        return st.auth;
      }
      const auth = (st.doc["auth"] ?? st.doc) as Record<string, unknown>;
      const account = (st.doc["account"] ?? {}) as CodeBuddyAccount;
      const out: Record<string, string> = {};
      const envelopes: Array<{ field: "accessToken" | "refreshToken"; envelope: WorkBuddyEnvelope }> = [];
      let malformed = false;
      for (const field of ["accessToken", "refreshToken"] as const) {
        const value = auth[field];
        if (typeof value === "string") {
          out[field] = value;
          continue;
        }
        const envelope = parseEnvelope(value);
        if (!envelope) {
          tried.push(`${aBase}×(bad-envelope:${field})`);
          malformed = true;
          break;
        }
        envelopes.push({ field, envelope });
      }
      if (malformed) continue;
      if (envelopes.length === 0) {
        const built = assembleAuth(auth, account, out);
        st.auth = built;
        st.key = undefined;
        this.lastSource = "info";
        this.lastInfoFile = file;
        this.lastResolvedKey = undefined;
        return built;
      }
      const bins = await ensureBinaries();
      if (bins.length === 0) {
        tried.push(`${aBase}×(no-binary)`);
        continue;
      }
      for (const binary of bins) {
        attemptedPair = true;
        const bBase = basename(binary);
        let resolved = await resolveMemo(binary);
        if (resolved && !envelopes.every((e) => e.envelope.keyId === resolved!.keyId)) {
          // 疑似 key rotation：重拉一次再比对
          try {
            resolved = await this.keyProvider.resolveForBinary(binary, true);
            resolvedMemo.set(binary, resolved);
          } catch {
            resolvedMemo.set(binary, undefined);
            resolved = undefined;
          }
        }
        if (!resolved) {
          tried.push(`${aBase}×${bBase}(helper-failed)`);
          continue;
        }
        const envHead4 = envelopes[0]!.envelope.keyId.slice(0, 4);
        if (!envelopes.every((e) => e.envelope.keyId === resolved!.keyId)) {
          tried.push(`${aBase}×${bBase}(${resolved.binding}:${resolved.keyId.slice(0, 4)}≠${envHead4})`);
          continue;
        }
        let openedOk = true;
        for (const { field, envelope } of envelopes) {
          const opened = openEnvelope(resolved.key, envelope);
          if (opened === undefined) {
            tried.push(`${aBase}×${bBase}(${resolved.binding}:${resolved.keyId.slice(0, 4)}:open-failed)`);
            openedOk = false;
            break;
          }
          out[field] = opened;
        }
        if (!openedOk) continue;
        const built = assembleAuth(auth, account, out);
        st.auth = built;
        st.key = resolved;
        this.lastSource = "info";
        this.lastInfoFile = file;
        this.lastResolvedKey = resolved;
        return built;
      }
    }
    const triedSuffix = tried.length > 0 ? ` tried: ${tried.join(" ")}` : "";
    if (binariesError && !attemptedPair) {
      const msg = binariesError instanceof Error ? binariesError.message : String(binariesError);
      throw new Error(`${msg}${triedSuffix}${this.pinHint()}`);
    }
    throw new Error(`no working CodeBuddy/WorkBuddy auth pair — log in to the desktop app first${triedSuffix}${this.pinHint()}`);
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
    if (this.lastSource === "vscdb") {
      // v1：vscdb 只读不写（IDE 可能持锁），refresh = 内存重读
      this.vscdbCached = await readVscdbAuth(this.vscdbOptions());
      return;
    }
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

  /** 将刷新响应合并到 auth 文档并按原始结构写回（仅 .info 路径；命中文件 + 命中密钥优先复用）。 */
  private async writeBack(newAuth: Record<string, unknown>): Promise<void> {
    const file = this.lastInfoFile ?? this.authFile();
    const mtime = Math.floor(statMtimeMs(file));
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
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
    //（get() 命中时已缓存密钥，优先复用；否则走原 forKey 路径）。
    const sealed: Record<string, unknown> = { ...merged };
    for (const field of ["accessToken", "refreshToken"] as const) {
      const original = auth[field];
      const value = merged[field];
      if (typeof value !== "string") continue;
      if (isOpenEnvelope(original)) {
        const envelope = parseEnvelope(original)!;
        const key =
          this.lastResolvedKey?.keyId === envelope.keyId
            ? this.lastResolvedKey.key
            : (await this.keyProvider.forKey(envelope.keyId)).key;
        sealed[field] = sealField(key, envelope.keyId, value);
      }
    }

    doc["auth"] = sealed;
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    renameSync(tmp, file);
    this.infoStates.set(file, { doc, mtime: Math.floor(statMtimeMs(file)), auth: undefined, key: undefined });
  }
}

function statMtimeMs(file: string): number {
  return statSync(file).mtimeMs;
}

/** 目录下按排序首个 *.info 文件；目录不可读或无命中时返回 undefined。 */
function firstInfoFile(dir: string): string | undefined {
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".info"))
      .sort();
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  return join(dir, files[0]!);
}

/** 单目录断言式取 *.info（保留 darwin 原报错文案）。 */
function requireInfoFile(dir: string): string {
  if (!existsSync(dir)) {
    throw new Error(`CodeBuddy/WorkBuddy auth dir not found: ${dir} — log in to the desktop app first`);
  }
  const hit = firstInfoFile(dir);
  if (!hit) throw new Error(`no *.info credential file in ${dir} — log in to the desktop app first`);
  return hit;
}

/**
 * 多目录按序探测：取首个存在且含 *.info 的目录；否则抛原风格错误
 * （有目录但都无 *.info → "no *.info …"；目录都不存在 → "auth dir not found …"，
 * 文案均保留“log in to the desktop app first”）。
 */
function probeAuthDirs(candidates: string[]): string {
  const { files, unique, existing } = collectInfoFiles(candidates);
  if (files.length > 0) return files[0]!;
  throwNoAuthFiles(unique, existing);
}

/** 按目录优先序收集全部 *.info 文件（去重），附带去重后的目录表与实际存在的目录表。 */
function collectInfoFiles(candidates: string[]): { files: string[]; unique: string[]; existing: string[] } {
  const unique = [...new Set(candidates)];
  const files: string[] = [];
  const existing: string[] = [];
  const seen = new Set<string>();
  for (const dir of unique) {
    if (!existsSync(dir)) continue;
    existing.push(dir);
    let names: string[] = [];
    try {
      names = readdirSync(dir)
        .filter((f) => f.endsWith(".info"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (seen.has(full)) continue;
      seen.add(full);
      files.push(full);
    }
  }
  return { files, unique, existing };
}

/** 无可用 .info 时抛原风格错误（目录存在但无命中 / 目录都不存在两种）。 */
function throwNoAuthFiles(unique: string[], existing: string[]): never {
  if (existing.length > 0) {
    throw new Error(`no *.info credential file in ${existing.join(", ")} — log in to the desktop app first`);
  }
  throw new Error(`CodeBuddy/WorkBuddy auth dir not found: ${unique.join(", ")} — log in to the desktop app first`);
}

/** .info 字段组装（原 decryptInfoDoc 尾部；无 JWT 硬编码，按现有行为透传）。 */
export function assembleAuth(
  auth: Record<string, unknown>,
  account: CodeBuddyAccount,
  out: Record<string, string>,
): CodeBuddyAuth {
  return {
    accessToken: out["accessToken"] ?? "",
    refreshToken: out["refreshToken"] ?? "",
    expiresAt: Number(auth["expiresAt"] ?? 0),
    domain: String(auth["domain"] ?? DEFAULT_DOMAIN),
    enterpriseId: String(account["enterpriseId"] ?? ""),
    uid: String(account["uid"] ?? ""),
  };
}
