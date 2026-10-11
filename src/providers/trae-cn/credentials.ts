import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Trae CN（国内版）凭据处理。
 *
 * 与 codebuddy（Electron helper 取 at-rest key）/ qoder（DPAPI/gnome-keyring +
 * OSCrypt 信封）都不同：Trae 走 `%APPDATA%/<Edition>/User/globalStorage/storage.json`
 * 直读，键为 `iCubeAuthInfo://icube.cloudide`；CN 系为自研 tc 加密信封，
 * Intl（SG）系为明文 JSON。
 *
 * 出处（librarian 已确认，实机前必看）：
 *   - laojichao/trae-local-api/src/trae-decrypt.js（tc 信封解密）
 *   - laojichao/trae-local-api/setup.js（EDITIONS 四版本目录表）
 *   - laojichao/trae-local-api/src/trae-client.js（token/设备字段）
 *
 * 网关（CN）：
 *   - AgentHost = https://trae-api-cn.mchost.guru（chat: llm_utils_chat）
 *   - UgHost    = https://api.trae.cn
 *   - OAuthHost = https://api.trae.com.cn
 *
 * 脱敏约定（诊断与探测）：只暴露存在性、信封前缀、解密是否成功、
 * JSON 字段名、截断错误与 token 前缀+长度——绝不打印密钥、盐与完整 token。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** CN Agent 网关（llm_utils_chat 聊天入口所在 host）。 */
export const TRAE_CN_AGENT_HOST = "https://trae-api-cn.mchost.guru";
/** CN 用户增长/模型网关（get_detail_param 模型表所在 host，MVP 预留）。 */
export const TRAE_CN_UG_HOST = "https://api.trae.cn";
/** CN OAuth 网关（MVP 预留，不主动调）。 */
export const TRAE_CN_OAUTH_HOST = "https://api.trae.com.cn";
/** 轻聊天入口路径（明文 JSON，function=solo_work_lite）。 */
export const TRAE_CN_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
/** 请求头 X-App-Id 固定值（cli2api headers.go 同值）。 */
export const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
/** storage.json 中 Trae 鉴权文档的键。 */
export const TRAE_STORAGE_KEY = "iCubeAuthInfo://icube.cloudide";
/** CN token 文件（~/.trae_cn_token，明文单行 token）。 */
export const TRAE_CN_TOKEN_FILE = join(homedir(), ".trae_cn_token");

/** tc 信封 6B 头：74 63 05 10 00 00（"tc" + 版本）。 */
export const TRAE_TC_MAGIC = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const TC_RANDOM_LEN = 32;
const TC_HASH_LEN = 64;

/** CN 侧版本表（探测顺序即数组顺序：TRAE SOLO CN → Trae CN）。 */
export interface TraeEdition {
  edition: string;
  /** %APPDATA% 下的目录名。 */
  dir: string;
  /** 该版本归属的 UgHost。 */
  host: string;
}

export const TRAE_CN_EDITIONS: TraeEdition[] = [
  { edition: "TRAE SOLO CN", dir: "TRAE SOLO CN", host: TRAE_CN_UG_HOST },
  { edition: "Trae CN", dir: "Trae CN", host: TRAE_CN_UG_HOST },
];

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

function toCandidate(e: TraeEdition): TraeDataCandidate {
  const userDir = join(traeAppDataRoot(), e.dir, "User");
  return { edition: e.edition, userDir, storagePath: join(userDir, "globalStorage", "storage.json"), host: e.host };
}

export interface TraeCandidateOptions {
  edition?: string;
  dataDir?: string;
}

/**
 * CN 候选目录（按探测顺序）。
 * 显式覆盖：dataDir（config.dataDir / TRAE_CN_DATA_DIR，视为 User 目录直接用）>
 * edition（config.edition / TRAE_EDITION，精确匹配版本名单）> 默认顺序表。
 */
export function listTraeCnCandidates(opts?: TraeCandidateOptions): TraeDataCandidate[] {
  const dataDir = opts?.dataDir?.trim() || process.env["TRAE_CN_DATA_DIR"]?.trim();
  if (dataDir) {
    return [{ edition: "explicit", userDir: dataDir, storagePath: join(dataDir, "globalStorage", "storage.json"), host: TRAE_CN_UG_HOST }];
  }
  const edition = opts?.edition?.trim() || process.env["TRAE_EDITION"]?.trim();
  if (edition) {
    const hit = TRAE_CN_EDITIONS.find((e) => e.edition.toLowerCase() === edition.toLowerCase() || e.dir.toLowerCase() === edition.toLowerCase());
    if (!hit) {
      throw new Error(`unknown TRAE_EDITION "${edition}" for trae-cn — known: ${TRAE_CN_EDITIONS.map((e) => e.edition).join(", ")}`);
    }
    return [toCandidate(hit)];
  }
  return TRAE_CN_EDITIONS.map(toCandidate);
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new Error(`Trae storage not found: ${path} — log in to the Trae desktop IDE first`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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
// token 优先级：config.apiToken > TRAE_CN_API_TOKEN > ~/.trae_cn_token > storage.json
// ---------------------------------------------------------------------------

function readTokenFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export interface TraeCnIdentity {
  token: string;
  uid: string;
  nickname: string;
  expireTime: number;
  source: "config" | "env" | "file" | "storage";
  /** 版本标签（storage 来源）或 explicit-token（裸 token 来源）。 */
  edition: string;
  /** User 目录（裸 token 来源时为空）。 */
  dataDir: string;
  host: string;
}

export interface TraeCnIdentityOptions extends TraeCandidateOptions {
  apiToken?: string;
}

/** 读 CN 身份；不可用返回 null（脚本友好），客户端类在 null 时抛聚合错误。 */
export function readTraeCnIdentity(opts?: TraeCnIdentityOptions): TraeCnIdentity | null {
  const configured = opts?.apiToken?.trim() || "";
  const envToken = process.env["TRAE_CN_API_TOKEN"]?.trim() || "";
  const direct = configured || envToken;
  if (direct) {
    return {
      token: direct,
      uid: "",
      nickname: "",
      expireTime: 0,
      source: configured ? "config" : "env",
      edition: "explicit-token",
      dataDir: "",
      host: TRAE_CN_UG_HOST,
    };
  }
  const fileToken = readTokenFile(TRAE_CN_TOKEN_FILE);
  if (fileToken) {
    return { token: fileToken, uid: "", nickname: "", expireTime: 0, source: "file", edition: "explicit-token", dataDir: "", host: TRAE_CN_UG_HOST };
  }
  let candidates: TraeDataCandidate[];
  try {
    candidates = listTraeCnCandidates(opts);
  } catch {
    return null;
  }
  for (const c of candidates) {
    try {
      const doc = readJsonFile(c.storagePath);
      const entry = findTraeStorageEntry(doc, TRAE_STORAGE_KEY);
      if (entry === undefined) continue;
      const buf = traeStorageValueToBuffer(entry);
      if (!buf) continue;
      const auth = parseTraeAuthBuffer(buf);
      return {
        token: auth.token,
        uid: auth.uid,
        nickname: auth.nickname,
        expireTime: auth.expireTime,
        source: "storage",
        edition: c.edition,
        dataDir: c.userDir,
        host: c.host,
      };
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 设备标识：local_env.json / storage.json telemetry.machineId
// ---------------------------------------------------------------------------

export interface TraeDeviceIds {
  deviceId: string;
  machineId: string;
  ideVersion: string;
}

function fillFromLocalEnv(doc: Record<string, unknown>, out: { deviceId: string; machineId: string; ideVersion: string }): void {
  if (!out.deviceId) out.deviceId = strField(doc, ["deviceId", "device_id", "deviceid", "devId"]);
  if (!out.machineId) out.machineId = strField(doc, ["machineId", "machine_id", "machineid"]);
  if (!out.ideVersion) out.ideVersion = strField(doc, ["version", "ideVersion", "ide_version", "appVersion"]);
}

export function resolveTraeDeviceIds(opts?: { userDir?: string; storageDoc?: Record<string, unknown> }): TraeDeviceIds {
  const out = {
    deviceId: process.env["TRAE_DEVICE_ID"]?.trim() ?? "",
    machineId: process.env["TRAE_MACHINE_ID"]?.trim() ?? "",
    ideVersion: process.env["TRAE_IDE_VERSION"]?.trim() ?? "",
  };
  const dirs: string[] = [];
  if (opts?.userDir) {
    dirs.push(opts.userDir, dirname(opts.userDir));
  } else {
    for (const c of listTraeCnCandidates()) {
      dirs.push(c.userDir, dirname(c.userDir));
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
// 凭据类（客户端用：get + headers，storage 来源按 mtime 缓存）
// ---------------------------------------------------------------------------

export interface TraeCnCredentialsOptions extends TraeCnIdentityOptions {
  ideVersion?: string;
  userAgent?: string;
}

/** 头部构造（CN/Intl 同形，Intl 复用；键名小写，fetch 会归一化）。 */
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

export class TraeCnCredentials {
  private cached: { storagePath: string; mtime: number; identity: TraeCnIdentity } | null = null;

  constructor(private readonly opts?: TraeCnCredentialsOptions) {}

  /** 候选 User 目录（显式覆盖独占，否则按表顺序），供诊断脚本用。 */
  candidateUserDirs(): string[] {
    return listTraeCnCandidates(this.opts).map((c) => c.userDir);
  }

  async get(): Promise<TraeCnIdentity> {
    const hit = readTraeCnIdentity(this.opts);
    if (hit) {
      if (hit.source === "storage") {
        try {
          const st = readJsonFileMtime(hit.dataDir);
          if (this.cached && this.cached.storagePath === st.path && this.cached.mtime === st.mtime) {
            return this.cached.identity;
          }
          this.cached = { storagePath: st.path, mtime: st.mtime, identity: hit };
        } catch {
          // mtime 读不到就不缓存
        }
      }
      return hit;
    }
    const tried = (() => {
      try {
        return listTraeCnCandidates(this.opts).map((c) => c.storagePath);
      } catch (e) {
        return [`(edition resolve failed: ${(e as Error).message})`];
      }
    })();
    throw new Error(
      `trae-cn: no usable credential — tried: ${tried.join("; ")} (key ${TRAE_STORAGE_KEY}); ` +
        `token priority: config.apiToken > TRAE_CN_API_TOKEN > ~/.trae_cn_token > storage.json; ` +
        `editions: TRAE SOLO CN → Trae CN (TRAE_EDITION / TRAE_CN_DATA_DIR 可显式覆盖) — log in to the Trae CN desktop IDE first`,
    );
  }

  /** 后端请求头（device/machine/id 版本号尽力而为，缺失则省略对应头）。 */
  async headers(): Promise<Record<string, string>> {
    const identity = await this.get();
    let storageDoc: Record<string, unknown> | undefined;
    if (identity.dataDir) {
      try {
        storageDoc = readJsonFile(join(identity.dataDir, "globalStorage", "storage.json"));
      } catch {
        storageDoc = undefined;
      }
    }
    const device = resolveTraeDeviceIds({ userDir: identity.dataDir || undefined, storageDoc });
    const ideVersion = this.opts?.ideVersion?.trim() || process.env["TRAE_IDE_VERSION"]?.trim() || device.ideVersion || "unknown";
    const userAgent = this.opts?.userAgent?.trim() || `Trae/${ideVersion}`;
    return buildTraeHeaders(identity, device, userAgent, ideVersion);
  }
}

function readJsonFileMtime(userDir: string): { path: string; mtime: number } {
  const path = join(userDir, "globalStorage", "storage.json");
  return { path, mtime: Math.floor(statSync(path).mtimeMs) };
}

// ---------------------------------------------------------------------------
// 探测/诊断导出（脱敏，只含路径与元数据）
// ---------------------------------------------------------------------------

export interface TraeCandidateProbe {
  edition: string;
  userDir: string;
  storagePath: string;
  storageExists: boolean;
  keyPresent?: boolean;
  /** tc = 加密信封；plain = 明文 JSON；unknown = 形状不明。 */
  scheme?: "tc" | "plain" | "unknown";
  decrypted: boolean;
  fields?: string[];
  error?: string;
}

export function truncateTraeProbeError(err: unknown, max = 200): string {
  return String((err as Error)?.message ?? err).slice(0, max);
}

export function probeTraeCnCandidates(opts?: TraeCandidateOptions): TraeCandidateProbe[] {
  let candidates: TraeDataCandidate[];
  try {
    candidates = listTraeCnCandidates(opts);
  } catch (err) {
    return [{ edition: "(resolve-failed)", userDir: "", storagePath: "", storageExists: false, decrypted: false, error: truncateTraeProbeError(err) }];
  }
  return candidates.map((c) => {
    const probe: TraeCandidateProbe = { edition: c.edition, userDir: c.userDir, storagePath: c.storagePath, storageExists: false, decrypted: false };
    try {
      if (!existsSync(c.storagePath)) return probe;
      probe.storageExists = true;
      const doc = JSON.parse(readFileSync(c.storagePath, "utf8")) as Record<string, unknown>;
      const entry = findTraeStorageEntry(doc, TRAE_STORAGE_KEY);
      probe.keyPresent = entry !== undefined;
      if (entry === undefined) {
        probe.error = `key ${TRAE_STORAGE_KEY} not present`;
        return probe;
      }
      const buf = traeStorageValueToBuffer(entry);
      if (!buf) {
        probe.scheme = "unknown";
        probe.error = "unrecognized credential value shape";
        return probe;
      }
      probe.scheme = buf.length >= TRAE_TC_MAGIC.length && buf.subarray(0, TRAE_TC_MAGIC.length).equals(TRAE_TC_MAGIC) ? "tc" : "plain";
      const auth = parseTraeAuthBuffer(buf);
      probe.decrypted = true;
      probe.fields = auth.fields;
      return probe;
    } catch (err) {
      probe.error = truncateTraeProbeError(err);
      return probe;
    }
  });
}
