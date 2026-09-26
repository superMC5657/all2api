/**
 * 本机诊断：Qoder CN 在 Windows 的落盘位置与解密是否可用。
 *
 * 只做本机探测，不调网关。打印内容严格脱敏：
 *  - 候选路径存在性、sqlite key 是否存在、前缀（v10/v11）
 *  - key 长度（字节数，绝非 key 本体）、解密是否成功
 *  - 解出 JSON 的字段名（绝非字段值）、token 前 6 位 + 长度
 * 绝不打印任何 secret 真值、key、完整 token。
 *
 * 用法（在 Windows 上）：
 *   pnpm decrypt:qoder-cn
 *   npx tsx scripts/qoder-cn-decrypt.ts [显式路径(文件或目录)]
 *   QODER_CN_APPDATA=D:\xxx npx tsx scripts/qoder-cn-decrypt.ts
 *
 * 退出码：0 = 读到可用身份；1 = 不可用（把本输出回传给维护者）。
 */
import { existsSync } from "node:fs";

import {
  listQoderCnWin32CandidateRoots,
  probeQoderCnWin32Candidates,
  readQoderCnIdeIdentity,
} from "../src/providers/qoder/credentials.js";

/** 前 6 位 + 长度；短值只给长度，绝不给全值。 */
function mask6(value: string | undefined): string {
  if (!value) return "(missing)";
  if (value.length <= 6) return `*** (len=${value.length})`;
  return `${value.slice(0, 6)}... (len=${value.length})`;
}

const explicit = process.argv[2];

console.log(`platform: ${process.platform}`);
console.log(`explicit: ${explicit ?? "(none)"}`);
console.log(`QODER_CN_APPDATA: ${process.env["QODER_CN_APPDATA"] ?? "(unset)"}`);
console.log(
  `QODER_CN_OS_CRYPT_PASSWORD: ${process.env["QODER_CN_OS_CRYPT_PASSWORD"] ? `(set, len=${process.env["QODER_CN_OS_CRYPT_PASSWORD"]?.length})` : "(unset)"}`,
);
console.log("");

const roots = listQoderCnWin32CandidateRoots(explicit);
console.log(`candidate roots (${roots.length}):`);
for (const r of roots) {
  console.log(`  [${existsSync(r) ? "exists" : "missing"}] ${r}`);
}
console.log("");

let anyDecrypted = false;
for (const c of probeQoderCnWin32Candidates(explicit)) {
  console.log(`root [${c.rootExists ? "exists" : "missing"}]: ${c.root}`);
  const a = c.authV1Dat;
  console.log(`  auth.v1.dat [${a.exists ? "exists" : "missing"}]: ${a.path}`);
  if (a.exists) {
    console.log(
      `    prefix=${a.prefix ?? "?"} keyLen=${a.keyLength ?? "?"} decrypted=${a.decrypted} fields=${a.fields?.join(",") ?? "-"}${a.error ? ` error=${a.error}` : ""}`,
    );
    if (a.decrypted) anyDecrypted = true;
  }
}
console.log("");

const ide = readQoderCnIdeIdentity(explicit);
if (ide) {
  console.log("RESULT: usable identity found");
  console.log(`  token prefix : ${mask6(ide.token)}`);
  console.log(`  refresh prefix: ${mask6(ide.refreshToken)}`);
  console.log(`  uid          : ${ide.uid || "(empty)"}`);
  console.log(`  nickname     : ${ide.nickname || "(empty)"}`);
  console.log(`  expireTime   : ${ide.expireTime ? new Date(ide.expireTime).toISOString() : "(unknown)"}`);
  process.exit(0);
} else {
  console.log(`RESULT: no usable identity (anyDecrypted=${anyDecrypted}) — 请把以上完整输出回传给维护者`);
  process.exit(1);
}
