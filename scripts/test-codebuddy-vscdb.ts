/**
 * vscdb 凭据源 fixture 闭环测试（离线、无真值）：
 * 随机 secret → 按实测算法加密 → 临时 sqlite → 经新模块解密断言字段。
 * 只打印 ok/FAIL 与计数，不打印任何密钥/token/明文。
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  __setVscdbExecForTests,
  mapVscdbAuth,
  readKeyringSecret,
  readVscdbAuth,
  resolveVscdbPath,
} from "../src/providers/codebuddy/vscdb.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function checkThrows(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
    check(name, false, "expected throw");
  } catch {
    check(name, true);
  }
}

const FX = join(process.cwd(), "cbtest-run", `vscdb-fx-${process.pid}`);
mkdirSync(FX, { recursive: true });
try {
  const secret = randomBytes(24);
  const suffix = () => randomBytes(8).toString("hex");
  const doc = {
    accessToken: `eyJmaWtl.${suffix()}`,
    token: `eyJmaWtl.${suffix()}`,
    account: { uid: `u-${suffix()}`, enterpriseId: `e-${suffix()}` },
    domain: "www.codebuddy.cn",
    expiresAt: Date.now() + 3_600_000,
    refreshToken: `r-${suffix()}`,
  };

  // 按实测算法密封（测试本地实现，与模块互为校验）
  const key = pbkdf2Sync(secret, "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const blob = Buffer.concat([Buffer.from("v11", "ascii"), cipher.update(Buffer.from(JSON.stringify(doc), "utf8")), cipher.final()]);
  const stored = JSON.stringify({ type: "Buffer", data: [...blob] });
  const fullKey = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}';
  const dbPath = join(FX, "state.vscdb");
  execFileSync(
    "python",
    [
      "-c",
      "import sqlite3,sys; db,k,v=sys.argv[1],sys.argv[2],sys.argv[3]; con=sqlite3.connect(db); con.execute('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)'); con.execute('INSERT INTO ItemTable VALUES(?,?)',(k,v)); con.commit(); con.close()",
      dbPath,
      fullKey,
      stored,
    ],
    { timeout: 15_000 },
  );

  const base = { dbPath, key: "planning-genie.new.accessTokencn", app: "FixtureApp", keyringSecret: secret } as const;

  // 1. 往返：字段映射
  const auth = await readVscdbAuth({ ...base });
  check("roundtrip accessToken (eyJ)", auth.accessToken === doc.accessToken);
  check("roundtrip uid", auth.uid === doc.account.uid);
  check("roundtrip domain", auth.domain === doc.domain);
  check("roundtrip expiresAt", auth.expiresAt === doc.expiresAt);
  check("roundtrip refreshToken", auth.refreshToken === doc.refreshToken);
  check("roundtrip enterpriseId", auth.enterpriseId === doc.account.enterpriseId);

  // 2. accessToken 非 JWT → 回退 token
  const doc2 = { ...doc, accessToken: "not-a-jwt" };
  const key2 = pbkdf2Sync(secret, "saltysalt", 1, 16, "sha1");
  const c2 = createCipheriv("aes-128-cbc", key2, Buffer.alloc(16, 0x20));
  const blob2 = Buffer.concat([Buffer.from("v11", "ascii"), c2.update(Buffer.from(JSON.stringify(doc2), "utf8")), c2.final()]);
  const db2 = join(FX, "state2.vscdb");
  execFileSync(
    "python",
    [
      "-c",
      "import sqlite3,sys; db,k,v=sys.argv[1],sys.argv[2],sys.argv[3]; con=sqlite3.connect(db); con.execute('CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)'); con.execute('INSERT INTO ItemTable VALUES(?,?)',(k,v)); con.commit(); con.close()",
      db2,
      fullKey,
      JSON.stringify({ type: "Buffer", data: [...blob2] }),
    ],
    { timeout: 15_000 },
  );
  const auth2 = await readVscdbAuth({ ...base, dbPath: db2 });
  check("token fallback when accessToken not eyJ", auth2.accessToken === doc2.token);

  // 3. 错误形：双缺 / 错 secret / 未知 key / 缺库
  await checkThrows("missing accessToken+token throws", () =>
    Promise.resolve(mapVscdbAuth({ account: {}, expiresAt: 1, refreshToken: "r" })),
  );
  await checkThrows("wrong secret throws", () => readVscdbAuth({ ...base, keyringSecret: randomBytes(24) }));
  await checkThrows("unknown key throws", () => readVscdbAuth({ ...base, key: "no.such.key" }));
  await checkThrows("missing db throws", () => readVscdbAuth({ ...base, dbPath: join(FX, "absent.vscdb") }));
  await checkThrows("account non-object throws", () =>
    Promise.resolve(mapVscdbAuth({ accessToken: "eyJx", account: 42, expiresAt: 1, refreshToken: "r" })),
  );
  await checkThrows("expiresAt non-numeric throws", () =>
    Promise.resolve(mapVscdbAuth({ accessToken: "eyJx", expiresAt: "soon", refreshToken: "r" })),
  );

  // 4. 路径发现优先级（仅字符串断言，不读真实家目录文件）
  const saved = process.env["CODEBUDDY_VSCDB"];
  process.env["CODEBUDDY_VSCDB"] = join(FX, "env.vscdb");
  check("env CODEBUDDY_VSCDB wins", resolveVscdbPath(join(FX, "cfg.vscdb")) === join(FX, "env.vscdb"));
  delete process.env["CODEBUDDY_VSCDB"];
  check("configured vscdbPath next", resolveVscdbPath(join(FX, "cfg.vscdb")) === join(FX, "cfg.vscdb"));
  check("default vscdb path shape", resolveVscdbPath().endsWith(join("CodeBuddy CN", "User", "globalStorage", "state.vscdb")));
  if (saved !== undefined) process.env["CODEBUDDY_VSCDB"] = saved;

  // 5. 降级链（mock 子进程执行层，不碰真钥匙环；应用名唯一避缓存）
  const mockFail = (msg: string, code = 1): never => {
    throw Object.assign(new Error(msg), { code });
  };
  {
    const calls: string[] = [];
    const fx = randomBytes(16);
    __setVscdbExecForTests(async (cmd, args) => {
      const script = String(args[1] ?? "");
      calls.push(`${cmd}:${script.includes("secretstorage") ? "ss" : script.includes("org.freedesktop.secrets") ? "dbus" : "?"}`);
      if (cmd === "python" && script.includes("secretstorage")) mockFail(`${cmd} failed (1): No module named 'secretstorage'`);
      if (cmd === "python") return { stdout: fx.toString("base64"), stderr: "" };
      return mockFail(`${cmd} not mocked`, 127);
    });
    try {
      const got = await readKeyringSecret(`FixtureApp-dbus-${suffix()}`, 25_000);
      check("fallback to python+dbus when secretstorage missing", got.equals(fx) && calls[0] === "python:ss", calls.join(","));
    } finally {
      __setVscdbExecForTests();
    }
  }
  {
    // python 双链路皆缺 → gdbus 解析链路命中 fixture
    const fx = randomBytes(12);
    const hexes = [...fx].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ");
    __setVscdbExecForTests(async (cmd, args) => {
      const flat = args.join(" ");
      if (cmd === "python") return mockFail(`${cmd} failed (1): missing`, 1);
      if (flat.includes("OpenSession")) return { stdout: "('', objectpath '/org/freedesktop/secrets/session/s9')", stderr: "" };
      if (flat.includes("Collections")) return { stdout: "([objectpath '/org/freedesktop/secrets/collection/login'],)", stderr: "" };
      if (flat.includes("Items")) return { stdout: "([objectpath '/org/freedesktop/secrets/collection/login/1'],)", stderr: "" };
      if (flat.includes("Label")) return { stdout: "(<'Chromium Safe Storage'>,)", stderr: "" };
      if (flat.includes("Attributes"))
        return { stdout: `(<{'application': <'FixtureApp-gdbus'>, 'xdg:schema': <'chrome_libsecret_os_crypt_password_v2'>}>,)`, stderr: "" };
      if (flat.includes("GetSecret"))
        return { stdout: `((objectpath '/org/freedesktop/secrets/session/s9', [], [byte ${hexes}], 'text/plain'),)`, stderr: "" };
      return mockFail(`${cmd} not mocked`, 127);
    });
    try {
      const got = await readKeyringSecret("FixtureApp-gdbus", 25_000);
      check("fallback to gdbus when python links missing", got.equals(fx));
    } finally {
      __setVscdbExecForTests();
    }
  }
  {
    // 全败 → 报错列出四条链路名
    __setVscdbExecForTests(async (cmd) => mockFail(`${cmd} failed (1)`, 1));
    try {
      await readKeyringSecret(`FixtureApp-none-${suffix()}`, 3000);
      check("all-links-failed error", false);
    } catch (e) {
      const msg = (e as Error).message;
      check(
        "all-links-failed error lists links",
        ["python3+secretstorage", "python3+dbus", "gdbus", "secret-tool"].every((n) => msg.includes(n)),
        msg.slice(0, 100),
      );
    } finally {
      __setVscdbExecForTests();
    }
  }
} finally {
  rmSync(FX, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL VSCDB FIXTURE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
