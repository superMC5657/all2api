import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * ZCode 桌面端版本号探测（User-Agent: ZCode/<ver> 与 X-ZCode-App-Version 跟随本地安装）。
 *
 * 显式优先顺序（DEFAULTS 为空时探测才生效）：
 *   configVersion（config.jsonc providers.zcode.appVersion，非空即优先）
 *   > ZCODE_APP_VERSION 环境变量（不停机热修）
 *   > 本地探测（注册表 > exe > runtime）
 *   > null（调用方回落 CLIENT_APP_VERSION_DEFAULT 常量）
 *
 * 同步构造、永不 throw：探测失败一律返回 null。
 * 缓存只缓存探测成功值；显式值（config/env）每次现算、bypass 缓存。
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** 从任意文本里提取首个 x.y.z（"3.14.3.7762" 取 "3.14.3"；"ZCode 3.14.3" 取 "3.14.3"）。 */
function pickVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/** 多个干净 x.y.z 取最大（数值逐段比较）。 */
function maxVersion(candidates: string[]): string | null {
  let best: number[] | null = null;
  let bestRaw = "";
  for (const c of candidates) {
    const m = VERSION_RE.exec((c ?? "").trim());
    if (!m) continue;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || compareParts(parts, best) > 0) {
      best = parts;
      bestRaw = (c ?? "").trim();
    }
  }
  return best ? bestRaw : null;
}

/** 注册表：卸载项里 DisplayVersion 优先、无则从 DisplayName 取（实机为 "ZCode 3.14.3"）。仅 win32。 */
function versionFromRegistry(): string | null {
  if (process.platform !== "win32") return null;
  const found: string[] = [];
  const hives = [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const hive of hives) {
    let out = "";
    try {
      out = execFileSync("reg", ["query", hive, "/s", "/f", "ZCode"], {
        timeout: 10_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue; // 注册表不可读——尝试下一个 hive
    }
    for (const block of out.split(/\r?\n\s*\r?\n/)) {
      if (!/zcode/i.test(block)) continue;
      for (const line of block.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (/^DisplayVersion\s+REG_SZ/i.test(trimmed)) {
          const v = pickVersion(trimmed);
          if (v) found.push(v);
        }
      }
      // 无 DisplayVersion 时从 DisplayName 取版本段
      const nameLine = block
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^DisplayName\s+REG_SZ/i.test(l));
      if (nameLine) {
        const v = pickVersion(nameLine);
        if (v) found.push(v);
      }
    }
  }
  return maxVersion(found);
}

/** 各平台 ZCode 主程序候选（只做存在性过滤，不拉起）。 */
function zcodeExeCandidates(): string[] {
  const out: string[] = [];
  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    out.push(
      join(localAppData, "Programs", "ZCode", "ZCode.exe"),
      join(pf, "ZCode", "ZCode.exe"),
      join(pf86, "ZCode", "ZCode.exe"),
    );
  } else if (process.platform === "darwin") {
    out.push("/Applications/ZCode.app/Contents/MacOS/ZCode");
  } else {
    out.push("/usr/bin/zcode", "/usr/local/bin/zcode", "/opt/ZCode/zcode");
    for (const dir of (process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter)) {
      if (dir) out.push(join(dir, "zcode"));
    }
  }
  return [...new Set(out)].filter((p) => existsSync(p));
}

/**
 * exe：只读版本资源、永不拉起 GUI。
 * win32 读 PE ProductVersion；darwin 读 Info.plist；linux 无免拉起版本源、直接跳过走 runtime。
 * （实测 ZCode.exe --version 会启动主进程，故全平台禁用 --version 探测。）
 */
function versionFromExe(): string | null {
  for (const exe of zcodeExeCandidates()) {
    try {
      if (process.platform === "win32") {
        const out = execFileSync(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item '${exe}').VersionInfo.ProductVersion`],
          { timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        const v = pickVersion(out);
        if (v) return v;
        continue;
      }
      if (process.platform === "darwin") {
        const plist = join(exe, "..", "..", "Info.plist");
        if (!existsSync(plist)) continue;
        const text = readFileSync(plist, "utf8");
        const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
        const v = m ? pickVersion(m[1] ?? "") : null;
        if (v) return v;
      }
    } catch {
      // 该 exe 读不到版本——试下一个候选
    }
  }
  return null;
}

/** runtime：~/.zcode/v2/runtime/provider/<platform>/ 下的版本目录取最大。 */
function versionFromRuntime(): string | null {
  const providerDir = join(homedir(), ".zcode", "v2", "runtime", "provider");
  let platforms: string[] = [];
  try {
    platforms = readdirSync(providerDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const plat of platforms) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(providerDir, plat), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (VERSION_RE.test(name.trim())) found.push(name.trim());
    }
  }
  return maxVersion(found);
}

/** 本地探测（注册表 > exe > runtime），永不 throw，失败返回 null。 */
export function detectLocalZCodeAppVersion(): string | null {
  try {
    return versionFromRegistry() ?? versionFromExe() ?? versionFromRuntime();
  } catch {
    return null;
  }
}

/** 只缓存探测成功值；失败（null）不缓存，下次调用重探。 */
let probedCache: string | null = null;

/**
 * 解析最终 appVersion：config 显式值 > ZCODE_APP_VERSION 环境变量 > 本地探测 > null。
 * 显式值（config/env）bypass 缓存；都找不到返回 null，由调用方回落 CLIENT_APP_VERSION_DEFAULT。
 */
export function resolveZCodeAppVersion(opts?: { configVersion?: string }): string | null {
  const explicit = opts?.configVersion?.trim() ?? "";
  if (explicit) return explicit;
  const fromEnv = process.env["ZCODE_APP_VERSION"]?.trim() ?? "";
  if (fromEnv) return fromEnv;
  if (probedCache) return probedCache;
  const detected = detectLocalZCodeAppVersion();
  if (detected) probedCache = detected;
  return detected;
}
