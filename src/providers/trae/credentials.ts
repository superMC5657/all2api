import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  TRAE_APP_ID,
  TRAE_STORAGE_KEY,
  findTraeStorageEntry,
  parseTraeAuthBuffer,
  readTokenFile,
  readTraeStorageDoc,
  traeAppDataRoot,
  traeHeadersForIdentity,
  traeStorageValueToBuffer,
  type TraeDataCandidate,
  type TraeDeviceIds,
} from "../trae-cn/credentials.js";

/**
 * Trae Intl（海外版）凭据处理。
 *
 * 四版本中的 Intl 两席（win32 %APPDATA% 下 Trae/User、TRAE SOLO/User，
 * → Intl host https://api.trae.ai），探测顺序 Trae → TRAE SOLO。
 * 落盘同为 storage.json + 键 `iCubeAuthInfo://icube.cloudide`，
 * Intl（SG）系为明文 JSON（tc 信封出现时同样尝试解密，容忍混写）。
 *
 * tc 信封 KDF / 设备标识 / 头部构造复用 trae-cn 实现（单一真相源），
 * 本文件只拥有 Intl 侧的版本表、token 优先级与探测/诊断。
 *
 * 注意：首版 Intl 聊天（AES-256-GCM agent v3，ProjectEio 路径）留空，
 * 本文件只提供身份读取与诊断，见 ./client.ts。
 */

export const TRAE_INTL_API_HOST = "https://api.trae.ai";
/** SOLO 远端（core-normal.trae.ai/api/remote/v1，MVP 预留，不主动调）。 */
export const TRAE_INTL_SOLO_REMOTE = "https://core-normal.trae.ai/api/remote/v1";
/** Intl token 文件（~/.trae_token，明文单行 token）。 */
export const TRAE_TOKEN_FILE = join(homedir(), ".trae_token");

export interface TraeIntlEdition {
  edition: string;
  dir: string;
  host: string;
}

/** Intl 侧版本表（探测顺序即数组顺序：Trae → TRAE SOLO）。 */
export const TRAE_INTL_EDITIONS: TraeIntlEdition[] = [
  { edition: "Trae", dir: "Trae", host: TRAE_INTL_API_HOST },
  { edition: "TRAE SOLO", dir: "TRAE SOLO", host: TRAE_INTL_API_HOST },
];

function toIntlCandidate(e: TraeIntlEdition): TraeDataCandidate {
  const userDir = join(traeAppDataRoot(), e.dir, "User");
  return { edition: e.edition, userDir, storagePath: join(userDir, "globalStorage", "storage.json"), host: e.host };
}

export interface TraeIntlCandidateOptions {
  edition?: string;
  dataDir?: string;
}

/**
 * Intl 候选目录（按探测顺序）。
 * 显式覆盖：dataDir（config.dataDir / TRAE_DATA_DIR，视为 User 目录直接用）>
 * edition（config.edition / TRAE_EDITION，精确匹配版本名单）> 默认顺序表。
 */
export function listTraeIntlCandidates(opts?: TraeIntlCandidateOptions): TraeDataCandidate[] {
  const dataDir = opts?.dataDir?.trim() || process.env["TRAE_DATA_DIR"]?.trim();
  if (dataDir) {
    return [{ edition: "explicit", userDir: dataDir, storagePath: join(dataDir, "globalStorage", "storage.json"), host: TRAE_INTL_API_HOST }];
  }
  const edition = opts?.edition?.trim() || process.env["TRAE_EDITION"]?.trim();
  if (edition) {
    const hit = TRAE_INTL_EDITIONS.find((e) => e.edition.toLowerCase() === edition.toLowerCase() || e.dir.toLowerCase() === edition.toLowerCase());
    if (!hit) {
      throw new Error(`unknown TRAE_EDITION "${edition}" for trae — known: ${TRAE_INTL_EDITIONS.map((e) => e.edition).join(", ")}`);
    }
    return [toIntlCandidate(hit)];
  }
  return TRAE_INTL_EDITIONS.map(toIntlCandidate);
}

// 单行 token 文件读取复用 trae-cn.readTokenFile（原两处同形，此处不再自带一份）。

export interface TraeIdentity {
  token: string;
  uid: string;
  nickname: string;
  expireTime: number;
  source: "config" | "env" | "file" | "storage";
  edition: string;
  dataDir: string;
  host: string;
}

export interface TraeIdentityOptions extends TraeIntlCandidateOptions {
  apiToken?: string;
}

/**
 * token 优先级：config.apiToken > TRAE_API_TOKEN > ~/.trae_token > storage.json。
 * 不可用返回 null（脚本友好），客户端类在 null 时抛聚合错误。
 */
export function readTraeIdentity(opts?: TraeIdentityOptions): TraeIdentity | null {
  const configured = opts?.apiToken?.trim() || "";
  const envToken = process.env["TRAE_API_TOKEN"]?.trim() || "";
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
      host: TRAE_INTL_API_HOST,
    };
  }
  const fileToken = readTokenFile(TRAE_TOKEN_FILE);
  if (fileToken) {
    return { token: fileToken, uid: "", nickname: "", expireTime: 0, source: "file", edition: "explicit-token", dataDir: "", host: TRAE_INTL_API_HOST };
  }
  let candidates: TraeDataCandidate[];
  try {
    candidates = listTraeIntlCandidates(opts);
  } catch {
    return null;
  }
  for (const c of candidates) {
    try {
      if (!existsSync(c.storagePath)) continue;
      const doc = JSON.parse(readFileSync(c.storagePath, "utf8")) as Record<string, unknown>;
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

export interface TraeCredentialsOptions extends TraeIdentityOptions {
  ideVersion?: string;
  userAgent?: string;
}

export class TraeCredentials {
  constructor(private readonly opts?: TraeCredentialsOptions) {}

  candidateUserDirs(): string[] {
    return listTraeIntlCandidates(this.opts).map((c) => c.userDir);
  }

  async get(): Promise<TraeIdentity> {
    const hit = readTraeIdentity(this.opts);
    if (hit) return hit;
    const tried = (() => {
      try {
        return listTraeIntlCandidates(this.opts).map((c) => c.storagePath);
      } catch (e) {
        return [`(edition resolve failed: ${(e as Error).message})`];
      }
    })();
    throw new Error(
      `trae: no usable credential — tried: ${tried.join("; ")} (key ${TRAE_STORAGE_KEY}); ` +
        `token priority: config.apiToken > TRAE_API_TOKEN > ~/.trae_token > storage.json; ` +
        `editions: Trae → TRAE SOLO (TRAE_EDITION / TRAE_DATA_DIR 可显式覆盖) — log in to the Trae desktop IDE first`,
    );
  }

  /** 后端请求头（与 CN 同形，复用 trae-cn.traeHeadersForIdentity；Intl 聊天留空前供诊断与 ProjectEio 预留）。 */
  async headers(): Promise<Record<string, string>> {
    const identity = await this.get();
    const storageDoc = readTraeStorageDoc(identity.dataDir);
    return traeHeadersForIdentity(identity, storageDoc, this.opts);
  }
}

// ---------------------------------------------------------------------------
// 探测/诊断导出（脱敏，只含路径与元数据；解密引擎复用 trae-cn）
// ---------------------------------------------------------------------------

export interface TraeIntlCandidateProbe {
  edition: string;
  userDir: string;
  storagePath: string;
  storageExists: boolean;
  keyPresent?: boolean;
  scheme?: "tc" | "plain" | "unknown";
  decrypted: boolean;
  fields?: string[];
  error?: string;
}

export function probeTraeIntlCandidates(opts?: TraeIntlCandidateOptions): TraeIntlCandidateProbe[] {
  let candidates: TraeDataCandidate[];
  try {
    candidates = listTraeIntlCandidates(opts);
  } catch (err) {
    return [{ edition: "(resolve-failed)", userDir: "", storagePath: "", storageExists: false, decrypted: false, error: String((err as Error)?.message ?? err).slice(0, 200) }];
  }
  return candidates.map((c) => {
    const probe: TraeIntlCandidateProbe = { edition: c.edition, userDir: c.userDir, storagePath: c.storagePath, storageExists: false, decrypted: false };
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
      probe.scheme = buf.length >= 6 && buf.subarray(0, 6).equals(Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00])) ? "tc" : "plain";
      const auth = parseTraeAuthBuffer(buf);
      probe.decrypted = true;
      probe.fields = auth.fields;
      return probe;
    } catch (err) {
      probe.error = String((err as Error)?.message ?? err).slice(0, 200);
      return probe;
    }
  });
}

export { TRAE_APP_ID, TRAE_STORAGE_KEY };
export type { TraeDeviceIds };
