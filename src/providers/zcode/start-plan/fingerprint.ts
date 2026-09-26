/**
 * 每账号客户端指纹（设备档案）—— 一号一台设备。
 *
 * Python 对照：app/fingerprint.py（DeviceProfile、random_profile()、profile_for()）。
 *  - 从成套 SKU 表抽样（platform × arch × os_version × screen 绑定），
 *    禁止字段笛卡尔积（darwin-arm64 + 1366x768 这类假电脑不出）。
 *  - 无 linux SKU：官方桌面主形态是 Mac / Windows；无号时回退
 *    darwin-arm64 桌面常量即可。
 *  - 语言/时区取真实地区对；device_mid 每次全新 UUIDv4，跨账号不复用。
 *  - 持久化到本机文件（默认 ~/.zcode/v2/all2api-device.json），按 JWT sub
 *    一号一台；install/telemetry 上报不做（二期）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface DeviceProfile {
  platform: string; // X-Platform 前半：darwin / win32
  arch: string; // arm64 / x64
  osVersion: string; // X-Os-Version（os.release() 语义）
  language: string; // X-Client-Language
  timezone: string; // X-Client-Timezone（IANA）
  screen: string; // 激活事件 screen_resolution（本期仅存档，未上报）
  deviceMid: string; // X-Device-Mid（UUIDv4）
}

// 成套桌面 SKU：(weight, platform, arch, os_version, screen)
// 分辨率只取官方桌面端常见值，并与平台绑定（Mac 逻辑分辨率不配 Windows）。
const SKUS: Array<[number, string, string, string, string]> = [
  // Apple silicon MacBook Air/Pro 13–14"（darwin 24 = Sequoia，25 = Tahoe）
  [10, "darwin", "arm64", "24.5.0", "1512x982"],
  [10, "darwin", "arm64", "24.6.0", "1512x982"],
  [8, "darwin", "arm64", "24.5.0", "1728x1117"],
  [8, "darwin", "arm64", "24.6.0", "1728x1117"],
  [8, "darwin", "arm64", "25.5.0", "1512x982"],
  [6, "darwin", "arm64", "25.5.0", "1728x1117"],
  [5, "darwin", "arm64", "23.6.0", "1512x982"],
  [4, "darwin", "arm64", "23.6.0", "1728x1117"],
  [4, "darwin", "arm64", "24.5.0", "2560x1440"],
  [3, "darwin", "arm64", "24.6.0", "2560x1600"],
  [2, "darwin", "arm64", "25.5.0", "2560x1440"],
  [2, "darwin", "arm64", "24.5.0", "3840x2160"],
  // Intel Mac 存量（Ventura/Sonoma；darwin 24+ 不再配 x64）
  [2, "darwin", "x64", "23.6.0", "1920x1080"],
  [2, "darwin", "x64", "22.6.0", "1440x900"],
  [1, "darwin", "x64", "23.6.0", "2560x1440"],
  // Windows 11 主流 + 少量 Win10
  [8, "win32", "x64", "10.0.22631", "1920x1080"],
  [7, "win32", "x64", "10.0.26100", "1920x1080"],
  [5, "win32", "x64", "10.0.22631", "2560x1440"],
  [4, "win32", "x64", "10.0.26200", "1920x1080"],
  [3, "win32", "x64", "10.0.26100", "2560x1440"],
  [3, "win32", "x64", "10.0.22621", "1920x1080"],
  [2, "win32", "x64", "10.0.22631", "3840x2160"],
  [2, "win32", "x64", "10.0.19045", "1920x1080"],
  [1, "win32", "x64", "10.0.19045", "1366x768"],
  [1, "win32", "x64", "10.0.26100", "2560x1600"],
  [1, "win32", "x64", "10.0.22000", "1920x1080"],
];

interface Sku {
  platform: string;
  arch: string;
  osVersion: string;
  screen: string;
}

const SKU_POOL: Sku[] = SKUS.flatMap(([weight, platform, arch, osVersion, screen]) =>
  Array.from({ length: weight }, () => ({ platform, arch, osVersion, screen })),
);
const SKU_COMBOS = new Set(SKU_POOL.map((s) => `${s.platform}|${s.arch}|${s.osVersion}|${s.screen}`));

// 语言-时区真实地区组合
const LOCALES: Array<[string, string]> = [
  ["zh-CN", "Asia/Shanghai"],
  ["en-US", "America/New_York"],
  ["en-US", "America/Los_Angeles"],
  ["en-GB", "Europe/London"],
  ["de-DE", "Europe/Berlin"],
  ["ja-JP", "Asia/Tokyo"],
  ["ko-KR", "Asia/Seoul"],
  ["en-SG", "Asia/Singapore"],
];

const SCREEN_RE = /^\d{3,4}x\d{3,4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANONYMOUS_KEY = "__anonymous__";

function pick<T>(arr: T[]): T {
  const item = arr[Math.floor(Math.random() * arr.length)];
  if (item === undefined) throw new Error("fingerprint: empty pick pool");
  return item;
}

/** 无 JWT sub 时的回退桌面常量（darwin-arm64，不含 linux）。 */
export function fallbackProfile(deviceMid: string): DeviceProfile {
  return {
    platform: "darwin",
    arch: "arm64",
    osVersion: "25.5.0",
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    screen: "1512x982",
    deviceMid,
  };
}

/** 随机生成一份成套桌面 SKU 档案（生成时自校验）。 */
export function randomProfile(): DeviceProfile {
  const sku = pick(SKU_POOL);
  const [language, timezone] = pick(LOCALES);
  const profile: DeviceProfile = {
    platform: sku.platform,
    arch: sku.arch,
    osVersion: sku.osVersion,
    language: language ?? "zh-CN",
    timezone: timezone ?? "Asia/Shanghai",
    screen: sku.screen,
    deviceMid: randomUUID(),
  };
  assertValid(profile);
  return profile;
}

function assertValid(profile: DeviceProfile): void {
  if (!SKU_COMBOS.has(`${profile.platform}|${profile.arch}|${profile.osVersion}|${profile.screen}`)) {
    throw new Error(
      `fingerprint: 非桌面 SKU: ${profile.platform}-${profile.arch}/${profile.osVersion}/${profile.screen}`,
    );
  }
  if (!LOCALES.some(([l, t]) => l === profile.language && t === profile.timezone)) {
    throw new Error(`fingerprint: 语言/时区组合不真实: ${profile.language}/${profile.timezone}`);
  }
  if (!SCREEN_RE.test(profile.screen)) throw new Error(`fingerprint: 分辨率形态非法: ${profile.screen}`);
  if (!UUID_RE.test(profile.deviceMid)) throw new Error("fingerprint: deviceMid 非法 UUID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStoredProfile(value: unknown): DeviceProfile | null {
  if (!isRecord(value)) return null;
  const { platform, arch, osVersion, language, timezone, screen, deviceMid } = value;
  if (
    typeof platform !== "string" ||
    typeof arch !== "string" ||
    typeof osVersion !== "string" ||
    typeof language !== "string" ||
    typeof timezone !== "string" ||
    typeof screen !== "string" ||
    typeof deviceMid !== "string" ||
    !UUID_RE.test(deviceMid)
  ) {
    return null;
  }
  return { platform, arch, osVersion, language, timezone, screen, deviceMid };
}

/** 解析 deviceFile 路径（空 → 默认 ~/.zcode/v2/all2api-device.json；支持 ~ 前缀）。 */
export function resolveDeviceFile(configured?: string): string {
  const raw = configured?.trim() || join(homedir(), ".zcode", "v2", "all2api-device.json");
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

function loadStore(deviceFile: string): Record<string, DeviceProfile> {
  try {
    if (!existsSync(deviceFile)) return {};
    const parsed: unknown = JSON.parse(readFileSync(deviceFile, "utf8"));
    if (!isRecord(parsed)) return {};
    const store: Record<string, DeviceProfile> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const profile = asStoredProfile(value);
      if (profile) store[key] = profile;
    }
    return store;
  } catch (err) {
    console.warn(`[zcode] device 指纹文件读取失败（将重建）: ${deviceFile}: ${(err as Error).message}`);
    return {};
  }
}

function saveStore(deviceFile: string, store: Record<string, DeviceProfile>): void {
  try {
    mkdirSync(dirname(deviceFile), { recursive: true });
    writeFileSync(deviceFile, JSON.stringify(store, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`[zcode] device 指纹文件写入失败: ${deviceFile}: ${(err as Error).message}`);
  }
}

/**
 * 取 JWT sub 对应的设备档案：一号一台，已分配即稳定复用。
 * sub 为空时回退 darwin-arm64 常量（deviceMid 照样落盘复用，不做 telemetry 上报）。
 */
export function profileForJwt(sub: string | null, deviceFile: string): DeviceProfile {
  const store = loadStore(deviceFile);
  if (!sub) {
    const existing = store[ANONYMOUS_KEY];
    if (existing) return existing;
    const created = fallbackProfile(randomUUID());
    store[ANONYMOUS_KEY] = created;
    saveStore(deviceFile, store);
    return created;
  }
  const existing = store[sub];
  if (existing) {
    try {
      assertValid(existing);
      return existing;
    } catch {
      // 存量非 SKU 档案（旧版形态）→ 换成生成 SKU
    }
  }
  const created = randomProfile();
  store[sub] = created;
  saveStore(deviceFile, store);
  return created;
}
