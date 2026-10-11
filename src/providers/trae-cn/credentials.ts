import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  TRAE_STORAGE_KEY,
  TRAE_TC_MAGIC,
  findTraeStorageEntry,
  parseTraeAuthBuffer,
  readTokenFile,
  readTraeStorageDoc,
  resolveTraeDeviceIds as resolveTraeDeviceIdsKernel,
  traeAppDataRoot,
  traeHeadersForIdentity as traeHeadersForIdentityKernel,
  traeStorageValueToBuffer,
  type TraeDeviceIds,
  type TraeDataCandidate,
  type TraeHeaderOpts,
} from "../trae/kernel.js";

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
 * tc 信封 / storage 解析 / 设备标识 / 头部构造等 region 无关能力收拢在
 * `../trae/kernel.js`（两 region → kernel），本文件只拥有 CN 侧的
 * 版本表、token 优先级、身份读取与凭据类。
 *
 * 脱敏约定（诊断与探测）：只暴露存在性、信封前缀、解密是否成功、
 * JSON 字段名、截断错误与 token 前缀+长度——绝不打印密钥、盐与完整 token。
 */

// ---------------------------------------------------------------------------
// 共享 kernel 兼容 re-export（历史上下游从本文件引用，保持可用）
// ---------------------------------------------------------------------------

export {
  TRAE_APP_ID,
  TRAE_STORAGE_KEY,
  TRAE_TC_MAGIC,
  buildTraeHeaders,
  decryptTraeTcEnvelope,
  encryptTraeTcEnvelope,
  findTraeStorageEntry,
  parseTraeAuthBuffer,
  readTokenFile,
  readTraeStorageDoc,
  resolveTraeTcSalt,
  traeAppDataRoot,
  traeStorageValueToBuffer,
} from "../trae/kernel.js";
export type { TraeAuthFields, TraeDataCandidate, TraeDeviceIds, TraeHeaderOpts, TraeTcSalt } from "../trae/kernel.js";

// ---------------------------------------------------------------------------
// 常量（CN 专属）
// ---------------------------------------------------------------------------

/** CN Agent 网关（llm_utils_chat 聊天入口所在 host）。 */
export const TRAE_CN_AGENT_HOST = "https://trae-api-cn.mchost.guru";
/** CN 用户增长/模型网关（get_detail_param 模型表所在 host，MVP 预留）。 */
export const TRAE_CN_UG_HOST = "https://api.trae.cn";
/** CN OAuth 网关（MVP 预留，不主动调）。 */
export const TRAE_CN_OAUTH_HOST = "https://api.trae.com.cn";
/** 轻聊天入口路径（明文 JSON，function=solo_work_lite）。 */
export const TRAE_CN_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
/** CN token 文件（~/.trae_cn_token，明文单行 token）。 */
export const TRAE_CN_TOKEN_FILE = join(homedir(), ".trae_cn_token");

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
// CN 候选目录
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// token 优先级：config.apiToken > TRAE_CN_API_TOKEN > ~/.trae_cn_token > storage.json
// ---------------------------------------------------------------------------

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
// 设备标识 / 头部构造（kernel 能力 + CN 候选表回退）
// ---------------------------------------------------------------------------

/**
 * 设备标识解析（回退语义保持原样：userDir 缺省时扫描 CN 候选表）。
 * 内核只认显式 fallbackUserDirs，CN 侧在此注入自家候选目录。
 */
export function resolveTraeDeviceIds(opts?: { userDir?: string; storageDoc?: Record<string, unknown>; fallbackUserDirs?: string[] }): TraeDeviceIds {
  if (opts?.userDir || opts?.fallbackUserDirs) return resolveTraeDeviceIdsKernel(opts);
  return resolveTraeDeviceIdsKernel({ ...opts, fallbackUserDirs: listTraeCnCandidates().map((c) => c.userDir) });
}

/**
 * 身份 + storageDoc → 后端请求头（device/machine/版本号尽力而为，缺失则省略对应头；
 * dataDir 缺省时设备回退扫描 CN 候选表，保持原语义）。
 */
export function traeHeadersForIdentity(
  identity: { token: string; uid: string; dataDir: string },
  storageDoc: Record<string, unknown> | undefined,
  opts?: TraeHeaderOpts,
): Record<string, string> {
  if (identity.dataDir || opts?.fallbackUserDirs) return traeHeadersForIdentityKernel(identity, storageDoc, opts);
  return traeHeadersForIdentityKernel(identity, storageDoc, { ...opts, fallbackUserDirs: listTraeCnCandidates().map((c) => c.userDir) });
}

// ---------------------------------------------------------------------------
// 凭据类（客户端用：get + headers，storage 来源按 mtime 缓存）
// ---------------------------------------------------------------------------

export interface TraeCnCredentialsOptions extends TraeCnIdentityOptions {
  ideVersion?: string;
  userAgent?: string;
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

  /** 后端请求头（device/machine/id 版本号尽力而为，缺失则省略对应头；与 Intl 同形，见 kernel.traeHeadersForIdentity）。 */
  async headers(): Promise<Record<string, string>> {
    const identity = await this.get();
    const storageDoc = readTraeStorageDoc(identity.dataDir);
    return traeHeadersForIdentity(identity, storageDoc, this.opts);
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
