/**
 * 本机诊断：Trae CN / Intl 在本机的落盘位置、tc 解密与身份是否可用。
 *
 * 只做本机探测，不调网关。打印内容严格脱敏：
 *  - 候选路径存在性、storage.json 键存在性、信封类型（tc/plain）
 *  - 解密是否成功、解出 JSON 的字段名（绝非字段值）
 *  - token 前 6 位 + 长度、uid/nickname（身份标识，非密钥）
 * 绝不打印任何 token 真值、盐值、密钥材料。
 *
 * 用法：
 *   npx tsx scripts/trae-decrypt.ts [显式User目录]
 *   TRAE_EDITION="TRAE SOLO CN" npx tsx scripts/trae-decrypt.ts
 *   TRAE_CN_DATA_DIR=D:\xxx npx tsx scripts/trae-decrypt.ts
 *   TRAE_TC_SALT=<128hex|base64|utf8> npx tsx scripts/trae-decrypt.ts （核对tc盐）
 *
 * 退出码：0 = 读到可用身份（CN/Intl 任一）；1 = 都不可用（把本输出回传给维护者）。
 */
import { existsSync } from "node:fs";

import {
  TRAE_CN_EDITIONS,
  TRAE_CN_TOKEN_FILE,
  TRAE_STORAGE_KEY,
  listTraeCnCandidates,
  probeTraeCnCandidates,
  readTraeCnIdentity,
  resolveTraeDeviceIds,
  resolveTraeTcSalt,
} from "../src/providers/trae-cn/credentials.js";
import {
  TRAE_INTL_EDITIONS,
  TRAE_TOKEN_FILE,
  listTraeIntlCandidates,
  probeTraeIntlCandidates,
  readTraeIdentity,
} from "../src/providers/trae/credentials.js";

/** 前 6 位 + 长度；短值只给长度，绝不给全值。 */
function mask6(value: string | undefined): string {
  if (!value) return "(missing)";
  if (value.length <= 6) return `*** (len=${value.length})`;
  return `${value.slice(0, 6)}... (len=${value.length})`;
}

function envReport(name: string): string {
  const v = process.env[name];
  if (v === undefined) return "(unset)";
  if (/token|salt|password/i.test(name)) return v ? `(set, len=${v.length})` : "(empty)";
  return v || "(empty)";
}

const explicit = process.argv[2];

console.log(`platform: ${process.platform}`);
console.log(`explicit dir: ${explicit ?? "(none)"}`);
for (const name of ["TRAE_EDITION", "TRAE_CN_DATA_DIR", "TRAE_DATA_DIR", "TRAE_CN_API_TOKEN", "TRAE_API_TOKEN", "TRAE_TC_SALT", "TRAE_IDE_VERSION", "TRAE_DEVICE_ID", "TRAE_MACHINE_ID"]) {
  console.log(`${name}: ${envReport(name)}`);
}
console.log(`tc salt source: ${resolveTraeTcSalt().source}`);
console.log("");

let anyUsable = false;

function reportSide(
  title: string,
  editions: Array<{ edition: string }>,
  list: (opts?: { dataDir?: string }) => Array<{ userDir: string; storagePath: string; edition: string }>,
  probe: (opts?: { dataDir?: string }) => Array<{ edition: string; userDir: string; storagePath: string; storageExists: boolean; keyPresent?: boolean; scheme?: string; decrypted: boolean; fields?: string[]; error?: string }>,
  tokenFile: string,
): void {
  console.log(`=== ${title} (editions: ${editions.map((e) => e.edition).join(" → ")}) ===`);
  console.log(`token file: ${tokenFile} [${existsSync(tokenFile) ? "exists" : "missing"}]`);
  const opts = explicit ? { dataDir: explicit } : undefined;
  let roots: Array<{ userDir: string; storagePath: string; edition: string }> = [];
  try {
    roots = list(opts);
  } catch (err) {
    console.log(`candidate resolve failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  for (const r of roots) {
    console.log(`  [${existsSync(r.userDir) ? "exists" : "missing"}] ${r.userDir} (edition=${r.edition})`);
    console.log(`    storage: ${r.storagePath} [${existsSync(r.storagePath) ? "exists" : "missing"}]`);
  }
  let anyDecrypted = false;
  for (const p of probe(opts)) {
    console.log(`  probe edition=${p.edition} storageExists=${p.storageExists} keyPresent=${p.keyPresent ?? "?"} scheme=${p.scheme ?? "?"} decrypted=${p.decrypted} fields=${p.fields?.join(",") ?? "-"}${p.error ? ` error=${p.error}` : ""}`);
    if (p.decrypted) anyDecrypted = true;
  }
  console.log(`  anyDecrypted=${anyDecrypted}`);
  console.log("");
}

reportSide("trae-cn", TRAE_CN_EDITIONS, listTraeCnCandidates, probeTraeCnCandidates, TRAE_CN_TOKEN_FILE);
reportSide("trae (intl)", TRAE_INTL_EDITIONS, listTraeIntlCandidates, probeTraeIntlCandidates, TRAE_TOKEN_FILE);

const cn = readTraeCnIdentity(explicit ? { dataDir: explicit } : undefined);
if (cn) {
  anyUsable = true;
  console.log("CN RESULT: usable identity found");
  console.log(`  token prefix : ${mask6(cn.token)}`);
  console.log(`  uid          : ${cn.uid || "(empty)"}`);
  console.log(`  nickname     : ${cn.nickname || "(empty)"}`);
  console.log(`  expireTime   : ${cn.expireTime ? new Date(cn.expireTime).toISOString() : "(unknown)"}`);
  console.log(`  source/edition: ${cn.source}/${cn.edition}`);
  const dev = resolveTraeDeviceIds({ userDir: cn.dataDir || undefined });
  console.log(`  device/machine/ide: ${dev.deviceId || "(empty)"} / ${dev.machineId || "(empty)"} / ${dev.ideVersion || "(empty)"}`);
} else {
  console.log(`CN RESULT: no usable identity (storage key ${TRAE_STORAGE_KEY}) — 登录 Trae CN 桌面端后重试`);
}
console.log("");

const intl = readTraeIdentity(explicit ? { dataDir: explicit } : undefined);
if (intl) {
  anyUsable = true;
  console.log("INTL RESULT: usable identity found");
  console.log(`  token prefix : ${mask6(intl.token)}`);
  console.log(`  uid          : ${intl.uid || "(empty)"}`);
  console.log(`  nickname     : ${intl.nickname || "(empty)"}`);
  console.log(`  expireTime   : ${intl.expireTime ? new Date(intl.expireTime).toISOString() : "(unknown)"}`);
  console.log(`  source/edition: ${intl.source}/${intl.edition}`);
  const dev = resolveTraeDeviceIds({ userDir: intl.dataDir || undefined });
  console.log(`  device/machine/ide: ${dev.deviceId || "(empty)"} / ${dev.machineId || "(empty)"} / ${dev.ideVersion || "(empty)"}`);
} else {
  console.log(`INTL RESULT: no usable identity (storage key ${TRAE_STORAGE_KEY}) — 登录 Trae 海外版桌面端后重试`);
}
console.log("");

console.log(anyUsable ? "OVERALL: usable identity available" : "OVERALL: no usable identity — 请把以上完整输出回传给维护者");
process.exit(anyUsable ? 0 : 1);
