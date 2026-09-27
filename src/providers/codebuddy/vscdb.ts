import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CodeBuddyAuth } from "./credentials.js";

/**
 * CodeBuddy CN（VSCode 系）桌面端 vscdb 凭据源（只读）。
 *
 * 实测参数（CodeBuddy CN 4.12.0，本机验证通过）：
 * - state.vscdb 的 ItemTable 中 `planning-genie.new.accessTokencn` 的值为
 *   Node-Buffer-JSON（`{"type":"Buffer","data":[...]}`），data 以 `v11` 开头；
 * - 去 3 字节头后，以 PBKDF2-HMAC-SHA1(keyringSecret, salt='saltysalt', iter=1,
 *   dkLen=16) 为 key 做 AES-128-CBC（IV=16×0x20），PKCS7 去填充得 UTF8-JSON；
 * - keyringSecret 取自 Login 钥匙环中 label=`Chromium Safe Storage`、
 *   xdg:schema=`chrome_libsecret_os_crypt_password_v2`、application=`CodeBuddy CN` 的项，
 *   链路顺序 python3+secretstorage → python3+dbus 直调 → gdbus CLI → secret-tool
 *  （单链路 8s、整链 25s，任一命中即停）。
 *
 * v1 只读：从不写 SQLite（IDE 可能持锁）；refresh = 内存重读。
 */

export const DEFAULT_VSCDB_KEY = "planning-genie.new.accessTokencn";
export const DEFAULT_VSCDB_APP = "CodeBuddy CN";
/** vscdb 应用目录名默认 'CodeBuddy CN'（Linux 实测名；Win/mac 路径未实机确认，可配 vscdbDir 覆盖；不发明其他应用名）。 */
export const DEFAULT_VSCDB_DIR = "CodeBuddy CN";
export const VSCDB_OS_CRYPT_SCHEMA = "chrome_libsecret_os_crypt_password_v2";
/** 与 credentials.ts 的 DEFAULT_DOMAIN 同值（避免运行时循环导入，此处复述字面量）。 */
const VSCDB_DEFAULT_DOMAIN = "www.codebuddy.cn";

export interface VscdbSourceOptions {
  /** 显式 state.vscdb 路径（低于 CODEBUDDY_VSCDB 环境变量）。 */
  dbPath?: string;
  /** ItemTable 键名（默认 planning-genie.new.accessTokencn；以 secret:// 开头则精确匹配）。 */
  key?: string;
  /** 钥匙环 application 名（默认 CodeBuddy CN）。 */
  app?: string;
  /** vscdb 应用目录名覆盖（默认 CodeBuddy CN；仅改变平台惯例路径中的目录段）。 */
  vscdbDir?: string;
  /** 显式钥匙环口令（测试注入；提供则跳过子进程取钥匙环）。 */
  keyringSecret?: Buffer;
  /** 子进程超时毫秒：secret 链为总额度（默认 25s，单链路 8s）；sqlite 读取默认 15s。 */
  timeoutMs?: number;
}

/** 平台惯例 vscdb 路径（Linux 实测；Win/mac 未实机确认）。 */
export function defaultVscdbPath(vscdbDir?: string): string {
  const dir = vscdbDir?.trim() || DEFAULT_VSCDB_DIR;
  const tail = join(dir, "User", "globalStorage", "state.vscdb");
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), tail);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", tail);
  }
  return join(homedir(), ".config", tail);
}

/** 路径发现：显式（env CODEBUDDY_VSCDB > config vscdbPath）> 平台惯例（不编造新应用目录名）。 */
export function resolveVscdbPath(configured?: string, vscdbDir?: string): string {
  return process.env["CODEBUDDY_VSCDB"]?.trim() || configured?.trim() || defaultVscdbPath(vscdbDir);
}

// ---------- 子进程钥匙环读取（进程级缓存，只读不写） ----------

const secretCache = new Map<string, Buffer>();

/** 链路顺序：python3+secretstorage → python3+dbus → gdbus → secret-tool（任一命中即停）。 */
export const KEYRING_LINK_NAMES = ["python3+secretstorage", "python3+dbus", "gdbus", "secret-tool"] as const;
/** 单链路子进程超时 8s，整链总预算默认 25s（避免 D-Bus 无响应拖住请求）。 */
export const KEYRING_LINK_TIMEOUT_MS = 8_000;
export const KEYRING_TOTAL_TIMEOUT_MS = 25_000;

const SECRET_STORAGE_SCRIPT = `
import base64, sys
import secretstorage
app = sys.argv[1]
bus = secretstorage.dbus_init()
found = False
for coll in secretstorage.get_all_collections(bus):
    try:
        items = list(coll.get_all_items())
    except Exception:
        continue
    for item in items:
        try:
            if item.get_label() != 'Chromium Safe Storage':
                continue
            if item.get_attributes().get('application') != app:
                continue
            sys.stdout.write(base64.b64encode(item.get_secret()).decode('ascii'))
            found = True
            break
        except Exception:
            continue
    if found:
        break
sys.exit(0 if found else 3)
`;

export type VscdbExecFn = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  opts?: { encoding?: "buffer" },
) => Promise<{ stdout: string | Buffer; stderr: string }>;

function execCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  opts?: { encoding?: "buffer" },
): Promise<{ stdout: string | Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: opts?.encoding },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          const tail = String(stderr ?? "").trim().split("\n").pop() ?? "";
          reject(
            Object.assign(new Error(`${cmd} failed (${String(code)}): ${tail.slice(0, 160)}`), {
              code,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
            }),
          );
        } else {
          resolve({ stdout: (stdout ?? "") as string | Buffer, stderr: String(stderr ?? "") });
        }
      },
    );
  });
}

/** 子进程执行层（默认直调 execFile；单测可注入 mock，绝不触真钥匙环）。 */
let execImpl: VscdbExecFn = execCapture;
export function __setVscdbExecForTests(fn?: VscdbExecFn): void {
  execImpl = fn ?? execCapture;
}

async function readKeyringViaSecretStorage(app: string, timeoutMs: number): Promise<Buffer> {
  let out: { stdout: string | Buffer };
  try {
    out = await execImpl("python", ["-c", SECRET_STORAGE_SCRIPT, app], timeoutMs);
  } catch (e) {
    if ((e as { code?: unknown }).code === 3) throw new Error(`no keyring item (Chromium Safe Storage / ${app})`);
    throw e;
  }
  const secret = Buffer.from(String(out.stdout).trim(), "base64");
  if (secret.length === 0) throw new Error(`empty keyring secret (Chromium Safe Storage / ${app})`);
  return secret;
}

const DBUS_DIRECT_SCRIPT = `
import base64, sys
import dbus
app = sys.argv[1]
bus = dbus.SessionBus()
svc = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
service = dbus.Interface(svc, "org.freedesktop.Secret.Service")
sprops = dbus.Interface(svc, "org.freedesktop.DBus.Properties")
output, sess = service.OpenSession("plain", dbus.String("", variant_level=1))
found = False
for cpath in sprops.Get("org.freedesktop.Secret.Service", "Collections"):
    cobj = bus.get_object("org.freedesktop.secrets", cpath)
    cprops = dbus.Interface(cobj, "org.freedesktop.DBus.Properties")
    for ipath in cprops.Get("org.freedesktop.Secret.Collection", "Items"):
        iobj = bus.get_object("org.freedesktop.secrets", ipath)
        iprops = dbus.Interface(iobj, "org.freedesktop.DBus.Properties")
        try:
            if str(iprops.Get("org.freedesktop.Secret.Item", "Label")) != "Chromium Safe Storage":
                continue
            if str(dict(iprops.Get("org.freedesktop.Secret.Item", "Attributes")).get("application", "")) != app:
                continue
            item = dbus.Interface(iobj, "org.freedesktop.Secret.Item")
            _, _, value, _ = item.GetSecret(sess)
            sys.stdout.write(base64.b64encode(bytes(value)).decode("ascii"))
            found = True
            break
        except Exception:
            continue
    if found:
        break
sys.exit(0 if found else 3)
`;

/** 后备A：python3 + dbus-python 直调 Secret Service（secret 经 stdout 一次性 base64 输出，不落盘）。 */
async function readKeyringViaDbus(app: string, timeoutMs: number): Promise<Buffer> {
  let out: { stdout: string | Buffer };
  try {
    out = await execImpl("python", ["-c", DBUS_DIRECT_SCRIPT, app], timeoutMs);
  } catch (e) {
    if ((e as { code?: unknown }).code === 3) throw new Error(`no keyring item (Chromium Safe Storage / ${app})`);
    throw e;
  }
  const secret = Buffer.from(String(out.stdout).trim(), "base64");
  if (secret.length === 0) throw new Error(`empty keyring secret (Chromium Safe Storage / ${app})`);
  return secret;
}

/** 后备B：gdbus CLI 走同一 D-Bus 路径（无 python 依赖时），输出解析全在内存。 */
async function readKeyringViaGdbus(app: string, timeoutMs: number): Promise<Buffer> {
  const call = async (objectPath: string, method: string, params: string[]): Promise<string> => {
    const out = await execImpl(
      "gdbus",
      ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", objectPath, "--method", method, ...params],
      timeoutMs,
    );
    return String(out.stdout);
  };
  const session = call("/org/freedesktop/secrets", "org.freedesktop.Secret.Service.OpenSession", ["plain", "\"''\""])
    .then((s) => s.match(/(\/org\/freedesktop\/secrets\/session\/[^'")\s]+)/)?.[1])
    .then((p) => {
      if (!p) throw new Error("gdbus OpenSession: no session path");
      return p;
    });
  const sess = await session;
  const collections = [
    ...(
      await call("/org/freedesktop/secrets", "org.freedesktop.DBus.Properties.Get", [
        "org.freedesktop.Secret.Service",
        "Collections",
      ])
    ).matchAll(/objectpath '([^']+)'/g),
  ].map((m) => m[1]!);
  for (const coll of collections) {
    const items = [
      ...(await call(coll, "org.freedesktop.DBus.Properties.Get", ["org.freedesktop.Secret.Collection", "Items"])).matchAll(
        /objectpath '([^']+)'/g,
      ),
    ].map((m) => m[1]!);
    for (const item of items) {
      let label = "";
      let itemApp = "";
      try {
        const lout = await call(item, "org.freedesktop.DBus.Properties.Get", ["org.freedesktop.Secret.Item", "Label"]);
        label = lout.match(/<'((?:[^'\\]|\\.)*)'>/)?.[1] ?? "";
        const aout = await call(item, "org.freedesktop.DBus.Properties.Get", ["org.freedesktop.Secret.Item", "Attributes"]);
        itemApp = aout.match(/'application':\s*<'([^']*)'>/)?.[1] ?? "";
      } catch {
        continue;
      }
      if (label !== "Chromium Safe Storage" || itemApp !== app) continue;
      const sout = await call(item, "org.freedesktop.Secret.Item.GetSecret", [sess]);
      const groups = [...sout.matchAll(/\[byte ([^\]]+)\]/g)];
      const last = groups[groups.length - 1]?.[1];
      const bytes = (last ?? "")
        .split(",")
        .map((h) => parseInt(h.trim(), 16))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
      if (bytes.length === 0) throw new Error("gdbus GetSecret: empty payload");
      return Buffer.from(bytes);
    }
  }
  throw new Error(`no keyring item (Chromium Safe Storage / ${app})`);
}

async function readKeyringViaSecretTool(app: string, timeoutMs: number): Promise<Buffer> {
  const attempts: string[][] = [
    ["lookup", "xdg:schema", VSCDB_OS_CRYPT_SCHEMA, "application", app],
    ["lookup", "service", app, "account", app],
  ];
  for (const args of attempts) {
    try {
      const out = await execImpl("secret-tool", args, timeoutMs, { encoding: "buffer" });
      const secret = Buffer.from(out.stdout as Buffer);
      if (secret.length > 0) return secret;
    } catch {
      // 换下一组属性继续
    }
  }
  throw new Error(`no keyring item (Chromium Safe Storage / ${app})`);
}

/** 取钥匙环口令（任一链路命中即停；成功结果按 application 缓存）。 */
export async function readKeyringSecret(app: string, totalMs = KEYRING_TOTAL_TIMEOUT_MS): Promise<Buffer> {
  const cached = secretCache.get(app);
  if (cached) return cached;
  const budget = Math.max(1_000, Math.min(totalMs, KEYRING_TOTAL_TIMEOUT_MS));
  const deadline = Date.now() + budget;
  const links: Array<{ name: (typeof KEYRING_LINK_NAMES)[number]; run: (linkMs: number) => Promise<Buffer> }> = [
    { name: "python3+secretstorage", run: (ms) => readKeyringViaSecretStorage(app, ms) },
    { name: "python3+dbus", run: (ms) => readKeyringViaDbus(app, ms) },
    { name: "gdbus", run: (ms) => readKeyringViaGdbus(app, ms) },
    { name: "secret-tool", run: (ms) => readKeyringViaSecretTool(app, ms) },
  ];
  const tried: string[] = [];
  const reasons: string[] = [];
  for (const link of links) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    tried.push(link.name);
    try {
      const secret = await link.run(Math.min(KEYRING_LINK_TIMEOUT_MS, remaining));
      if (secret.length === 0) throw new Error("empty secret");
      secretCache.set(app, secret);
      return secret;
    } catch (e) {
      reasons.push(`${link.name}: ${(e as Error).message}`.slice(0, 200));
    }
  }
  throw new Error(
    `keyring secret for ${app} unavailable (tried: ${tried.join(", ")} — ${reasons.join("; ")}) — unlock the Login keyring / log in to the desktop app first`,
  );
}

// ---------- vscdb 读取（sqlite 只读） ----------

const READ_SCRIPT = `
import sqlite3, sys
from urllib.parse import quote
db, want = sys.argv[1], sys.argv[2]
con = sqlite3.connect("file:" + quote(db) + "?mode=ro", uri=True)
try:
    rows = con.execute("SELECT key, value FROM ItemTable").fetchall()
finally:
    con.close()
hit = None
for k, v in rows:
    if k == want:
        hit = v
        break
if hit is None and not want.startswith("secret://"):
    needle = '"key":"' + want + '"'
    for k, v in rows:
        if needle in k:
            hit = v
            break
if hit is None:
    sys.stderr.write("VSCDB_KEY_NOT_FOUND\\n")
    sys.exit(3)
sys.stdout.write(hit if isinstance(hit, str) else hit.decode("utf-8", "replace"))
`;

/** 读 ItemTable 原始值文本（python3 子进程，sqlite 只读 URI）。 */
export async function readVscdbValue(dbPath: string, key: string, timeoutMs = 15_000): Promise<string> {
  try {
    const out = await execImpl("python", ["-c", READ_SCRIPT, dbPath, key], timeoutMs);
    return String(out.stdout).replace(/\n$/, "");
  } catch (e) {
    if ((e as { code?: unknown }).code === 3) throw new Error(`vscdb key ${key} not found in ${dbPath}`);
    throw new Error(`vscdb read failed (${dbPath}): ${(e as Error).message} — requires python`);
  }
}

/** Node-Buffer-JSON → bytes（严格校验形状）。 */
export function parseVscdbValue(raw: string, dbPath: string, key: string): Buffer {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error(`vscdb value for ${key} is not JSON (${dbPath})`);
  }
  if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
    const d = doc as Record<string, unknown>;
    if (
      d["type"] === "Buffer" &&
      Array.isArray(d["data"]) &&
      (d["data"] as unknown[]).every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      return Buffer.from(d["data"] as number[]);
    }
  }
  throw new Error(`vscdb value for ${key} is not Node-Buffer-JSON (${dbPath})`);
}

/** 去 v11 头 → PBKDF2 口令钥 → AES-128-CBC → PKCS7 → UTF8-JSON 对象。 */
export function decryptVscdbBlob(blob: Buffer, secret: Buffer): Record<string, unknown> {
  if (blob.length < 4 || blob[0] !== 0x76 || blob[1] !== 0x31 || blob[2] !== 0x31) {
    throw new Error("vscdb blob missing v11 prefix — unexpected os_crypt version");
  }
  const key = pbkdf2Sync(secret, "saltysalt", 1, 16, "sha1");
  let padded: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    decipher.setAutoPadding(false); // PKCS7 由本函数显式校验（保持与实测一致的错误语义）
    padded = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  } catch {
    throw new Error("vscdb AES-128-CBC open failed — wrong keyring secret or corrupted blob");
  }
  if (padded.length === 0) throw new Error("vscdb AES-128-CBC open failed — wrong keyring secret or corrupted blob");
  const pad = padded[padded.length - 1]!;
  if (pad < 1 || pad > 16 || padded.length < pad || !padded.subarray(padded.length - pad).every((b) => b === pad)) {
    throw new Error("vscdb PKCS7 unpad failed — wrong keyring secret or corrupted blob");
  }
  let doc: unknown;
  try {
    doc = JSON.parse(padded.subarray(0, padded.length - pad).toString("utf8"));
  } catch {
    throw new Error("vscdb plaintext is not UTF8-JSON — wrong keyring secret or unexpected shape");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("vscdb plaintext JSON is not an object");
  }
  return doc as Record<string, unknown>;
}

// ---------- 字段映射（运行时校验，不硬编码） ----------

/**
 * vscdb 明文对象 → CodeBuddyAuth，校验规则：
 * - Bearer：accessToken 为 eyJ…JWT 形则用，否则回退 token 字段（非空字符串）；
 *   两者皆不可用即抛；
 * - uid：account.uid，缺省 ''；account 非对象、uid 非字符串即抛；
 * - domain：缺省/空 → 'www.codebuddy.cn'；非字符串即抛；
 * - expiresAt：须为数字（数字字符串可转）；否则抛；
 * - refreshToken：须为字符串，照传；
 * - enterpriseId：account.enterpriseId 为字符串则取，否则 ''。
 */
export function mapVscdbAuth(doc: Record<string, unknown>): CodeBuddyAuth {
  const fail = (what: string): never => {
    throw new Error(`vscdb auth invalid: ${what}`);
  };
  const at = doc["accessToken"];
  let accessToken: string | undefined;
  if (typeof at === "string" && at.startsWith("eyJ") && at.length > 16) accessToken = at;
  if (!accessToken) {
    const tk: unknown = doc["token"];
    if (typeof tk !== "string" || tk.length === 0) {
      fail("neither accessToken (eyJ…) nor token fallback is a usable string");
    }
    accessToken = tk as string;
  }
  let uid = "";
  let enterpriseId = "";
  const account: unknown = doc["account"];
  if (account !== undefined) {
    if (typeof account !== "object" || account === null || Array.isArray(account)) fail("account is not an object");
    const a = account as Record<string, unknown>;
    const uidRaw: unknown = a["uid"];
    if (uidRaw !== undefined) {
      if (typeof uidRaw !== "string") fail("account.uid is not a string");
      uid = uidRaw as string;
    }
    const entRaw: unknown = a["enterpriseId"];
    if (entRaw !== undefined) {
      if (typeof entRaw !== "string") fail("account.enterpriseId is not a string");
      enterpriseId = entRaw as string;
    }
  }
  const domainRaw: unknown = doc["domain"];
  const domain: unknown = domainRaw === undefined || domainRaw === "" ? VSCDB_DEFAULT_DOMAIN : domainRaw;
  if (typeof domain !== "string") fail("domain is not a string");
  const expRaw: unknown = doc["expiresAt"];
  let expiresAt = 0;
  let expOk = false;
  if (typeof expRaw === "number" && Number.isFinite(expRaw)) {
    expiresAt = expRaw;
    expOk = true;
  } else if (typeof expRaw === "string" && expRaw.trim() !== "" && Number.isFinite(Number(expRaw))) {
    expiresAt = Number(expRaw);
    expOk = true;
  }
  if (!expOk) fail("expiresAt is not a number");
  const refreshToken: unknown = doc["refreshToken"];
  if (typeof refreshToken !== "string") fail("refreshToken is not a string");
  return { accessToken: accessToken as string, refreshToken: refreshToken as string, expiresAt, domain: domain as string, enterpriseId, uid };
}

/** 一站式：定位 → 取口令 → 读库 → 解密 → 映射。 */
export async function readVscdbAuth(opts: VscdbSourceOptions = {}): Promise<CodeBuddyAuth> {
  const dbPath = resolveVscdbPath(opts.dbPath, opts.vscdbDir);
  if (!existsSync(dbPath)) {
    throw new Error(
      `vscdb not found: ${dbPath} — log in to the CodeBuddy desktop app first (or set CODEBUDDY_VSCDB / vscdbPath)`,
    );
  }
  const key = opts.key?.trim() || DEFAULT_VSCDB_KEY;
  const app = opts.app?.trim() || DEFAULT_VSCDB_APP;
  const secret = opts.keyringSecret ?? (await readKeyringSecret(app, opts.timeoutMs ?? KEYRING_TOTAL_TIMEOUT_MS));
  if (secret.length === 0) throw new Error(`keyring secret for ${app} is empty`);
  const raw = await readVscdbValue(dbPath, key, opts.timeoutMs);
  return mapVscdbAuth(decryptVscdbBlob(parseVscdbValue(raw, dbPath, key), secret));
}
