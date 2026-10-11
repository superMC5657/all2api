import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Trae 共享信封 kernel（region 无关）。
 *
 * 依赖方向：`trae`（Intl）与 `trae-cn` 各自的 credentials 都依赖本 module，
 * 不再是 Intl → CN 实现引用。Region 表（版本名单/候选目录/身份优先级/
 * 网关 host）各自保留在 region credentials 内，本文件只拥有两 region
 * 同形的部分：
 *   - tc 加密信封（KDF/加解密/盐解析）
 *   - storage.json 读取（键查找/值→二进制/鉴权字段解析）
 *   - 单行 token 文件读取
 *   - 设备标识解析（local_env.json / telemetry.machineId）
 *   - 后端请求头组装
 *
 * 出处（librarian 已确认，实机前必看）：
 *   - laojichao/trae-local-api/src/trae-decrypt.js（tc 信封解密）
 *   - laojichao/trae-local-api/setup.js（EDITIONS 四版本目录表）
 *   - laojichao/trae-local-api/src/trae-client.js（token/设备字段）
 *
 * 脱敏约定（诊断与探测）：只暴露存在性、信封前缀、解密是否成功、
 * JSON 字段名、截断错误与 token 前缀+长度——绝不打印密钥、盐与完整 token。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 请求头 X-App-Id 固定值（cli2api headers.go 同值）。 */
export const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
/** storage.json 中 Trae 鉴权文档的键。 */
export const TRAE_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
/** tc 信封 6B 头：74 63 05 10 00 00（"tc" + 版本）。 */
export const TRAE_TC_MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const TC_RANDOM_LEN = 32;
const TC_HASH_LEN = 64;

// ---------------------------------------------------------------------------
// tc 信封加解密
//
// 版式：[6B头 74 63 05 10 00 00][32B随机][N密文]
// KDF：SHA512(random) → XOR盐 → SHA512 → Key16+IV16，AES-128-CBC
// 载荷：[64B SHA512(JSON)][JSON]，解密后验哈希
// ---------------------------------------------------------------------------

export interface TraeTcSalt {
  salt: Buffer;
  /** 盐来源（built-in / env），仅用于诊断，绝不含盐值。 */
  source: string;
}

/**
 * tc KDF 的固定 XOR 盐（64B，与 SHA512 输出等长）。
 *
 * 待实机核对：以 laojichao/trae-local-api/src/trae-decrypt.js 中的常量为准；
 * 当前内置值为占位实现（加解密自洽，可 round-trip），真实 storage.json
 * 解密前必须先核对替换，或经 TRAE_TC_SALT 环境变量覆盖
 *（128 hex / 64B base64 / utf8 填充三选一，见 resolveTraeTcSalt）。
 */
function builtinTraeTcSalt(): Buffer {
  return createHash("sha512").update("trae-tc-xor-salt", "utf8").digest();
}

export function resolveTraeTcSalt(): TraeTcSalt {
  const raw = process.env["TRAE_TC_SALT"]?.trim();
  if (raw) {
    if (/^[0-9a-fA-F]{128}$/.test(raw)) {
      return { salt: Buffer.from(raw, "hex"), source: "env:TRAE_TC_SALT(hex)" };
    }
    const b64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0) {
      try {
        const decoded = Buffer.from(b64, "base64");
        if (decoded.length === TC_HASH_LEN) return { salt: decoded, source: "env:TRAE_TC_SALT(base64)" };
      } catch {
        // 落空走 utf8 填充
      }
    }
    const padded = Buffer.alloc(TC_HASH_LEN, 0);
    Buffer.from(raw, "utf8").copy(padded);
    return { salt: padded, source: "env:TRAE_TC_SALT(utf8-padded)" };
  }
  return { salt: builtinTraeTcSalt(), source: "built-in placeholder (PENDING实机: trae-decrypt.js)" };
}

function xorBytes(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = ((a[i] ?? 0) ^ (b[i % b.length] ?? 0)) as number;
  }
  return out;
}

function traeTcKeyIv(random: Buffer, salt: Buffer): { key: Buffer; iv: Buffer } {
  const first = createHash("sha512").update(random).digest();
  const second = createHash("sha512").update(xorBytes(first, salt)).digest();
  return { key: second.subarray(0, 16), iv: second.subarray(16, 32) };
}

/** 解 tc 信封，返回内层 JSON 文本（验 64B SHA512，不匹配即抛）。 */
export function decryptTraeTcEnvelope(blob: Buffer): string {
  if (blob.length < TRAE_TC_MAGIC.length + TC_RANDOM_LEN + 16) {
    throw new Error(`trae tc envelope too short (len=${blob.length})`);
  }
  if (!blob.subarray(0, TRAE_TC_MAGIC.length).equals(TRAE_TC_MAGIC)) {
    throw new Error("not a trae tc envelope (bad 6B magic)");
  }
  const random = blob.subarray(TRAE_TC_MAGIC.length, TRAE_TC_MAGIC.length + TC_RANDOM_LEN);
  const ciphertext = blob.subarray(TRAE_TC_MAGIC.length + TC_RANDOM_LEN);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error(`trae tc ciphertext length invalid (len=${ciphertext.length})`);
  }
  const { salt, source } = resolveTraeTcSalt();
  const { key, iv } = traeTcKeyIv(random, salt);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(`trae tc AES-128-CBC decrypt failed (salt:${source}) — 盐不对或文件损坏，先核对 trae-decrypt.js 常量`);
  }
  if (plain.length < TC_HASH_LEN + 1) {
    throw new Error("trae tc payload too short (no room for 64B hash + JSON)");
  }
  const digest = plain.subarray(0, TC_HASH_LEN);
  const body = plain.subarray(TC_HASH_LEN);
  const expect = createHash("sha512").update(body).digest();
  if (digest.length !== expect.length || !timingSafeEqual(digest, expect)) {
    throw new Error(`trae tc payload SHA512 mismatch (salt:${source}) — 盐不对或文件损坏`);
  }
  return body.toString("utf8");
}

/** 封 tc 信封（仅自检 round-trip 用，生产路径只解密不加密）。 */
export function encryptTraeTcEnvelope(jsonText: string, random?: Buffer): Buffer {
  const rnd = random ?? randomBytes(TC_RANDOM_LEN);
  const body = Buffer.from(jsonText, "utf8");
  const plain = Buffer.concat([createHash("sha512").update(body).digest(), body]);
  const { salt } = resolveTraeTcSalt();
  const { key, iv } = traeTcKeyIv(rnd, salt);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([TRAE_TC_MAGIC, rnd, cipher.update(plain), cipher.final()]);
}

// ---------------------------------------------------------------------------
// storage.json 读取
// ---------------------------------------------------------------------------

export interface TraeDataCandidate {
  edition: string;
  /** Edition 下的 User 目录（storage.json 在其 globalStorage 子目录）。 */
  userDir: string;
  storagePath: string;
  host: string;
}

/** %APPDATA%（win32）或 ~/.config（其他平台 best-effort）。 */
export function traeAppDataRoot(): string {
  if (process.platform === "win32") {
    return process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
}

/** storage.json 内按多形状找键（顶层 / values 下，兼容 VSCode 系落盘差异）。 */
export function findTraeStorageEntry(doc: Record<string, unknown>, key: string): unknown {
  if (key in doc) return doc[key];
  const values = doc["values"];
  if (typeof values === "object" && values !== null && !Array.isArray(values)) {
    const rec = values as Record<string, unknown>;
    if (key in rec) return rec[key];
  }
  return undefined;
}

/**
 * storage 值 → 二进制：
 * - string：base64（含 url 变体）/ hex 解出 tc 信封即用；`{` 开头按明文 JSON；
 * - {type:"Buffer",data:[...]} / {value: ...} 递归解包；
 * - 自带 token 字段的对象即为明文鉴权文档。
 */
export function traeStorageValueToBuffer(value: unknown): Buffer | null {
  if (typeof value === "string") {
    const s = value.trim();
    const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0 && b64.length >= 8) {
      try {
        const decoded = Buffer.from(b64, "base64");
        if (decoded.length >= TRAE_TC_MAGIC.length + TC_RANDOM_LEN && decoded.subarray(0, TRAE_TC_MAGIC.length).equals(TRAE_TC_MAGIC)) {
          return decoded;
        }
        const text = decoded.toString("utf8");
        if (text.trimStart().startsWith("{")) return Buffer.from(text, "utf8");
      } catch {
        // 继续试其他形状
      }
    }
    const hexed = s.startsWith("0x") ? s.slice(2) : s;
    if (/^[0-9a-fA-F]+$/.test(hexed) && hexed.length % 2 === 0 && hexed.length >= (TRAE_TC_MAGIC.length + TC_RANDOM_LEN) * 2) {
      try {
        const decoded = Buffer.from(hexed, "hex");
        if (decoded.subarray(0, TRAE_TC_MAGIC.length).equals(TRAE_TC_MAGIC)) return decoded;
      } catch {
        // 继续试其他形状
      }
    }
    if (s.startsWith("{")) return Buffer.from(s, "utf8");
    return null;
  }
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if (rec["type"] === "Buffer" && Array.isArray(rec["data"])) {
      return Buffer.from(rec["data"] as number[]);
    }
    if ("value" in rec) {
      const inner = traeStorageValueToBuffer(rec["value"]);
      if (inner) return inner;
    }
    if (typeof rec["token"] === "string") return Buffer.from(JSON.stringify(value), "utf8");
  }
  return null;
}

export interface TraeAuthFields {
  token: string;
  uid: string;
  nickname: string;
  expireTime: number;
  /** "tc" = 信封解密；"plain" = 明文 JSON（Intl/SG 系常态，CN 侧容忍）。 */
  scheme: "tc" | "plain";
  /** 解出 JSON 的顶层字段名（诊断用，不含值）。 */
  fields: string[];
}

function strField(doc: Record<string, unknown>, names: string[]): string {
  for (const n of names) {
    const v = doc[n];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function numField(doc: Record<string, unknown>, names: string[]): number {
  for (const n of names) {
    const v = doc[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v) {
      const asNum = Number(v);
      if (Number.isFinite(asNum) && asNum > 0) return asNum;
      const asDate = Date.parse(v);
      if (Number.isFinite(asDate)) return asDate;
    }
  }
  return 0;
}

/** 二进制（tc 信封或明文 JSON）→ 鉴权字段（字段名多候选容忍，缺 token 即抛）。 */
export function parseTraeAuthBuffer(buf: Buffer): TraeAuthFields {
  let text: string;
  let scheme: "tc" | "plain";
  if (buf.length >= TRAE_TC_MAGIC.length + TC_RANDOM_LEN && buf.subarray(0, TRAE_TC_MAGIC.length).equals(TRAE_TC_MAGIC)) {
    text = decryptTraeTcEnvelope(buf);
    scheme = "tc";
  } else {
    text = buf.toString("utf8");
    scheme = "plain";
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`trae auth JSON parse failed (scheme=${scheme}, len=${text.length})`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error(`trae auth JSON is not an object (scheme=${scheme})`);
  }
  const userObj = typeof doc["user"] === "object" && doc["user"] !== null && !Array.isArray(doc["user"]) ? (doc["user"] as Record<string, unknown>) : {};
  const token = strField(doc, ["token", "jwt", "accessToken", "cloudIdeToken", "cloudideToken", "idToken", "apiToken"]);
  if (!token) {
    throw new Error(`trae auth has no token field (scheme=${scheme}, fields=${Object.keys(doc).join(",")})`);
  }
  return {
    token,
    uid: strField(doc, ["uid", "userId", "user_id", "id"]) || strField(userObj, ["uid", "userId", "user_id", "id"]),
    nickname: strField(doc, ["nickname", "nickName", "name", "userName"]) || strField(userObj, ["nickname", "nickName", "name"]),
    expireTime: numField(doc, ["expireTime", "expiresAt", "expire", "exp"]),
    scheme,
    fields: Object.keys(doc),
  };
}

// ---------------------------------------------------------------------------
// token 文件：明文单行 token（trae / trae-cn 共用）
// ---------------------------------------------------------------------------

/** 明文单行 token 文件读取（缺失/空/坏文件返回 null）。 */
export function readTokenFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 设备标识：local_env.json / storage.json telemetry.machineId
// ---------------------------------------------------------------------------

export interface TraeDeviceIds {
  deviceId: string;
  machineId: string;
  ideVersion: string;
}

export interface TraeDeviceResolveOptions {
  userDir?: string;
  storageDoc?: Record<string, unknown>;
  /**
   * 回退扫描的 User 目录（region 侧按各自候选表提供；仅 userDir 缺省时用）。
   * 内核自身不拥有任何 region 候选表——调用方不传且 userDir 缺省时只读环境变量。
   */
  fallbackUserDirs?: string[];
}

function fillFromLocalEnv(doc: Record<string, unknown>, out: { deviceId: string; machineId: string; ideVersion: string }): void {
  if (!out.deviceId) out.deviceId = strField(doc, ["deviceId", "device_id", "deviceid", "devId"]);
  if (!out.machineId) out.machineId = strField(doc, ["machineId", "machine_id", "machineid"]);
  if (!out.ideVersion) out.ideVersion = strField(doc, ["version", "ideVersion", "ide_version", "appVersion"]);
}

export function resolveTraeDeviceIds(opts?: TraeDeviceResolveOptions): TraeDeviceIds {
  const out = {
    deviceId: process.env["TRAE_DEVICE_ID"]?.trim() ?? "",
    machineId: process.env["TRAE_MACHINE_ID"]?.trim() ?? "",
    ideVersion: process.env["TRAE_IDE_VERSION"]?.trim() ?? "",
  };
  const dirs: string[] = [];
  if (opts?.userDir) {
    dirs.push(opts.userDir, dirname(opts.userDir));
  } else if (opts?.fallbackUserDirs) {
    for (const d of opts.fallbackUserDirs) {
      dirs.push(d, dirname(d));
    }
  }
  for (const dir of [...new Set(dirs)]) {
    if (out.deviceId && out.machineId && out.ideVersion) break;
    const file = join(dir, "local_env.json");
    try {
      if (!existsSync(file)) continue;
      const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) fillFromLocalEnv(doc, out);
    } catch {
      // 坏文件跳过
    }
  }
  if ((!out.machineId || !out.deviceId) && opts?.storageDoc) {
    const tele = findTraeStorageEntry(opts.storageDoc, "telemetry.machineId");
    if (typeof tele === "string" && tele) {
      if (!out.machineId) out.machineId = tele;
    } else if (typeof tele === "object" && tele !== null && !Array.isArray(tele)) {
      const rec = tele as Record<string, unknown>;
      if (!out.machineId && typeof rec["value"] === "string" && rec["value"]) out.machineId = rec["value"];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 后端请求头（CN/Intl 同形）
// ---------------------------------------------------------------------------

/** 头部构造（键名小写，fetch 会归一化）。 */
export function buildTraeHeaders(identity: { token: string; uid: string }, device: TraeDeviceIds, userAgent: string, ideVersion: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Cloud-IDE-JWT ${identity.token}`,
    "x-cloudide-token": identity.token,
    "x-ide-token": identity.token,
    "x-app-id": TRAE_APP_ID,
    "x-ide-version": ideVersion,
    "user-agent": userAgent,
  };
  if (identity.uid) headers["x-uid"] = identity.uid;
  if (device.deviceId) headers["x-device-id"] = device.deviceId;
  if (device.machineId) headers["x-machine-id"] = device.machineId;
  return headers;
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Trae storage not found: ${path} — log in to the Trae desktop IDE first`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** User 目录下 storage.json 尽力读取（缺失/坏文件返回 undefined；CN/Intl 同形）。 */
export function readTraeStorageDoc(dataDir: string): Record<string, unknown> | undefined {
  if (!dataDir) return undefined;
  try {
    return readJsonFile(join(dataDir, "globalStorage", "storage.json"));
  } catch {
    return undefined;
  }
}

export interface TraeHeaderOpts {
  ideVersion?: string;
  userAgent?: string;
  /** 设备回退扫描目录（region 候选表；仅 identity.dataDir 缺省时用）。 */
  fallbackUserDirs?: string[];
}

/**
 * 身份 + storageDoc → 后端请求头
 *（device/machine/版本号尽力而为，缺失则省略对应头）。
 */
export function traeHeadersForIdentity(
  identity: { token: string; uid: string; dataDir: string },
  storageDoc: Record<string, unknown> | undefined,
  opts?: TraeHeaderOpts,
): Record<string, string> {
  const device = resolveTraeDeviceIds({ userDir: identity.dataDir || undefined, storageDoc, fallbackUserDirs: opts?.fallbackUserDirs });
  const ideVersion = opts?.ideVersion?.trim() || process.env["TRAE_IDE_VERSION"]?.trim() || device.ideVersion || "unknown";
  const userAgent = opts?.userAgent?.trim() || `Trae/${ideVersion}`;
  return buildTraeHeaders(identity, device, userAgent, ideVersion);
}
