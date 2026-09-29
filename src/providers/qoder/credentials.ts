import { spawnSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolvePythonBin } from "../../python.js";

/**
 * Qoder 桌面版 IDE 读取器（intl + CN）共用的 keystore 基础。
 *
 * 两种风味复用相同的 Electron/Chromium OSCrypt 信封，仅数据源不同
 *（文件路径、sqlite 键、字段映射、region）：
 *   - intl：win32 DPAPI + state.vscdb + AES-256-GCM（"v10"）；
 *          Linux 为 gnome-keyring + state.vscdb + AES-128-CBC（"v11"）
 *          的 best-effort 候选（UNVERIFIED，本机无海外版 Linux IDE 实测，
 *          仿 win32-CN 思路，见 intlLinuxEntries）
 *   - cn：Linux gnome-keyring + auth.v1.dat + AES-128-CBC（"v11"），
 *          另加尽力而为的 win32 候选探测（按文件区分 DPAPI "v10" /
 *          PBKDF2 "v11"）
 *
 * 下方的 intl/CN 来源表拥有数据源定义；本文件的共享引擎同时处理
 * 两者的探测与解密。
 *
 * 脱敏约定（诊断与探测）：仅暴露存在性、密钥字节长度、3 字节前缀、
 * JSON 字段名、截断后的错误信息以及 token 前缀与长度——绝不暴露密钥值、
 * 密钥本身或完整 token。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface QoderIdeIdentity {
  /** dt-… 访问令牌——直接作为 Bearer 向网关鉴权。 */
  token: string;
  refreshToken: string;
  uid: string;
  nickname: string;
  /** Epoch 毫秒时间戳；未知时为 0。 */
  expireTime: number;
}

/** 加密二进制的存放位置。 */
export type QoderIdeContainer = "sqlite-item" | "dat-file";
/** Chromium OSCrypt 信封：v10 → AES-256-GCM，v11 → AES-128-CBC。 */
export type QoderIdeScheme = "v10-gcm" | "v11-cbc";
/** 解密密钥 / 口令的来源。 */
export type QoderIdeKeySource = "local-state-dpapi" | "gnome-keyring" | "env-password";

/**
 * 按形状提取字段（即 "fieldMap"）：token/refresh 恒为顶层 `token` /
 * `refreshToken` 字符串；uid/nickname/expire 随风味而异
 *（intl 扁平 `id`/`name`/`expireTime`，对比 CN `user:{id,name}` +
 * `expiresAt`），因此每个表项自带提取器，引擎无需按形状分支。
 */
export interface QoderIdeFieldMap {
  uid(doc: Record<string, unknown>, user: Record<string, unknown>): string;
  nickname(doc: Record<string, unknown>, user: Record<string, unknown>): string;
  expireTime(doc: Record<string, unknown>): number;
}

/** 一个可解密数据源：引擎所需的一切，均以数据形式给出。 */
export interface QoderIdeSource {
  /** 用于调试的稳定 id（绝非密钥）。 */
  id: string;
  region: "intl" | "cn";
  platform: "win32" | "linux";
  /** 用户数据 / 配置目录：DPAPI 的 `Local State` 在此；同时也是探测根目录。 */
  root: string;
  /** 待读取的绝对路径文件（sqlite 库或 .dat）。由表构建器从 roots[] 解析得到。 */
  file: string;
  container: QoderIdeContainer;
  /** sqlite ItemTable 键（仅 sqlite-item）。 */
  itemKey?: string;
  /** 待尝试的信封（按序，auth.v1.dat 先试 v10 再试 v11）。 */
  scheme: QoderIdeScheme | QoderIdeScheme[];
  /** 密钥来源；为数组时与 scheme 一一对应。 */
  keySource: QoderIdeKeySource | QoderIdeKeySource[];
  /** DPAPI 临时文件中缀（intl 为 ""，cn 为 "-cn"）。 */
  tmpInfix?: string;
  /** v11-cbc 的口令提供器（gnome-keyring 获取器 / 环境变量覆盖）。 */
  getPassword?: () => string | null;
  fieldMap: QoderIdeFieldMap;
  /** 探测分组（state.vscdb 对 auth.v1.dat）。 */
  probeKind: "state.vscdb" | "auth.v1.dat";
}

/** 脱敏的单文件尝试记录：仅元数据，绝不含密钥材料。 */
export interface QoderIdeFileProbe {
  kind: "state.vscdb" | "auth.v1.dat";
  path: string;
  exists: boolean;
  /** 文件可读时的 3 字节前缀："v10" / "v11" / 其他。 */
  prefix?: string;
  /** sqlite 键是否存在（仅 sqlite-item）。 */
  keyPresent?: boolean;
  /** 解密后 AES 密钥的字节长度（绝非密钥本身）。 */
  keyLength?: number;
  decrypted: boolean;
  /** 解密文档的顶层 JSON 字段名（绝非字段值）。 */
  fields?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// keystore 原语
// ---------------------------------------------------------------------------

/** OSCrypt 二进制前 3 字节的文本形式（如 "v10" / "v11"）；仅元数据，绝非密钥材料。 */
export function osCryptPrefix(blob: Buffer): string {
  return blob.slice(0, 3).toString();
}

/** "v10" 负载 → AES-256-GCM（nonce 12 字节 | 密文 | tag 16 字节）。 */
export function aesGcmDecrypt(data: Buffer, key: Buffer): string {
  const nonce = data.slice(0, 12);
  const tag = data.slice(data.length - 16);
  const ct = data.slice(12, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Chromium Linux OSCrypt "v11"：PBKDF2-SHA1 密钥 + AES-128-CBC，IV 为固定空格。 */
export function aesCbcDecrypt(data: Buffer, password: string): string {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  // autoPadding（默认 true）已自动去除 PKCS#7 填充——无需手动解填充。
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * 对 `<userDataDir>/Local State` → os_crypt.encrypted_key 做 DPAPI 解包。
 * 仅以运行过该 IDE 的同一 Windows 用户身份才能打开。
 *
 * @param tmpInfix 使各调用方的临时文件名互不相同
 *  （intl "" → all2api-qkey.bin/.key，cn "-cn" → all2api-qkey-cn.bin/.key）。
 */
export function readWin32OsCryptKey(userDataDir: string, tmpInfix = ""): Buffer {
  const ls = JSON.parse(readFileSync(join(userDataDir, "Local State"), "utf8")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const wrapped = Buffer.from(ls.os_crypt?.encrypted_key ?? "", "base64");
  if (wrapped.slice(0, 5).toString() !== "DPAPI") throw new Error("unexpected os_crypt key format");

  const tmpBlob = join(process.env["TEMP"] ?? ".", `all2api-qkey${tmpInfix}.bin`);
  const tmpKey = join(process.env["TEMP"] ?? ".", `all2api-qkey${tmpInfix}.key`);
  writeFileSync(tmpBlob, wrapped.slice(5));
  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Security; ` +
          `$b=[IO.File]::ReadAllBytes('${tmpBlob}'); ` +
          `$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
          `[IO.File]::WriteAllBytes('${tmpKey}',$k)`,
      ],
      { timeout: 20_000, windowsHide: true },
    );
    if (ps.status !== 0) throw new Error("DPAPI unlock failed: " + String(ps.stderr).slice(0, 200));
    return readFileSync(tmpKey);
  } finally {
    // 临时密钥材料绝不活过本次调用
    for (const f of [tmpBlob, tmpKey]) {
      try {
        unlinkSync(f);
      } catch {
        // 尽力清理
      }
    }
  }
}

/** 脱敏的探测错误：仅消息且截断——绝不含密钥材料。 */
export function truncateProbeError(err: unknown, max = 200): string {
  return String((err as Error)?.message ?? err).slice(0, max);
}

/** 解密文档的顶层 JSON 字段名（绝非字段值）。 */
export function decryptedFieldNames(doc: Record<string, unknown>): string[] {
  return Object.keys(doc);
}

// ---------------------------------------------------------------------------
// 引擎（"按表取钥"）
//
// 从本地存储提取国际版 Qoder IDE 自身的登录身份，
// 使 all2api 无需任何交互式 token 创建即可复用桌面端登录。
//
// 数据源（归本适配器所有）：%APPDATA%/Qoder/User/globalStorage/ 下的
// state.vscdb，以 `secret://aicoding.auth.userInfo` 为键，采用
// Electron safeStorage（Chromium OSCrypt）方案加密："v10" 前缀 + AES-256-GCM，
// 其中 AES 密钥本身经 DPAPI 保护存于 `Local State` →
// os_crypt.encrypted_key。仅以运行过该 IDE 的同一 Windows 用户身份才能打开。
// 探测与解密逻辑见下方的 keystore 部分。
//
// 本文件同时拥有共享的表驱动引擎：每个适配器（intl + CN）都是一张数据表
//（QoderIdeSource 表项）加一次引擎调用。引擎是唯一存在“存在才试、失败换下
// 一个”循环的地方；观察到的五处来源差异（roots、container、scheme、密钥来源、
// 字段形状）均表达为表项数据，绝不在引擎中分支。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 数据源描述表 + 引擎（"按表取钥"）
// ---------------------------------------------------------------------------

function schemesOf(source: QoderIdeSource): QoderIdeScheme[] {
  return Array.isArray(source.scheme) ? source.scheme : [source.scheme];
}

function keySourcesOf(source: QoderIdeSource): QoderIdeKeySource[] {
  const schemes = schemesOf(source);
  const list = Array.isArray(source.keySource) ? source.keySource : [source.keySource];
  if (list.length === schemes.length) return list;
  const fallback = list[0] ?? "local-state-dpapi";
  return schemes.map((_, i) => list[Math.min(i, list.length - 1)] ?? fallback);
}

function parseWithFieldMap(
  doc: Record<string, unknown>,
  fieldMap: QoderIdeFieldMap,
): QoderIdeIdentity | null {
  const token = typeof doc["token"] === "string" ? doc["token"] : "";
  if (!token) return null;
  const user = (doc["user"] ?? {}) as Record<string, unknown>;
  return {
    token,
    refreshToken: typeof doc["refreshToken"] === "string" ? doc["refreshToken"] : "",
    uid: fieldMap.uid(doc, user),
    nickname: fieldMap.nickname(doc, user),
    expireTime: fieldMap.expireTime(doc),
  };
}

function loadPassword(source: QoderIdeSource, keySource: QoderIdeKeySource): string | null {
  if (source.getPassword) return source.getPassword();
  if (keySource === "env-password") return process.env["QODER_CN_OS_CRYPT_PASSWORD"]?.trim() || null;
  return null;
}

/**
 * 两种容器（sqlite-item + dat-file）共用的前缀 / 密钥 / 解密 / 解析循环：
 * 前缀匹配（按 scheme 顺序）→ 取密钥 → 解密 → fieldMap 解析。
 * 会修改 `probe`（prefix/keyLength/fields/decrypted/error），
 * 并返回引擎结果形状。容器只负责取二进制；所有密钥 / 解密 / 错误字符串
 * 均原文保留在此。
 */
function decryptBlobForScheme(
  blob: Buffer,
  source: QoderIdeSource,
  schemes: QoderIdeScheme[],
  keySources: QoderIdeKeySource[],
  probe: QoderIdeFileProbe,
): { probe: QoderIdeFileProbe; identity: QoderIdeIdentity | null } {
  probe.prefix = osCryptPrefix(blob);
  for (let i = 0; i < schemes.length; i++) {
    const scheme = schemes[i] ?? "v10-gcm";
    const want = scheme === "v10-gcm" ? "v10" : "v11";
    if (probe.prefix !== want) continue;
    const keySource = keySources[i] ?? "local-state-dpapi";
    if (keySource === "local-state-dpapi") {
      const key = readWin32OsCryptKey(source.root, source.tmpInfix ?? "");
      probe.keyLength = key.length;
      const plain =
        scheme === "v10-gcm" ? aesGcmDecrypt(blob.slice(3), key) : aesCbcDecrypt(blob.slice(3), key.toString("utf8"));
      const doc = JSON.parse(plain) as Record<string, unknown>;
      probe.fields = decryptedFieldNames(doc);
      probe.decrypted = true;
      return { probe, identity: parseWithFieldMap(doc, source.fieldMap) };
    }
    const password = loadPassword(source, keySource);
    if (!password) {
      probe.error =
        keySource === "env-password"
          ? "v11 needs QODER_CN_OS_CRYPT_PASSWORD on win32 (unverified — see decrypt:qoder-cn)"
          : "os_crypt password unavailable";
      return { probe, identity: null };
    }
    if (scheme === "v11-cbc") probe.keyLength = 16; // PBKDF2-SHA1("saltysalt",1) 派生 → AES-128
    const plain = aesCbcDecrypt(blob.slice(3), password);
    const doc = JSON.parse(plain) as Record<string, unknown>;
    probe.fields = decryptedFieldNames(doc);
    probe.decrypted = true;
    return { probe, identity: parseWithFieldMap(doc, source.fieldMap) };
  }
  const only = schemes.length === 1 ? (schemes[0] === "v10-gcm" ? "v10" : "v11") : null;
  probe.error = only ? `unexpected prefix ${probe.prefix} (want ${only})` : `unexpected prefix ${probe.prefix}`;
  return { probe, identity: null };
}

/**
 * 单数据源尝试：存在性 → 前缀匹配（按 scheme 顺序）→ 取密钥 →
 * 解密 → fieldMap 解析。绝不抛错；失败编码为
 * `{ probe, identity: null }`，以便引擎（及 win32 探测）继续处理下一表项。
 * 探测字符串与建表前的辅助函数保持原文一致。
 */
export function tryQoderIdeSource(source: QoderIdeSource): {
  probe: QoderIdeFileProbe;
  identity: QoderIdeIdentity | null;
} {
  const probe: QoderIdeFileProbe = {
    kind: source.probeKind,
    path: source.file,
    exists: false,
    decrypted: false,
  };
  try {
    if (!existsSync(source.file)) return { probe, identity: null };
    probe.exists = true;
    const schemes = schemesOf(source);
    const keySources = keySourcesOf(source);

    if (source.container === "sqlite-item") {
      const itemKey = source.itemKey ?? "";
      const db = new DatabaseSync(source.file, { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(itemKey) as
          | { value: string | Buffer }
          | undefined;
        if (!row) {
          probe.keyPresent = false;
          probe.error = `key ${itemKey} not present`;
          return { probe, identity: null };
        }
        probe.keyPresent = true;
        const blob = Buffer.from(JSON.parse(String(row.value)).data as number[]);
        return decryptBlobForScheme(blob, source, schemes, keySources, probe);
      } finally {
        db.close();
      }
    }

    const blob = readFileSync(source.file);
    if (blob.length < 32) {
      probe.error = "file too small";
      return { probe, identity: null };
    }
    return decryptBlobForScheme(blob, source, schemes, keySources, probe);
  } catch (err) {
    probe.error = truncateProbeError(err);
    return { probe, identity: null };
  }
}

/**
 * 表引擎（"存在才试、失败下一个"）：按序探测表项，返回首个成功的身份。
 * 每个探测过的文件都会追加到 `tried`（仅路径，绝不含内容），
 * 以便调用方一次性告警已试路径。
 */
export function runQoderIdeSources(entries: QoderIdeSource[], tried: string[] = []): QoderIdeIdentity | null {
  for (const entry of entries) {
    tried.push(entry.file);
    try {
      const { identity } = tryQoderIdeSource(entry);
      if (identity) return identity;
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// intl 表（单数据源）+ 一次引擎调用
// ---------------------------------------------------------------------------

/** state.vscdb 中保存 intl 鉴权文档的 sqlite 键。 */
const INTL_STATE_KEY = "secret://aicoding.auth.userInfo";

/** 统一 fieldMap：见下方 QODER_FIELD_MAP（覆盖 intl 扁平形与 CN user/expiresAt 形）。 */

function intlEntries(ideDataDir?: string): QoderIdeSource[] {
  const dir = ideDataDir ?? join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Qoder");
  const file = join(dir, "User", "globalStorage", "state.vscdb");
  return [
    {
      id: "intl-state.vscdb",
      region: "intl",
      platform: "win32",
      root: dir,
      file,
      container: "sqlite-item",
      itemKey: INTL_STATE_KEY,
      scheme: "v10-gcm",
      keySource: "local-state-dpapi",
      tmpInfix: "",
      fieldMap: QODER_FIELD_MAP,
      probeKind: "state.vscdb",
    },
  ];
}

/**
 * 海外版 Linux 候选表（UNVERIFIED —— 本机无海外版 Linux IDE 实测，
 * 仿 win32-CN 的 best-effort：候选根为 XDG_CONFIG_HOME / ~/.config 下的
 * Qoder（含 com.qoder.* 发现），文件固定为
 * User/globalStorage/state.vscdb，container 沿用 sqlite-item，
 * itemKey 沿用 INTL_STATE_KEY；scheme 只写 "v11-cbc"
 *（Chromium-on-Linux 默认；引擎按 prefix 匹配，v10 真出现也只会记 prefix
 * 报 miss，不会崩——probe 保留 prefix 记录以便将来按真实 blob 补 scheme）。
 */
function intlLinuxEntries(ideDataDir?: string): QoderIdeSource[] {
  const roots: string[] = [];
  if (ideDataDir) {
    roots.push(ideDataDir);
  } else {
    const configHome = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
    const push = (p?: string) => {
      if (p && !roots.includes(p)) roots.push(p);
    };
    push(join(configHome, "Qoder"));
    for (const d of discoverQoderIntlDirs(configHome)) push(d);
  }
  return roots.map((root) => ({
    id: `intl-linux-state.vscdb:${root}`,
    region: "intl",
    platform: "linux",
    root,
    file: join(root, "User", "globalStorage", "state.vscdb"),
    container: "sqlite-item",
    itemKey: INTL_STATE_KEY,
    scheme: "v11-cbc",
    keySource: "gnome-keyring",
    getPassword: osCryptIntlPassword,
    fieldMap: QODER_FIELD_MAP,
    probeKind: "state.vscdb",
  }));
}

/** 配置目录下自动发现的海外版 Qoder 目录：com.qoder* 或同时含 qoder 与 intl。缺失 / 不可读 → []（复用 CN discover 思路）。 */
function discoverQoderIntlDirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && (/com\.qoder/i.test(e.name) || (/qoder/i.test(e.name) && /intl/i.test(e.name))),
      )
      .map((e) => join(base, e.name));
  } catch {
    return [];
  }
}

export function readQoderIdeIdentity(ideDataDir?: string): QoderIdeIdentity | null {
  if (process.platform === "win32") {
    try {
      return runQoderIdeSources(intlEntries(ideDataDir));
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    try {
      return runQoderIdeSources(intlLinuxEntries(ideDataDir));
    } catch {
      return null;
    }
  }
  return null; // 基于 DPAPI/gnome-keyring；其他平台需不同密钥存储
}

// ---------------------------------------------------------------------------
// cn 表
//
// 从本地存储提取国内版（CN）Qoder IDE 自身的登录身份，
// 使 all2api 无需任何 PAT 即可复用桌面端登录。
//
// 数据源（归本适配器所有）：
// - Linux：~/.config/com.qodercn.app.stable/auth.v1.dat——
//   {"token":"dt-…","refreshToken":"drt-…","user":{…},"expiresAt":"…",…}
//   采用 Chromium-on-Linux OSCrypt 方案加密："v11" 前缀 +
//   AES-128-CBC（IV 为 16 个空格），其中 128 位密钥为用户
//   gnome-keyring 中 "Qoder CN App" 条目
//  （chrome_libsecret_os_crypt_password_v2）的
//   PBKDF2-HMAC-SHA1（口令，盐 "saltysalt"，迭代 1 次）派生。
//   仅以运行过该 IDE 的同一 Linux 用户身份才能打开
//  （登录时 keyring 自动解锁）。
// - Windows（win32，未验证——此处无 Windows 机器，见
//   scripts/qoder-cn-decrypt.ts）：仅对 Qoder 自家的
//   auth.v1.dat 做尽力而为的候选探测。cn 只读 Qoder 自家落盘；CodeBuddy 系因跨厂商不可互认，已移除。
//   国内版 IDE 在 Windows 上的确切落盘布局尚未确认，
//   因此不断言任何单一固定路径——每个候选仅在存在时尝试
//   （存在才试、失败换下一个），最终失败时一次性告警已试路径
//   （仅路径，绝不含内容）。
//   优先级：显式 authFile 参数（= 调用方配置覆盖）→
//   QODER_CN_APPDATA 环境变量 → %APPDATA%/Qoder CN →
//   %LOCALAPPDATA% 变体 → com.qodercn.app.* 目录。每个候选仅尝试
//   auth.v1.dat：v10 前缀 → DPAPI（同级 Local State 中的
//   os_crypt.encrypted_key）；v11 前缀 → 仅在显式给出
//   QODER_CN_OS_CRYPT_PASSWORD 覆盖时做 PBKDF2
//   （Linux 从 gnome-keyring 读口令，此处 win32 无等价物——绝不硬编码
//   口令，改为通过解密脚本上报）。
//
// 与 intl 读取器相同的 QoderIdeIdentity 形状与“只读、任何失败返回 null”
// 约定；探测与解密见本文件的 keystore 部分。
//
// 表形式：下方每个来源都是一条 QoderIdeSource 表项；唯一循环是
// runQoderIdeSources(entries)。Linux 与 win32 与 intl 的五处差异
//（roots、container、scheme、密钥来源、字段形状）均为表项数据。
// ---------------------------------------------------------------------------


/** 读取 CN IDE 身份；不可用时返回 null（未登录 / 其他 OS / keyring 被锁定）。 */
export function readQoderCnIdeIdentity(authFile?: string): QoderIdeIdentity | null {
  if (process.platform === "linux") return readQoderCnLinuxIdentity(authFile);
  if (process.platform === "win32") return readQoderCnWin32Identity(authFile);
  return null; // 基于 libsecret/DPAPI；其他平台需不同密钥存储
}

/**
 * 单分发：cn→readQoderCnIdeIdentity(authFile)，intl→readQoderIdeIdentity()。
 * 平台守卫留叶子函数，本函数只分发。
 */
export function readQoderIdeIdentityFor(region: "cn" | "intl", authFile?: string): QoderIdeIdentity | null {
  if (region === "cn") return readQoderCnIdeIdentity(authFile);
  return readQoderIdeIdentity();
}

/** 统一 fieldMap（原 CN_FIELD_MAP 改名）：uid=user.id??doc.id nickname=user.name??doc.name expireTime=doc.expireTime??doc.expiresAt。 */
const QODER_FIELD_MAP: QoderIdeFieldMap = {
  uid: (doc, user) => {
    const src = user["id"] ?? doc["id"] ?? "";
    return typeof src === "string" || typeof src === "number" ? String(src) : "";
  },
  nickname: (doc, user) => {
    const src = user["name"] ?? doc["name"] ?? "";
    return typeof src === "string" ? src : "";
  },
  expireTime: (doc) => {
    const raw = doc["expireTime"] ?? doc["expiresAt"] ?? 0;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const t = Date.parse(raw);
      if (Number.isFinite(t)) return t;
    }
    return 0;
  },
};

function cnLinuxEntries(authFile?: string): QoderIdeSource[] {
  const file =
    authFile ?? join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "com.qodercn.app.stable", "auth.v1.dat");
  return [
    {
      id: "cn-linux-auth.v1.dat",
      region: "cn",
      platform: "linux",
      root: dirname(file),
      file,
      container: "dat-file",
      scheme: "v11-cbc",
      keySource: "gnome-keyring",
      getPassword: osCryptPassword,
      fieldMap: QODER_FIELD_MAP,
      probeKind: "auth.v1.dat",
    },
  ];
}

function readQoderCnLinuxIdentity(authFile?: string): QoderIdeIdentity | null {
  try {
    return runQoderIdeSources(cnLinuxEntries(authFile));
  } catch {
    return null;
  }
}

/**
 * 经系统 python-gi 绑定从 gnome-keyring 按应用名单获取
 * Electron safeStorage 口令（不引入新依赖）。
 * 该密钥仅经管道进入内存——绝不记入日志。
 */
function osCryptPasswordFor(apps: string[]): string | null {
  const script = `
import gi, sys
gi.require_version('Secret', '1')
from gi.repository import Secret
apps = ${JSON.stringify(apps)}
svc = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, None)
for coll in Secret.Service.get_collections(svc):
    for it in coll.get_items():
        a = it.get_attributes()
        if a.get('application') in apps and 'os_crypt' in a.get('xdg:schema', ''):
            it.load_secret_sync(None)
            s = it.get_secret()
            if s is not None:
                sys.stdout.write(s.get_text())
                sys.exit(0)
sys.exit(1)
`;
  let bin: string;
  try {
    bin = resolvePythonBin();
  } catch {
    // 无解释器：走原失败路径（口令取不到 → 身份 null），绝不向调用方抛未捕获异常。
    return null;
  }
  try {
    const py = spawnSync(bin, ["-c", script], { timeout: 15_000, windowsHide: true });
    if (py.status !== 0) return null;
    const password = py.stdout?.toString("utf8") ?? "";
    return password || null;
  } catch {
    return null;
  }
}

/** CN IDE 的 gnome-keyring 口令（名单见 KEYRING_APPS；行为与抽取前一致）。 */
function osCryptPassword(): string | null {
  return osCryptPasswordFor(KEYRING_APPS);
}

/** 海外版 gnome-keyring 口令（UNVERIFIED —— 本机无海外版 Linux IDE，名单为 best-effort）。 */
function osCryptIntlPassword(): string | null {
  return osCryptPasswordFor(INTL_KEYRING_APPS);
}

/** win32 上显式的 v11 覆盖（Linux 改为从 gnome-keyring 读取该口令）。 */
function win32EnvPassword(): string | null {
  return process.env["QODER_CN_OS_CRYPT_PASSWORD"]?.trim() || null;
}

// ---------------------------------------------------------------------------
// win32（未验证）：候选探测 + 脱敏诊断
// ---------------------------------------------------------------------------

const KEYRING_APPS = ["Qoder CN App", "Qoder CN", "QoderCN"];

/**
 * 海外版 gnome-keyring 应用名单（UNVERIFIED —— 本机无海外版 Linux IDE 实测，
 * 仿 CN 名单的 best-effort 覆盖；条目形如 application=Qoder* +
 * xdg:schema 含 os_crypt，见 osCryptPasswordFor）。
 */
const INTL_KEYRING_APPS = ["Qoder", "Qoder Intl", "QoderIntl"];

function makeCnDatSource(opts: { root: string; file: string; id: string }): QoderIdeSource {
  return {
    id: opts.id,
    region: "cn",
    platform: "win32",
    root: opts.root,
    file: opts.file,
    container: "dat-file",
    scheme: ["v10-gcm", "v11-cbc"],
    keySource: ["local-state-dpapi", "env-password"],
    tmpInfix: "-cn",
    getPassword: win32EnvPassword,
    fieldMap: QODER_FIELD_MAP,
    probeKind: "auth.v1.dat",
  };
}

function cnAuthSource(root: string): QoderIdeSource {
  return makeCnDatSource({ root, file: join(root, "auth.v1.dat"), id: `cn-dat:${root}` });
}

/** 作为表项的显式文件覆盖（仅 auth.v1.dat；已移除 state.vscdb 探测——见 cn 表头）。 */
function explicitWin32Source(file: string): QoderIdeSource {
  return makeCnDatSource({ root: dirname(file), file, id: `cn-explicit-dat:${file}` });
}

function readQoderCnWin32Identity(authFile?: string): QoderIdeIdentity | null {
  const tried: string[] = [];
  const entries: QoderIdeSource[] = [];
  if (authFile) {
    try {
      if (statSync(authFile).isFile()) entries.push(explicitWin32Source(authFile));
    } catch {
      tried.push(authFile);
    }
  }
  for (const root of listQoderCnWin32CandidateRoots(authFile)) {
    entries.push(cnAuthSource(root));
  }
  const hit = runQoderIdeSources(entries, tried);
  if (hit) return hit;
  // 仅路径——绝不含文件内容、密钥或 token。
  console.warn(
    `[qoder-cn] win32: no usable CN IDE identity (unverified layout — run decrypt:qoder-cn and report); tried: ${tried.join("; ")}`,
  );
  return null;
}

// ---------------------------------------------------------------------------
// 探测/诊断导出 (win32)
// ---------------------------------------------------------------------------

/** 脱敏的单文件探测结果（win32）：形状同 QoderIdeFileProbe——为兼容保留的别名。 */
export type QoderCnWin32FileProbe = QoderIdeFileProbe;

export interface QoderCnWin32RootProbe {
  root: string;
  rootExists: boolean;
  authV1Dat: QoderCnWin32FileProbe;
}

/**
 * 有序的 win32 候选根目录（此处不检查存在性——由探测完成）。
 * 优先级：显式调用方覆盖 → QODER_CN_APPDATA 环境变量 →
 * %APPDATA% 变体 → %LOCALAPPDATA% 变体 → com.qodercn.app.* 目录。
 */
export function listQoderCnWin32CandidateRoots(explicit?: string): string[] {
  const roots: string[] = [];
  const push = (p?: string) => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  if (explicit) {
    try {
      push(statSync(explicit).isFile() ? dirname(explicit) : explicit);
    } catch {
      push(explicit);
    }
  }
  push(process.env["QODER_CN_APPDATA"]);
  const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  for (const base of [appData, localAppData]) {
    push(join(base, "Qoder CN"));
  }
  push(join(appData, "com.qodercn.app.stable"));
  push(join(localAppData, "com.qodercn.app.stable"));
  for (const base of [appData, localAppData]) {
    for (const d of discoverQoderCnDirs(base)) push(d);
  }
  return roots;
}

/** 基目录（如 %APPDATA%）下自动发现的 Qoder CN 目录：com.qodercn* 或同时含 qoder 与 cn。基目录缺失 / 不可读 → []。 */
function discoverQoderCnDirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && (/com\.qodercn/i.test(e.name) || (/qoder/i.test(e.name) && /cn/i.test(e.name))),
      )
      .map((e) => join(base, e.name));
  } catch {
    return [];
  }
}

/** 探测所有候选根目录，不触网。在任何 OS 上都安全（缺失路径仅上报 exists:false）。 */
export function probeQoderCnWin32Candidates(explicit?: string): QoderCnWin32RootProbe[] {
  if (explicit) {
    try {
      if (statSync(explicit).isFile()) return [probeExplicitWin32File(explicit)];
    } catch {
      // 落空则继续按根目录探测
    }
  }
  return listQoderCnWin32CandidateRoots(explicit).map(probeWin32Root);
}

function blankAuthDat(root: string): QoderCnWin32FileProbe {
  return { kind: "auth.v1.dat", path: join(root, "auth.v1.dat"), exists: false, decrypted: false };
}

function probeExplicitWin32File(file: string): QoderCnWin32RootProbe {
  const root = dirname(file);
  const authV1Dat = file.toLowerCase().endsWith(".dat")
    ? tryQoderIdeSource(explicitWin32Source(file)).probe
    : blankAuthDat(root);
  return { root, rootExists: existsSync(root), authV1Dat };
}

function probeWin32Root(root: string): QoderCnWin32RootProbe {
  let rootExists = false;
  try {
    rootExists = existsSync(root);
  } catch {
    rootExists = false;
  }
  const authV1Dat = rootExists ? tryQoderIdeSource(cnAuthSource(root)).probe : blankAuthDat(root);
  return { root, rootExists, authV1Dat };
}
