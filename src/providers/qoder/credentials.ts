import { spawnSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Shared keystore base for the Qoder desktop IDE readers (intl + CN).
 *
 * Both flavors reuse the same Electron/Chromium OSCrypt envelope and differ
 * only in their data sources (file paths, sqlite keys, field maps, region):
 *   - intl: win32 DPAPI + state.vscdb + AES-256-GCM ("v10")
 *   - cn:   Linux gnome-keyring + auth.v1.dat + AES-128-CBC ("v11"),
 *           plus best-effort win32 candidate probing (DPAPI "v10" /
 *           PBKDF2 "v11" per file)
 *
 * The intl/CN source tables below own the data source definitions; the
 * shared engine in this file handles probing + decryption for both.
 *
 * Redaction contract (diagnostics and probes): only existence, key length in
 * bytes, 3-byte prefixes, JSON field names, truncated error messages, and
 * token prefixes + lengths are ever surfaced — never secret values, keys,
 * or full tokens.
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface QoderIdeIdentity {
  /** dt-… access token — used as a plain Bearer against the gateway. */
  token: string;
  refreshToken: string;
  uid: string;
  nickname: string;
  /** Epoch ms; 0 when unknown. */
  expireTime: number;
}

/** Chromium OSCrypt payload prefixes: "v10" (AES-256-GCM) / "v11" (AES-128-CBC). */
export type OsCryptPrefix = "v10" | "v11";

/** One decrypt candidate: a file path plus its reader (missing file / throw counts as a miss). */
export interface KeystoreCandidate<T> {
  /** Probed file path — recorded into `tried` (paths only, never content). */
  path: string;
  read: () => T | null;
}

/** Where the encrypted blob lives. */
export type QoderIdeContainer = "sqlite-item" | "dat-file";
/** Chromium OSCrypt envelope: v10 → AES-256-GCM, v11 → AES-128-CBC. */
export type QoderIdeScheme = "v10-gcm" | "v11-cbc";
/** Where the decryption key/password comes from. */
export type QoderIdeKeySource = "local-state-dpapi" | "gnome-keyring" | "env-password";

/**
 * Per-shape field extraction (the "fieldMap"): token/refresh are always the
 * top-level `token` / `refreshToken` strings; uid/nickname/expire differ per
 * flavor (intl flat `id`/`name`/`expireTime` vs CN `user:{id,name}` +
 * `expiresAt`), so each table entry carries its own extractors and the
 * engine never branches on shape.
 */
export interface QoderIdeFieldMap {
  uid(doc: Record<string, unknown>, user: Record<string, unknown>): string;
  nickname(doc: Record<string, unknown>, user: Record<string, unknown>): string;
  expireTime(doc: Record<string, unknown>): number;
}

/** One decryptable data source: everything the engine needs, as data. */
export interface QoderIdeSource {
  /** Stable id for debugging (never a secret). */
  id: string;
  region: "intl" | "cn";
  platform: "win32" | "linux";
  /** User-data / config dir: DPAPI `Local State` lives here; also the probe root. */
  root: string;
  /** Absolute file to read (sqlite db or .dat). Resolved from roots[] by the table builders. */
  file: string;
  container: QoderIdeContainer;
  /** sqlite ItemTable key (sqlite-item only). */
  itemKey?: string;
  /** Envelope(s) to try, in order (auth.v1.dat tries v10 then v11). */
  scheme: QoderIdeScheme | QoderIdeScheme[];
  /** Key source(s), parallel to scheme when given as an array. */
  keySource: QoderIdeKeySource | QoderIdeKeySource[];
  /** DPAPI temp-file infix (intl "" vs cn "-cn"). */
  tmpInfix?: string;
  /** Password provider for v11-cbc (gnome-keyring fetcher / env override). */
  getPassword?: () => string | null;
  fieldMap: QoderIdeFieldMap;
  /** Probe grouping (state.vscdb vs auth.v1.dat). */
  probeKind: "state.vscdb" | "auth.v1.dat";
}

/** Redacted per-file attempt: metadata only, never secret material. */
export interface QoderIdeFileProbe {
  kind: "state.vscdb" | "auth.v1.dat";
  path: string;
  exists: boolean;
  /** "v10" / "v11" / other 3-byte prefix, when the file could be read. */
  prefix?: string;
  /** sqlite key present (sqlite-item only). */
  keyPresent?: boolean;
  /** Decrypted AES key length in bytes (never the key itself). */
  keyLength?: number;
  decrypted: boolean;
  /** Top-level JSON field names of the decrypted doc (never values). */
  fields?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// keystore 原语
// ---------------------------------------------------------------------------

/** First 3 bytes of an OSCrypt blob as text (e.g. "v10" / "v11"); metadata only, never secret material. */
export function osCryptPrefix(blob: Buffer): string {
  return blob.slice(0, 3).toString();
}

/** True when the blob carries the expected OSCrypt prefix. */
export function hasOsCryptPrefix(blob: Buffer, prefix: OsCryptPrefix): boolean {
  return osCryptPrefix(blob) === prefix;
}

/** "v10" payload → AES-256-GCM (nonce 12B | ciphertext | tag 16B). */
export function aesGcmDecrypt(data: Buffer, key: Buffer): string {
  const nonce = data.slice(0, 12);
  const tag = data.slice(data.length - 16);
  const ct = data.slice(12, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Chromium Linux OSCrypt "v11": PBKDF2-SHA1 key + AES-128-CBC with a fixed space IV. */
export function aesCbcDecrypt(data: Buffer, password: string): string {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  // autoPadding (default true) already strips PKCS#7 — no manual unpad step.
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/**
 * DPAPI-unwrap of `<userDataDir>/Local State` → os_crypt.encrypted_key.
 * Only opens for the same Windows user that ran the IDE.
 *
 * @param tmpInfix keeps transient temp names distinct per caller
 *   (intl "" → all2api-qkey.bin/.key, cn "-cn" → all2api-qkey-cn.bin/.key).
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
    // transient key material never outlives this call
    for (const f of [tmpBlob, tmpKey]) {
      try {
        unlinkSync(f);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Candidate probing ("firstExisting"): exist → try → next on failure.
 * Returns the first non-null hit, or null when nothing opens. Every probed
 * path is appended to `tried` so callers can warn once with the tried paths
 * (paths only, never content) on total failure.
 */
export function firstExisting<T>(candidates: KeystoreCandidate<T>[], tried: string[] = []): T | null {
  for (const candidate of candidates) {
    tried.push(candidate.path);
    try {
      if (!existsSync(candidate.path)) continue;
      const hit = candidate.read();
      if (hit) return hit;
    } catch {
      // next candidate
    }
  }
  return null;
}

/** Redacted probe error: message only, truncated — never secret material. */
export function truncateProbeError(err: unknown, max = 200): string {
  return String((err as Error)?.message ?? err).slice(0, max);
}

/** Top-level JSON field names of a decrypted doc (never values). */
export function decryptedFieldNames(doc: Record<string, unknown>): string[] {
  return Object.keys(doc);
}

// ---------------------------------------------------------------------------
// 引擎 ("按表取钥")
//
// Extracts the international Qoder IDE's own login identity from its local
// store, so all2api can reuse the desktop login without any interactive
// token creation.
//
// Data source (this adapter owns it): %APPDATA%/Qoder/User/globalStorage/
// state.vscdb under `secret://aicoding.auth.userInfo`, encrypted with the
// Electron safeStorage (Chromium OSCrypt) scheme: "v10" prefix + AES-256-GCM,
// where the AES key itself sits DPAPI-protected in `Local State` →
// os_crypt.encrypted_key. Everything only opens for the same Windows user
// that ran the IDE. Probing + decryption live in the keystore section below.
//
// This file also owns the shared table-driven engine: every adapter (intl +
// CN) is a data table (QoderIdeSource entries) plus one engine call. The
// engine is the only place with an existence → try → next loop; all five
// observed source differences (roots, container, scheme, key source, field
// shape) are expressed as entry data, never as engine branches.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Data-source description table + engine ("按表取钥")
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
 * Shared prefix/key/decrypt/parse loop for both containers (sqlite-item +
 * dat-file): prefix match (in scheme order) → key → decrypt → fieldMap
 * parse. Mutates `probe` (prefix/keyLength/fields/decrypted/error) and
 * returns the engine result shape. Containers only fetch the blob; all
 * key/decrypt/error strings live here verbatim.
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
    if (scheme === "v11-cbc") probe.keyLength = 16; // PBKDF2-SHA1("saltysalt",1) → AES-128
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
 * Single-source attempt: existence → prefix match (in scheme order) → key →
 * decrypt → fieldMap parse. Never throws; failures are encoded as
 * `{ probe, identity: null }` so the engine (and the win32 probes) can move
 * on to the next entry. Probe strings mirror the pre-table helpers verbatim.
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
 * Table engine ("存在才试、失败下一个"): probe entries in order, return the
 * first successful identity. Every probed file is appended to `tried` (paths
 * only, never content) so callers can warn once with the tried paths.
 */
export function runQoderIdeSources(entries: QoderIdeSource[], tried: string[] = []): QoderIdeIdentity | null {
  for (const entry of entries) {
    tried.push(entry.file);
    try {
      const { identity } = tryQoderIdeSource(entry);
      if (identity) return identity;
    } catch {
      // next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// intl 表 (single source) + one engine call
// ---------------------------------------------------------------------------

/** sqlite key holding the intl auth document inside state.vscdb. */
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

export function readQoderIdeIdentity(ideDataDir?: string): QoderIdeIdentity | null {
  if (process.platform !== "win32") return null; // DPAPI-based; other platforms need different key stores
  try {
    return runQoderIdeSources(intlEntries(ideDataDir));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// cn 表
//
// Extracts the domestic (CN) Qoder IDE's own login identity from its local
// store, so all2api can reuse the desktop login without any PAT.
//
// Data sources (this adapter owns them):
// - Linux: ~/.config/com.qodercn.app.stable/auth.v1.dat —
//   {"token":"dt-…","refreshToken":"drt-…","user":{…},"expiresAt":"…",…}
//   encrypted with the Chromium-on-Linux OSCrypt scheme: a "v11" prefix +
//   AES-128-CBC (IV = 16 spaces), where the 128-bit key is
//   PBKDF2-HMAC-SHA1(password, salt "saltysalt", 1 iteration) of the
//   "Qoder CN App" entry (chrome_libsecret_os_crypt_password_v2) in the
//   user's gnome-keyring. Everything only opens for the same Linux user
//   that ran the IDE (keyring auto-unlocked at login).
// - Windows (win32, UNVERIFIED — no Windows machine available here, see
//   scripts/qoder-cn-decrypt.ts): best-effort candidate probing of Qoder's
//   own auth.v1.dat only. cn 只读 Qoder 自家落盘；CodeBuddy 系因跨厂商不可互认，已移除。
//   The exact on-disk layout of the domestic IDE on Windows is unconfirmed,
//   so nothing is asserted as a single fixed path — every candidate is tried
//   only if it exists (exist → try → next on failure), and a final failure
//   warns once listing the tried paths (paths only, never content).
//   Priority: explicit authFile param (= caller config override) →
//   QODER_CN_APPDATA env → %APPDATA%/Qoder CN →
//   %LOCALAPPDATA% variants → com.qodercn.app.* dirs. Per candidate only
//   auth.v1.dat is tried: v10 prefix → DPAPI (os_crypt.encrypted_key in
//   sibling Local State); v11 prefix → PBKDF2 only with an explicit
//   QODER_CN_OS_CRYPT_PASSWORD override (Linux reads the password from
//   gnome-keyring, which has no win32 equivalent here — never a hardcoded
//   password, report via the decrypt script instead).
//
// Same QoderIdeIdentity shape and "read-only, return null on any failure"
// contract as the intl reader; probing + decryption live in the keystore
// section of this file.
//
// Table form: every source below is a QoderIdeSource entry; the only loop is
// runQoderIdeSources(entries). The five Linux-vs-win32-vs-intl differences
// (roots, container, scheme, key source, field shape) are entry data.
// ---------------------------------------------------------------------------


/** Reads the CN IDE identity, or null when unavailable (logged out / other OS / locked keyring). */
export function readQoderCnIdeIdentity(authFile?: string): QoderIdeIdentity | null {
  if (process.platform === "linux") return readQoderCnLinuxIdentity(authFile);
  if (process.platform === "win32") return readQoderCnWin32Identity(authFile);
  return null; // libsecret/DPAPI-based; other platforms need different key stores
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
 * Fetches the Electron safeStorage password for the CN IDE from
 * gnome-keyring via the system python3-gi binding (no new dependencies).
 * The secret only travels through a pipe into memory — it is never logged.
 */
function osCryptPassword(): string | null {
  const script = `
import gi, sys
gi.require_version('Secret', '1')
from gi.repository import Secret
apps = ${JSON.stringify(KEYRING_APPS)}
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
  const py = spawnSync("python3", ["-c", script], { timeout: 15_000, windowsHide: true });
  if (py.status !== 0) return null;
  const password = py.stdout.toString("utf8");
  return password || null;
}

/** Explicit v11 override on win32 (Linux reads this password from gnome-keyring instead). */
function win32EnvPassword(): string | null {
  return process.env["QODER_CN_OS_CRYPT_PASSWORD"]?.trim() || null;
}

// ---------------------------------------------------------------------------
// win32 (UNVERIFIED): candidate probing + redacted diagnostics
// ---------------------------------------------------------------------------

const KEYRING_APPS = ["Qoder CN App", "Qoder CN", "QoderCN"];

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

/** Explicit file override as a table entry (auth.v1.dat only; state.vscdb probing removed — see cn table header). */
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
  // Paths only — never file content, keys, or tokens.
  console.warn(
    `[qoder-cn] win32: no usable CN IDE identity (unverified layout — run decrypt:qoder-cn and report); tried: ${tried.join("; ")}`,
  );
  return null;
}

// ---------------------------------------------------------------------------
// probe/diagnostic 导出 (win32)
// ---------------------------------------------------------------------------

/** Redacted per-file probe result (win32): same shape as QoderIdeFileProbe — alias kept for compat. */
export type QoderCnWin32FileProbe = QoderIdeFileProbe;

export interface QoderCnWin32RootProbe {
  root: string;
  rootExists: boolean;
  authV1Dat: QoderCnWin32FileProbe;
}

/**
 * Ordered win32 candidate roots (existence is NOT checked here — probing does
 * that). Priority: explicit caller override → QODER_CN_APPDATA env →
 * %APPDATA% variants → %LOCALAPPDATA% variants → com.qodercn.app.* dirs.
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

/** Auto-discovered Qoder CN dirs under a base (e.g. %APPDATA%): com.qodercn* or qoder + cn. Missing/unreadable base → []. */
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

/** Probe every candidate root without touching the network. Safe on any OS (missing paths just report exists:false). */
export function probeQoderCnWin32Candidates(explicit?: string): QoderCnWin32RootProbe[] {
  if (explicit) {
    try {
      if (statSync(explicit).isFile()) return [probeExplicitWin32File(explicit)];
    } catch {
      // fall through to root probing
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
