/**
 * .info×二进制配对 fixture 测试（离线、无真值）：
 * 双 App 双 key 交叉（mismatch 自动落到正确对）、显式钉独占失败即抛、报错 tried 对。
 * 只打印 ok/FAIL 与计数，不打印密钥/token/明文（keyId 前4为任务允许的诊断信息）。
 *
 * 双系统兼容：
 * - Linux：走真实 PATH + `#!/bin/sh` 假二进制 exec（原逻辑）。
 * - Windows：autoAuthDirs 读 %LOCALAPPDATA%（忽略 XDG），listElectronBinaries
 *   只认 ProgramFiles/.exe + 注册表（忽略 PATH），且假二进制不可直接 exec；
 *   因此 Win 下用测试缝 __setElectronBinariesForTests /
 *   __setAtRestKeyResolverForTests 注入内存映射（默认关闭，生产优先序不变）。
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { delimiter, join } from "node:path";

import {
  CodeBuddyCredentials,
  sealField,
  __setAtRestKeyResolverForTests,
  __setElectronBinariesForTests,
} from "../src/providers/codebuddy/credentials.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const isWin = process.platform === "win32";

const FX = join(process.cwd(), "cbtest-run", `pair-fx-${process.pid}`);
const savedEnv: Record<string, string | undefined> = {};
for (const k of [
  "PATH",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "HOME",
  "WORKBUDDY_ELECTRON_BIN",
  "WORKBUDDY_AUTH_FILE",
  "CODEBUDDY_VSCDB",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
]) {
  savedEnv[k] = process.env[k];
}
const restoreEnv = (): void => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
const clearMocks = (): void => {
  __setElectronBinariesForTests(undefined);
  __setAtRestKeyResolverForTests(undefined);
};

const derive = (s: string): { key: Buffer; keyId: string } => {
  const key = createHash("sha256").update(s, "utf8").digest();
  return { key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 16) };
};
const writeBin = (dir: string, name: string, secret: string): void => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ version: 1, atRestSecretKey: secret, binding: "fixture" })}'\n`);
  try {
    chmodSync(p, 0o755);
  } catch {
    // Windows 下 chmod 仅影响只读位，失败忽略（Win 走 mock resolver，不 exec）。
  }
};
const writeInfo = (dir: string, name: string, key: Buffer, keyId: string, uid: string): void => {
  mkdirSync(dir, { recursive: true });
  const doc = {
    auth: {
      accessToken: sealField(key, keyId, `access-${uid}`),
      refreshToken: sealField(key, keyId, `refresh-${uid}`),
      expiresAt: Date.now() + 3_600_000,
      domain: "www.codebuddy.cn",
    },
    account: { uid, enterpriseId: `e-${uid}` },
  };
  writeFileSync(join(dir, name), JSON.stringify(doc));
};

/** 双系统 auth 指向：Linux 读 XDG，Win 读 LOCALAPPDATA，两边同时设置同一基址。 */
const pointAuthAt = (base: string): void => {
  process.env["XDG_DATA_HOME"] = base;
  process.env["LOCALAPPDATA"] = base;
};

/** Win 用内存映射注入二进制列表 + 解析（不 exec）；Linux 不用（走真实 PATH exec）。 */
const mockBinaries = (entries: Array<{ path: string; secret: string }>): void => {
  __setElectronBinariesForTests(entries.map((e) => e.path));
  __setAtRestKeyResolverForTests(async (binary: string) => {
    const hit = entries.find((e) => e.path === binary);
    if (!hit) throw new Error(`mock: unknown binary ${binary}`);
    const { key, keyId } = derive(hit.secret);
    return { key, keyId, binding: "fixture", binary };
  });
};
/** 仅注入 resolver（被钉 electron 场景：列表保持被钉独占，不被 override 遮蔽）。 */
const mockResolverOnly = (entries: Array<{ path: string; secret: string }>): void => {
  __setElectronBinariesForTests(undefined);
  __setAtRestKeyResolverForTests(async (binary: string) => {
    const hit = entries.find((e) => e.path === binary);
    if (!hit) throw new Error(`mock: unknown binary ${binary}`);
    const { key, keyId } = derive(hit.secret);
    return { key, keyId, binding: "fixture", binary };
  });
};

try {
  const secretA = randomBytes(16).toString("hex");
  const secretB = randomBytes(16).toString("hex");
  const { key: keyA, keyId: keyIdA } = derive(secretA);
  const { key: keyB, keyId: keyIdB } = derive(secretB);
  void keyIdB;

  const dataHome = join(FX, "data");
  const dirA = join(dataHome, "CodeBuddyExtension", "Data", "Public", "auth");
  const dirB = join(dataHome, "WorkBuddyExtension", "Data", "Public", "auth");
  writeInfo(dirA, "a.info", keyA, keyIdA, "uid-a");
  writeInfo(dirB, "b.info", keyB, derive(secretB).keyId, "uid-b");

  const bins1 = join(FX, "bins1");
  const bins2 = join(FX, "bins2");
  writeBin(bins1, "codebuddy", secretB); // 与 a.info 失配，须落到下一对
  writeBin(bins2, "workbuddy", secretA); // 与 a.info 配对命中

  pointAuthAt(dataHome);
  process.env["XDG_CONFIG_HOME"] = join(FX, "xconfig");
  process.env["HOME"] = join(FX, "home");
  // Win 隔离：vscdb 默认读 %APPDATA%，二进制默认读 ProgramFiles/LOCALAPPDATA——全部钉到 fixture 内，不碰真机。
  process.env["APPDATA"] = join(FX, "appdata");
  process.env["ProgramFiles"] = join(FX, "pf");
  process.env["ProgramFiles(x86)"] = join(FX, "pf86");
  delete process.env["WORKBUDDY_ELECTRON_BIN"];
  delete process.env["WORKBUDDY_AUTH_FILE"];
  delete process.env["CODEBUDDY_VSCDB"];

  if (isWin) {
    mockBinaries([
      { path: join(bins1, "codebuddy"), secret: secretB },
      { path: join(bins2, "workbuddy"), secret: secretA },
    ]);
    // PATH 仅作意图保留（Win 自动探测忽略 PATH，以 mock 为准）；保留原 PATH 避免丢系统目录。
    process.env["PATH"] = [bins1, bins2, savedEnv["PATH"] ?? ""].filter(Boolean).join(delimiter);
  } else {
    clearMocks();
    process.env["PATH"] = [bins1, bins2].join(delimiter);
  }

  // 1. 交叉配对：(a.info × codebuddy→B) mismatch → (a.info × workbuddy→A) 命中
  const creds = new CodeBuddyCredentials(undefined, undefined, "test/0.1");
  const auth = await creds.get();
  check("cross-pair falls through to correct pair", auth.uid === "uid-a" && auth.accessToken === "access-uid-a");
  const authAgain = await creds.get();
  check("cached hit stable", authAgain.uid === "uid-a");

  // 2. 明文文件无需二进制（被钉到不存在路径也不抛）
  const plainDir = join(FX, "plaindir");
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(
    join(plainDir, "p.info"),
    JSON.stringify({ auth: { accessToken: "plain-access", refreshToken: "plain-refresh" }, account: { uid: "uid-p" } }),
  );
  process.env["WORKBUDDY_AUTH_FILE"] = plainDir;
  process.env["WORKBUDDY_ELECTRON_BIN"] = join(FX, "no-such-binary");
  const plainCreds = new CodeBuddyCredentials(undefined, undefined, "test/0.1");
  const plainAuth = await plainCreds.get();
  check("plaintext needs no binary", plainAuth.uid === "uid-p" && plainAuth.accessToken === "plain-access");
  delete process.env["WORKBUDDY_AUTH_FILE"];
  delete process.env["WORKBUDDY_ELECTRON_BIN"];

  // 3. auth 被钉：坏文件直接抛显式指定，不掉自动探测（XDG 好文件本可成功）
  const badDir = join(FX, "pinned-bad");
  mkdirSync(badDir, { recursive: true });
  const { keyId: badKeyId } = derive(randomBytes(16).toString("hex"));
  writeFileSync(
    join(badDir, "bad.info"),
    JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: badKeyId, nonce: Buffer.alloc(12).toString("base64"), authTag: Buffer.alloc(16).toString("base64"), ciphertext: Buffer.alloc(16).toString("base64") })).toString("base64") }, refreshToken: "r" } }),
  );
  process.env["WORKBUDDY_AUTH_FILE"] = badDir;
  const pinnedCreds = new CodeBuddyCredentials(undefined, undefined, "test/0.1");
  try {
    await pinnedCreds.get();
    check("pinned auth fails fast", false);
  } catch (e) {
    const msg = (e as Error).message;
    check("pinned auth fails fast", msg.includes("显式指定") && !msg.includes("vscdb fallback also failed"), msg.slice(0, 100));
  }
  delete process.env["WORKBUDDY_AUTH_FILE"];

  // 4. electron 被钉：只用被钉二进制，mismatch 直接抛且 tried 不含别的二进制
  const onlyA = join(FX, "onlya", "CodeBuddyExtension", "Data", "Public", "auth");
  mkdirSync(onlyA, { recursive: true });
  writeInfo(onlyA, "a.info", keyA, keyIdA, "uid-a");
  pointAuthAt(join(FX, "onlya"));
  const pinnedBinDir = join(FX, "pinned-bin");
  writeBin(pinnedBinDir, "pinned-elect", secretB);
  const pinnedElectPath = join(pinnedBinDir, "pinned-elect");
  process.env["WORKBUDDY_ELECTRON_BIN"] = pinnedElectPath;
  if (isWin) {
    // 被钉独占：只 mock 解析，不覆盖列表（列表须为被钉项本身）。
    mockResolverOnly([{ path: pinnedElectPath, secret: secretB }]);
  } else {
    clearMocks();
  }
  const eCreds = new CodeBuddyCredentials(undefined, undefined, "test/0.1");
  try {
    await eCreds.get();
    check("pinned electron mismatch throws", false);
  } catch (e) {
    const msg = (e as Error).message;
    check(
      "pinned electron mismatch throws",
      msg.includes("显式指定") && msg.includes("pinned-elect") && !msg.includes("×codebuddy") && !msg.includes("×workbuddy"),
      msg.slice(0, 120),
    );
  }
  delete process.env["WORKBUDDY_ELECTRON_BIN"];

  // 5. 耗尽报错含 tried 对（basename + keyId 前4）与 vscdb 尾巴
  const onlyBad = join(FX, "onlybad", "CodeBuddyExtension", "Data", "Public", "auth");
  mkdirSync(onlyBad, { recursive: true });
  const { keyId: envKeyId } = derive(randomBytes(16).toString("hex"));
  const { keyId: binKeyId } = derive(secretB);
  writeFileSync(
    join(onlyBad, "bad.info"),
    JSON.stringify({ auth: { accessToken: sealField(keyA, envKeyId, "x"), refreshToken: "r" } }),
  );
  pointAuthAt(join(FX, "onlybad"));
  const soloBin = join(FX, "solobin");
  writeBin(soloBin, "workbuddy", secretB);
  const soloPath = join(soloBin, "workbuddy");
  if (isWin) {
    mockBinaries([{ path: soloPath, secret: secretB }]);
    process.env["PATH"] = [soloBin, savedEnv["PATH"] ?? ""].filter(Boolean).join(delimiter);
  } else {
    clearMocks();
    process.env["PATH"] = soloBin;
  }
  const tCreds = new CodeBuddyCredentials(undefined, undefined, "test/0.1");
  try {
    await tCreds.get();
    check("exhausted error", false);
  } catch (e) {
    const msg = (e as Error).message;
    check(
      "exhausted error lists tried pairs",
      msg.includes("tried:") &&
        msg.includes("bad.info") &&
        msg.includes("workbuddy") &&
        msg.includes(binKeyId.slice(0, 4)) &&
        msg.includes("(vscdb fallback also failed:"),
      msg.slice(0, 160),
    );
  }
} finally {
  clearMocks();
  restoreEnv();
  rmSync(FX, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PAIRING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
