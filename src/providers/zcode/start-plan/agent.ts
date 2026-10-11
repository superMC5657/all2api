/**
 * 上游请求构建 + OpenAI 双向翻译最小集 + 错误分类。
 *
 * Python 对照：
 *  - app/agent.py（build_request：JWT vs fallback 分叉、_DROP_HEADERS 清洗、
 *    Anthropic 一律走 zcode-plan、stream 透传）。本期只保留 JWT 通道
 *    （fallback 按量通道已移除，无 JWT 直接抛错，由 client.ts 保证先行校验）。
 *  - app/routes/gateway.py（_normalize_body：别名小写映射 + max_tokens 钳制
 *    [1,131072] + messages str 桥接；_detect_captcha_challenge / _is_exhausted /
 *    _is_risk_control / _parse_retry_after 错误分类）。
 *  - app/openai_compat.py（openai_to_anthropic / anthropic_to_openai /
 *    StreamConverter 双向翻译最小集）。
 */

/**
 * Start Plan 内核（agent）：上游请求构建 + OpenAI 双向翻译最小集 + 错误分类
 * + 一次 dispatchAnthropic Forward 所需的全部扇出收口。
 *
 * client.ts 只依赖本模块（+ credentials）：JWT、身份/trace 头、body 变换、
 * 验证码重试、429/5xx 重试均收进本模块的 dispatchStartPlan / 上下文解析之后，
 * 不再直引 identity / version / constants / body-transform / captcha /
 * fingerprint。identity.ts / version.ts 仅留 re-export 兼容层，真实实现归本模块。
 *
 * Python 对照：
 *  - app/agent.py（build_request：JWT vs fallback 分叉、_DROP_HEADERS 清洗、
 *    Anthropic 一律走 zcode-plan、stream 透传）。本期只保留 JWT 通道
 *    （fallback 按量通道已移除，无 JWT 直接抛错，由 client.ts 保证先行校验）。
 *  - app/routes/gateway.py（_normalize_body：别名小写映射 + max_tokens 钳制
 *    [1,131072] + messages str 桥接；_detect_captcha_challenge / _is_exhausted /
 *    _is_risk_control / _parse_retry_after 错误分类）。
 *  - app/openai_compat.py（openai_to_anthropic / anthropic_to_openai /
 *    StreamConverter 双向翻译最小集）。
 *  - app/identity.py（12 身份头 + 3 trace 头，已折叠进本模块，identity.ts 只留 re-export）。
 *  - app/constants.py（CLIENT_APP_VERSION 等纯数据仍由 constants.ts 拥有，本模块只消费不复制）。
 *  - version 探测（注册表 > exe > runtime，已折叠进本模块，version.ts 只留 re-export）。
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { jwtUserId, transformBody, type AnthropicBody } from "./body-transform.js";
export type { AnthropicBody } from "./body-transform.js";
import {
  ANTHROPIC_VERSION,
  CAPTCHA_BODY_MARKERS,
  CAPTCHA_HEADER,
  CAPTCHA_REGION_HEADER,
  CLIENT_APP_VERSION_DEFAULT,
  EXHAUST_HTTP_STATUSES,
  EXHAUST_KEYWORDS,
  HTTP_REFERER,
  IDENTITY_CLIENT_LANGUAGE,
  IDENTITY_CLIENT_TIMEZONE,
  IDENTITY_OS_VERSION,
  IDENTITY_RELEASE_CHANNEL,
  IDENTITY_TITLE,
  MAX_429_RETRIES,
  MAX_5XX_RETRIES,
  MAX_CAPTCHA_RETRIES,
  MAX_TOKENS_LIMIT,
  MESSAGES_URL,
  MODEL_NAME_MAP,
  RETRY_429_DEFAULT_WAIT_S,
  RETRY_429_WAIT_MAX_S,
  RETRY_5XX_WAIT_MS,
  RISK_CONTROL_HTTP_STATUSES,
  RISK_CONTROL_MARKERS,
  X_ZCODE_AGENT,
  userAgent,
} from "./constants.js";
import type { DeviceProfile } from "./fingerprint.js";
import { profileForJwt, resolveDeviceFile as resolveDeviceFileImpl } from "./fingerprint.js";
import { getVerifyParam } from "./captcha.js";
import { ProviderError, toUpstreamResult } from "../../types.js";
import { upstreamError } from "../../base.js";

// ── 身份头仿真（折叠自 identity.ts；语义原样，调用方经由本模块） ─────────────
// 官方 ZCode 桌面端 companion 头集合。身份头顺序（固定）：
//   HTTP-Referer, User-Agent, X-ZCode-App-Version, X-Title, X-ZCode-Agent,
//   X-Platform, X-Release-Channel, X-Client-Language, X-Client-Timezone,
//   X-Os-Category, X-Os-Version, X-Device-Mid
// 追踪头（每请求全新 UUID，仅以下三个）：
//   x-request-id / x-zcode-session-type / x-zcode-trace-id
// 禁发 x-query-id / x-session-id（start-plan 通道误发触发上游 3012）。

// 可见 ASCII 门：任何头值不含此形态即丢弃该头
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

function clean(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function osCategory(platform: string): string {
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "win32" || platform === "windows") return "windows";
  return "linux";
}

/** 构建完整身份头（保持官方字段顺序；非法值整头丢弃）。 */
export function buildIdentityHeaders(profile: DeviceProfile, appVersion: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const set = (key: string, value: string | undefined): void => {
    if (value) headers[key] = value;
  };
  set("HTTP-Referer", clean(HTTP_REFERER));
  set("User-Agent", clean(userAgent(appVersion)));
  set("X-ZCode-App-Version", clean(appVersion));
  set("X-Title", clean(IDENTITY_TITLE));
  set("X-ZCode-Agent", clean(X_ZCODE_AGENT));
  set("X-Platform", clean(`${profile.platform}-${profile.arch}`));
  set("X-Release-Channel", clean(IDENTITY_RELEASE_CHANNEL));
  set("X-Client-Language", clean(profile.language || IDENTITY_CLIENT_LANGUAGE));
  set("X-Client-Timezone", clean(profile.timezone || IDENTITY_CLIENT_TIMEZONE));
  set("X-Os-Category", clean(osCategory(profile.platform)));
  set("X-Os-Version", clean(profile.osVersion || IDENTITY_OS_VERSION));
  set("X-Device-Mid", clean(profile.deviceMid));
  return headers;
}

/**
 * 追踪头：每请求全新 UUID。
 * start-plan（JWT 通道）只发这三个头，永不发 x-query-id / x-session-id。
 */
export function buildTraceHeaders(): Record<string, string> {
  return {
    "x-request-id": randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": randomUUID(),
  };
}

// ── 桌面端版本号探测（折叠自 version.ts；语义原样，调用方经由本模块） ─────────
// 显式优先顺序：configVersion > ZCODE_APP_VERSION 环境变量 > 本地探测
// （注册表 > exe > runtime）> null（调用方回落 CLIENT_APP_VERSION_DEFAULT）。
// 同步构造、永不 throw：探测失败一律返回 null。
// 缓存只缓存探测成功值；显式值（config/env）每次现算、bypass 缓存。

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

// ── body 归一 ────────────────────────────────────────────────────────────────

/** 别名小写映射 + max_tokens 钳制[1,131072] + messages str 桥接。 */
export function normalizeBody(body: AnthropicBody): AnthropicBody {
  const rawModel = body["model"];
  if (typeof rawModel === "string") {
    const withoutPrefix = rawModel.includes("/") ? rawModel.split("/").slice(1).join("/") : rawModel;
    body["model"] = MODEL_NAME_MAP[withoutPrefix.toLowerCase()] ?? withoutPrefix;
  }

  const raw = body["max_tokens"];
  if (raw != null && typeof raw !== "boolean") {
    const num = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(num)) {
      const mt = Math.trunc(num);
      const clamped = Math.max(1, Math.min(mt, MAX_TOKENS_LIMIT));
      if (clamped !== mt) {
        console.warn(`[zcode] max_tokens ${mt} 超出上游范围 [1,${MAX_TOKENS_LIMIT}]，钳制为 ${clamped}`);
      }
      body["max_tokens"] = clamped;
    }
  }

  const messages = body["messages"];
  if (Array.isArray(messages)) {
    body["messages"] = messages.map((msg) => {
      if (msg != null && typeof msg === "object" && !Array.isArray(msg)) {
        const record = msg as Record<string, any>;
        if (typeof record["content"] === "string") {
          return { ...record, content: [{ type: "text", text: record["content"] }] };
        }
      }
      return msg;
    });
  }
  return body;
}

// ── 透传客户端 header 时需要剔除的字段 ───────────────────────────────────────

const DROP_HEADERS = new Set([
  "host",
  "content-length",
  "x-api-key",
  "authorization",
  "user-agent",
  "http-referer",
  "referer",
  "origin",
  "cookie",
  "accept",
  "accept-language",
  "accept-encoding",
  "connection",
  "true-client-ip",
  "x-original-forwarded-for",
  // 身份/追踪头由本服务仿真生成，禁止客户端透传覆盖（指纹一致性）
  "x-device-mid",
  "x-request-id",
  "x-zcode-trace-id",
  "x-zcode-session-type",
  "x-query-id",
  "x-session-id",
  "x-title",
  "x-platform",
  "x-release-channel",
  "x-client-language",
  "x-client-timezone",
  "x-os-category",
  "x-os-version",
]);

// 前缀剔除：本服务仿真的头族 + 客户端 SDK 特征头族 + 反代/CDN 基础设施头
const DROP_HEADER_PREFIXES = ["x-zcode", "x-stainless", "x-forwarded", "forwarded", "x-real-ip", "via", "cf-", "cdn-loop"];

function shouldDropHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (DROP_HEADERS.has(lower)) return true;
  return DROP_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// ── 上游请求构建（JWT 通道唯一） ─────────────────────────────────────────────

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  payload: string;
}

/**
 * 构建 Start Plan 上游请求（Anthropic 一律走 zcode-plan；stream 透传由调用方处理）。
 * body 变换幂等，验证码重试时用同一 body 重建请求安全。
 */
export function buildUpstreamRequest(opts: {
  jwt: string;
  profile: DeviceProfile;
  appVersion: string;
  body: AnthropicBody;
  verifyParam?: string | null;
  verifyRegion?: string | null;
  incomingHeaders?: Record<string, string>;
}): UpstreamRequest {
  const { jwt, profile, appVersion, verifyParam, verifyRegion, incomingHeaders } = opts;
  const body = opts.body;

  const userId = jwtUserId(jwt);
  const model = typeof body["model"] === "string" ? (body["model"] as string) : null;
  transformBody(body, userId, model);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${jwt}`,
    "anthropic-version": ANTHROPIC_VERSION,
    ...buildIdentityHeaders(profile, appVersion),
    ...buildTraceHeaders(),
  };
  if (verifyParam) headers[CAPTCHA_HEADER] = verifyParam;
  if (verifyRegion) headers[CAPTCHA_REGION_HEADER] = verifyRegion;

  for (const [key, value] of Object.entries(incomingHeaders ?? {})) {
    if (shouldDropHeader(key)) continue;
    headers[key] = value;
  }

  return { url: MESSAGES_URL, headers, payload: JSON.stringify(body) };
}

// ── 错误分类 ─────────────────────────────────────────────────────────────────

function headerValue(headers: Headers, name: string): string | null {
  const direct = headers.get(name);
  if (direct) return direct;
  // Headers 对大小写不敏感，get 已覆盖；保留兜底遍历
  let found: string | null = null;
  headers.forEach((value, key) => {
    if (key.toLowerCase() === name.toLowerCase()) found = value;
  });
  return found;
}

/**
 * 验证码挑战三形态（对齐 Python _detect_captcha_challenge）：
 *  1. 响应头 X-Aliyun-Captcha-Verify-Param 存在
 *  2. HTTP 400/403 + body {"code":3007}
 *  3. HTTP 403 + 文案 captcha/verify
 * 命中返回标记，否则 null。
 */
export function detectCaptchaChallenge(status: number, text: string, headers: Headers): string | null {
  const headerVal = headerValue(headers, CAPTCHA_HEADER);
  if (headerVal && headerVal.trim()) return "header";
  const low = text.toLowerCase();
  if ((status === 400 || status === 403) && CAPTCHA_BODY_MARKERS.some((m) => text.includes(m))) {
    return "in-body-3007";
  }
  if (status === 403 && (low.includes("captcha") || low.includes("verify token") || low.includes("verify failed"))) {
    return "text";
  }
  return null;
}

/** 额度耗尽：402，或 body 含额度关键词（429 优先走频控，不判耗尽）。 */
export function isExhausted(status: number, text: string): boolean {
  if (status === 429) return false;
  if ((EXHAUST_HTTP_STATUSES as number[]).includes(status)) return true;
  const low = text.toLowerCase();
  return EXHAUST_KEYWORDS.some((k) => low.includes(k.toLowerCase()));
}

/** 风控：405，或 body 含 3012/unusual activity 标记。 */
export function isRiskControl(status: number, text: string): boolean {
  if ((RISK_CONTROL_HTTP_STATUSES as number[]).includes(status)) return true;
  const low = text.toLowerCase();
  return RISK_CONTROL_MARKERS.some((m) => low.includes(m.toLowerCase()));
}

/** 解析 Retry-After（仅秒数形态；非正数不采信；超长封顶 120s）。 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return Math.min(Math.floor(secs), RETRY_429_WAIT_MAX_S);
}

// ── Start Plan 调度内核（收拢自 client.ts dispatchAnthropic） ──────────────────
// 一次 Forward 所需的 JWT / 身份-trace 头 / body 变换 / 验证码重试 / 429-5xx
// 重试全部收进本接口之后，client.ts 只调 dispatchStartPlan，不再直引
// body-transform / captcha / fingerprint / version / constants。
// body 原地 mutation 语义、全局 captcha 池、device-file 落盘语义均保持原样
// （经由 transformBody / getVerifyParam / profileForJwt 透传）。

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartPlanForwardOptions {
  jwt: string;
  appVersion: string;
  deviceFile: string;
  timeoutMs: number;
}

/**
 * 解析最终 appVersion（含默认回落）：config 显式值 > 环境变量 > 本地探测 >
 * CLIENT_APP_VERSION_DEFAULT。client 构造时经由本函数，不再直引 version/constants。
 */
export function resolveStartPlanAppVersion(configVersion?: string): string {
  return resolveZCodeAppVersion({ configVersion }) ?? CLIENT_APP_VERSION_DEFAULT;
}

/** 解析 device 指纹文件路径（fingerprint.store 的薄转发，调用方经由本模块）。 */
export function resolveStartPlanDeviceFile(configured?: string): string {
  return resolveDeviceFileImpl(configured);
}

/**
 * 单账号调度：成功或 4xx 回传时返回 UpstreamResult，其余按错误语义抛 ProviderError。
 * 语义与原 client.ts dispatchAnthropic 逐行一致：
 *  - 验证码挑战：换码重试最多 3 次
 *  - 402/额度关键词 → EXHAUSTED，直接抛 402
 *  - 429：按 Retry-After（封顶 120s）原地重试最多 5 次
 *  - 401/403（非验证码）→ INVALID，直接抛
 *  - 405/3012 → DISABLED（风控），直接抛
 *  - 5xx：重试 3 次（间隔 5s）
 *  - 其他 4xx：原样回传
 */
export async function dispatchStartPlan(
  body: AnthropicBody,
  opts: StartPlanForwardOptions,
): Promise<import("../../types.js").UpstreamResult> {
  const { jwt, appVersion, deviceFile, timeoutMs } = opts;
  const profile = profileForJwt(jwtUserId(jwt), deviceFile);
  let verifyParam: string | null = null;
  let verifyRegion: string | null = null;
  let captchaRetries = 0;
  let retries429 = 0;
  let retries5xx = 0;

  for (;;) {
    const { url, headers, payload } = buildUpstreamRequest({
      jwt,
      profile,
      appVersion,
      body,
      verifyParam,
      verifyRegion,
    });

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 连接失败/超时按 5xx 类重试
      if (retries5xx < MAX_5XX_RETRIES) {
        retries5xx += 1;
        await sleep(RETRY_5XX_WAIT_MS);
        continue;
      }
      throw new ProviderError(
        `zcode: upstream request failed after ${MAX_5XX_RETRIES} retries: ${(err as Error).message}`,
        502,
      );
    }

    if (res.status < 400) return toUpstreamResult(res);

    const text = await res.text();

    // 验证码挑战：换码重试最多 3 次（solver 二期前多为空值重试）
    if (detectCaptchaChallenge(res.status, text, res.headers)) {
      captchaRetries += 1;
      if (captchaRetries > MAX_CAPTCHA_RETRIES) {
        throw new ProviderError(
          `zcode: captcha challenge unresolved after ${MAX_CAPTCHA_RETRIES} retries (upstream ${res.status}): ${text.slice(0, 500)}`,
          403,
        );
      }
      const token = await getVerifyParam(appVersion);
      verifyParam = token?.param ?? null;
      verifyRegion = token?.region ?? null;
      continue;
    }

    // 风控（3012/unusual activity / 405）→ DISABLED，直接抛
    if (isRiskControl(res.status, text)) {
      throw new ProviderError(
        `zcode: DISABLED — upstream risk control (status ${res.status}): ${text.slice(0, 500)}`,
        res.status,
      );
    }

    // 402/额度关键词 → EXHAUSTED，直接抛 402
    if (isExhausted(res.status, text)) {
      throw new ProviderError(
        `zcode: EXHAUSTED — plan quota used up (upstream ${res.status}): ${text.slice(0, 500)}`,
        402,
      );
    }

    // 401/403（已排除验证码挑战）→ INVALID，直接抛
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        `zcode: INVALID — upstream rejected credentials (status ${res.status}): ${text.slice(0, 500)}`,
        res.status,
      );
    }

    // 429：按 Retry-After（封顶 120s）原地重试最多 5 次
    if (res.status === 429) {
      if (retries429 < MAX_429_RETRIES) {
        retries429 += 1;
        const waitS = parseRetryAfter(res.headers.get("retry-after")) ?? RETRY_429_DEFAULT_WAIT_S;
        await sleep(waitS * 1000);
        continue;
      }
      throw new ProviderError(
        `zcode: rate limited, 429 retries exhausted (upstream 429): ${text.slice(0, 500)}`,
        429,
      );
    }

    // 5xx：重试 3 次（间隔 5s）
    if (res.status >= 500) {
      if (retries5xx < MAX_5XX_RETRIES) {
        retries5xx += 1;
        await sleep(RETRY_5XX_WAIT_MS);
        continue;
      }
      throw new ProviderError(
        `zcode: upstream error ${res.status} after ${MAX_5XX_RETRIES} retries: ${text.slice(0, 500)}`,
        502,
      );
    }

    // 其他 4xx：原样回传（收拢至 base.upstreamError，语义不变）。
    return upstreamError(res, text);
  }
}

// ── OpenAI 双向翻译最小集 ────────────────────────────────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
  // pause_turn 等未知值未显式映射，有意 fallback 到 "stop"（见各使用处的 ?? "stop"）。
};

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item != null && typeof item === "object") {
        const block = item as Record<string, unknown>;
        if (block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"] as string);
      }
    }
    return parts.filter(Boolean).join("\n");
  }
  return "";
}

function imageBlock(url: string): Record<string, any> | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const head = url.slice(5, comma);
  const b64 = url.slice(comma + 1);
  const mediaType = head.split(";")[0] || "image/png";
  if (!b64) return null;
  return { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } };
}

function blocksFromUserContent(content: unknown): Array<Record<string, any>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];
  const blocks: Array<Record<string, any>> = [];
  for (const item of content) {
    if (item == null || typeof item !== "object") continue;
    const block = item as Record<string, any>;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      blocks.push({ type: "text", text: block["text"] });
    } else if (block["type"] === "image_url") {
      const imageUrl = block["image_url"];
      const url = typeof imageUrl === "string" ? imageUrl : (imageUrl?.["url"] as string | undefined) ?? "";
      const image = imageBlock(String(url));
      if (image) blocks.push(image);
    }
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/** OpenAI reasoning 预算 → Anthropic thinking（上游 zcode-plan 为 Anthropic 兼容端）。
 * 优先透传 thinking={type:"enabled",budget_tokens} 形态；非法值静默忽略不抛错。 */
const REASONING_EFFORT_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
};

// ── output 上限识别（纯转发，不做任何自动加码） ───────────────────────────────
// output 类参数优先级：max_tokens > max_completion_tokens > max_output_tokens
//   > output_token_limit；非法值（非正整数）忽略并顺延下一优先级，0 穿透到下一优先级。
// 有显式用显式，无显式用 4096；仅做 [1,131072] 钳制+超限 warn。
// thinking 预算仅纯转发，绝不反过来改 max_tokens。
const OUTPUT_LIMIT_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens", "output_token_limit"] as const;

function explicitOutputLimit(payload: Record<string, any>): { value: number; key: string } | null {
  for (const key of OUTPUT_LIMIT_KEYS) {
    if (!(key in payload)) continue;
    const raw = payload[key];
    if (raw == null || typeof raw === "boolean") continue;
    const n = asInt(raw);
    if (n == null || n <= 0) continue;
    return { value: n, key };
  }
  return null;
}

function thinkingFromPayload(payload: Record<string, any>): Record<string, any> | null {
  const raw = payload["reasoning_effort"] ?? payload["reasoning"] ?? payload["thinking"];
  if (raw == null) return null;
  if (typeof raw === "string") {
    const eff = raw.trim().toLowerCase();
    if (!eff) return null;
    if (eff === "none" || eff === "disabled" || eff === "off") return { type: "disabled" };
    const budget = REASONING_EFFORT_BUDGET[eff];
    return budget != null ? { type: "enabled", budget_tokens: budget } : null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, any>;
    // 调用方直接给 Anthropic thinking 形态则原样透传（仅校验字段）
    if (typeof r["type"] === "string") {
      const t = String(r["type"]).toLowerCase();
      if (t === "disabled") return { type: "disabled" };
      if (t === "enabled") {
        const b = asInt(r["budget_tokens"] ?? r["budget"] ?? r["max_tokens"]);
        return b != null && b > 0 ? { type: "enabled", budget_tokens: b } : { type: "enabled", budget_tokens: 8192 };
      }
      return null;
    }
    const effortRaw = r["effort"] ?? r["level"];
    if (typeof effortRaw === "string") {
      const eff = effortRaw.trim().toLowerCase();
      if (!eff) return null;
      if (eff === "none" || eff === "disabled" || eff === "off") return { type: "disabled" };
      const budget = REASONING_EFFORT_BUDGET[eff];
      return budget != null ? { type: "enabled", budget_tokens: budget } : null;
    }
    const b = asInt(r["budget_tokens"] ?? r["budget"] ?? r["max_tokens"] ?? r["tokens"]);
    return b != null && b > 0 ? { type: "enabled", budget_tokens: b } : null;
  }
  return null;
}

/** OpenAI 请求体 → Anthropic messages 体。非法时返回 { error }。 */
export function openaiToAnthropic(
  payload: Record<string, any>,
): { body: AnthropicBody } | { error: string } {
  const model = payload["model"];
  if (typeof model !== "string" || !model.trim()) return { error: "必须提供 model 参数" };
  const messages = payload["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return { error: "必须提供 messages 数组" };

  const systemParts: string[] = [];
  const outMsgs: Array<Record<string, any>> = [];
  for (const msg of messages) {
    if (msg == null || typeof msg !== "object" || Array.isArray(msg)) continue;
    const record = msg as Record<string, any>;
    const role = record["role"];
    const content = record["content"];
    if (role === "system" || role === "developer") {
      const text = textFromContent(content);
      if (text) systemParts.push(text);
    } else if (role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: String(record["tool_call_id"] ?? ""),
        content: textFromContent(content),
      };
      // 连续 tool 消息合并为一条 user 消息的多 tool_result 块
      const prev = outMsgs[outMsgs.length - 1];
      if (
        prev != null &&
        prev["role"] === "user" &&
        Array.isArray(prev["content"]) &&
        (prev["content"] as Array<Record<string, any>>).length > 0 &&
        (prev["content"] as Array<Record<string, any>>).every((b) => b != null && b["type"] === "tool_result")
      ) {
        (prev["content"] as Array<Record<string, any>>).push(block);
      } else {
        outMsgs.push({ role: "user", content: [block] });
      }
    } else if (role === "assistant") {
      const blocks: Array<Record<string, any>> = [];
      const text = textFromContent(content);
      if (text) blocks.push({ type: "text", text });
      const toolCalls = record["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (tc == null || typeof tc !== "object") continue;
          const call = tc as Record<string, any>;
          const fn = call["function"];
          if (fn == null || typeof fn !== "object") continue;
          const func = fn as Record<string, any>;
          let args = func["arguments"];
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = { _raw: args };
            }
          }
          blocks.push({
            type: "tool_use",
            id: String(call["id"] ?? ""),
            name: String(func["name"] ?? ""),
            input: args != null && typeof args === "object" ? args : {},
          });
        }
      }
      outMsgs.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
    } else {
      // user 及未知角色一律按 user 处理
      outMsgs.push({ role: "user", content: blocksFromUserContent(content) });
    }
  }

  const thinking = thinkingFromPayload(payload);
  // max_tokens 纯转发：有显式用显式，无显式用 4096；仅做上限制钳制+超限 warn。
  // thinking 预算仅透传，绝不反过来改 max_tokens。
  const explicit = explicitOutputLimit(payload);
  let maxTokens: number;
  if (explicit != null) {
    if (explicit.value > MAX_TOKENS_LIMIT) {
      console.warn(`[zcode] max_tokens ${explicit.value} 超出上游范围 [1,${MAX_TOKENS_LIMIT}]，钳制为 ${MAX_TOKENS_LIMIT}`);
      maxTokens = MAX_TOKENS_LIMIT;
    } else {
      maxTokens = explicit.value;
    }
  } else {
    maxTokens = 4096;
  }
  const body: AnthropicBody = { model, messages: outMsgs, max_tokens: maxTokens };
  if (thinking) body["thinking"] = thinking;
  if (systemParts.length > 0) body["system"] = systemParts.join("\n\n");
  try {
    if (payload["temperature"] != null) body["temperature"] = Number(payload["temperature"]);
    if (payload["top_p"] != null) body["top_p"] = Number(payload["top_p"]);
  } catch {
    // 宽容：映射不了安静跳过
  }
  const stop = payload["stop"];
  if (typeof stop === "string" && stop) body["stop_sequences"] = [stop];
  else if (Array.isArray(stop) && stop.length > 0) body["stop_sequences"] = stop.map((s) => String(s));
  if (payload["stream"]) body["stream"] = true;

  const tools = payload["tools"];
  if (Array.isArray(tools) && tools.length > 0) {
    const mapped: Array<Record<string, any>> = [];
    for (const t of tools) {
      if (t == null || typeof t !== "object") continue;
      const fn = (t as Record<string, any>)["function"];
      if (fn != null && typeof fn === "object" && (fn as Record<string, any>)["name"]) {
        const func = fn as Record<string, any>;
        mapped.push({
          name: String(func["name"]),
          description: String(func["description"] ?? ""),
          input_schema:
            func["parameters"] != null && typeof func["parameters"] === "object"
              ? func["parameters"]
              : { type: "object" },
        });
      }
    }
    if (mapped.length > 0) body["tools"] = mapped;
  }

  const choice = payload["tool_choice"];
  if (choice === "none") {
    delete body["tools"];
  } else if (choice === "required") {
    body["tool_choice"] = { type: "any" };
  } else if (choice != null && typeof choice === "object" && (choice as Record<string, any>)["type"] === "function") {
    const name = String((choice as Record<string, any>)["function"]?.["name"] ?? "");
    if (name) body["tool_choice"] = { type: "tool", name };
  }
  // "auto"/缺省：Anthropic 默认即 auto，无需显式映射
  return { body };
}

/** Anthropic message 响应 → OpenAI chat.completion（thinking 透出为 reasoning_content）。 */
export function anthropicToOpenai(data: Record<string, any>, model: string): Record<string, any> {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Array<Record<string, any>> = [];
  const content = data["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block == null || typeof block !== "object") continue;
      const b = block as Record<string, any>;
      if (b["type"] === "text" && typeof b["text"] === "string") textParts.push(b["text"] as string);
      else if (b["type"] === "thinking" && typeof b["thinking"] === "string") thinkingParts.push(b["thinking"] as string);
      else if (b["type"] === "redacted_thinking") {
        const redacted = b["data"] ?? b["thinking"];
        if (typeof redacted === "string" && redacted) thinkingParts.push(redacted);
      } else if (b["type"] === "tool_use") {
        toolCalls.push({
          id: String(b["id"] ?? ""),
          type: "function",
          function: {
            name: String(b["name"] ?? ""),
            arguments: JSON.stringify(b["input"] ?? {}),
          },
        });
      }
    }
  }
  const usage = (data["usage"] as Record<string, any> | undefined) ?? {};
  const inTok = asInt(usage["input_tokens"]) ?? 0;
  const outTok = asInt(usage["output_tokens"]) ?? 0;
  const message: Record<string, any> = { role: "assistant", content: textParts.join("") || null };
  const reasoningText = thinkingParts.join("");
  if (reasoningText) message["reasoning_content"] = reasoningText;
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  return {
    id: String(data["id"] ?? `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(data["model"] ?? model),
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_REASON_MAP[String(data["stop_reason"] ?? "")] ?? "stop",
      },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

/**
 * Anthropic SSE 事件流 → OpenAI chat.completion.chunk 流（有状态转换器）。
 * 用法：先 start() 产出 role 首 chunk，逐条 feed(event) 收输出行，
 * 流结束后追加 done()（"data: [DONE]"）。
 */
export class StreamConverter {
  private readonly model: string;
  private chunkId: string;
  private readonly created: number;
  private finishReason: string | null = null;
  private readonly usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null } = {
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  };
  private toolSeq = 0;

  constructor(model: string) {
    this.model = model;
    this.chunkId = `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    this.created = Math.floor(Date.now() / 1000);
  }

  private syncUsageTotal(): void {
    const p = this.usage.prompt_tokens;
    const c = this.usage.completion_tokens;
    this.usage.total_tokens = p != null || c != null ? (p ?? 0) + (c ?? 0) : null;
  }

  start(): string {
    return this.chunk({ role: "assistant", content: "" });
  }

  done(): string {
    return "data: [DONE]\n\n";
  }

  feed(evt: Record<string, any>): string[] {
    const etype = evt["type"];
    if (etype === "message_start") {
      const msg = (evt["message"] as Record<string, any> | undefined) ?? {};
      if (msg["id"]) this.chunkId = String(msg["id"]);
      const usage = (msg["usage"] as Record<string, any> | undefined) ?? {};
      const prompt = asInt(usage["input_tokens"]);
      if (prompt != null) {
        this.usage.prompt_tokens = prompt;
        this.syncUsageTotal();
      }
      return [];
    }
    if (etype === "content_block_start") {
      const block = (evt["content_block"] as Record<string, any> | undefined) ?? {};
      // thinking/redacted_thinking 开始：不产出 chunk（避免污染 content），仅记录状态不断流
      if (block["type"] === "thinking" || block["type"] === "redacted_thinking") return [];
      if (block["type"] === "tool_use") {
        const idx = this.toolSeq;
        this.toolSeq += 1;
        return [
          this.chunk({
            tool_calls: [
              {
                index: idx,
                id: String(block["id"] ?? ""),
                type: "function",
                function: { name: String(block["name"] ?? ""), arguments: "" },
              },
            ],
          }),
        ];
      }
      return [];
    }
    if (etype === "content_block_delta") {
      const delta = (evt["delta"] as Record<string, any> | undefined) ?? {};
      // thinking 增量 → OpenAI reasoning_content：thinking 期不断流，agent 可见进度，
      // 且不污染 content/tool_calls。本地零依赖实现（不 import translate/ 目录）。
      if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
        if (!delta["thinking"]) return [];
        return [this.chunk({ reasoning_content: delta["thinking"] as string })];
      }
      // signature 为签名二进制/校验串，非思考文本：显式忽略，不透入 reasoning_content
      if (delta["type"] === "signature_delta") return [];
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        return [this.chunk({ content: delta["text"] as string })];
      }
      if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        return [
          this.chunk({
            tool_calls: [{ index: Math.max(this.toolSeq - 1, 0), function: { arguments: delta["partial_json"] as string } }],
          }),
        ];
      }
      return [];
    }
    if (etype === "message_delta") {
      const delta = (evt["delta"] as Record<string, any> | undefined) ?? {};
      this.finishReason = STOP_REASON_MAP[String(delta["stop_reason"] ?? "")] ?? "stop";
      const out = asInt((evt["usage"] as Record<string, any> | undefined)?.["output_tokens"]);
      if (out != null) {
        this.usage.completion_tokens = out;
        this.syncUsageTotal();
      }
      return [this.chunk({}, this.finishReason)];
    }
    return []; // content_block_stop / message_stop / ping / error 等无需产出
  }

  /**
   * 非流式 Anthropic 完整响应 → OpenAI SSE 全量合成（含文本/tool_calls/finish chunk）。
   * 供上游非流式却被要求流式时使用：首 role chunk + 内容 chunks + finish chunk + [DONE]。
   * finish chunk 携带 STOP_REASON_MAP 映射后原因（含 refusal→content_filter，未知 fallback stop）。
   */
  synthesize(data: Record<string, any>): string {
    if (typeof data["id"] === "string" && (data["id"] as string)) this.chunkId = String(data["id"]);
    const usage = (data["usage"] as Record<string, any> | undefined) ?? {};
    const prompt = asInt(usage["input_tokens"]);
    if (prompt != null) this.usage.prompt_tokens = prompt;
    const completion = asInt(usage["output_tokens"]);
    if (completion != null) this.usage.completion_tokens = completion;
    this.syncUsageTotal();

    let out = this.start();
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; args: string }> = [];
    const content = data["content"];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item == null || typeof item !== "object") continue;
        const b = item as Record<string, any>;
        if (b["type"] === "text" && typeof b["text"] === "string" && (b["text"] as string)) {
          textParts.push(b["text"] as string);
        } else if (b["type"] === "thinking" && typeof b["thinking"] === "string" && (b["thinking"] as string)) {
          thinkingParts.push(b["thinking"] as string);
        } else if (b["type"] === "redacted_thinking") {
          const redacted = b["data"] ?? b["thinking"];
          if (typeof redacted === "string" && redacted) thinkingParts.push(redacted);
        } else if (b["type"] === "tool_use") {
          toolCalls.push({
            id: String(b["id"] ?? ""),
            name: String(b["name"] ?? ""),
            args: JSON.stringify(b["input"] ?? {}),
          });
        }
      }
    }
    const reasoningText = thinkingParts.join("");
    if (reasoningText) out += this.chunk({ reasoning_content: reasoningText });
    const text = textParts.join("");
    if (text) out += this.chunk({ content: text });
    toolCalls.forEach((tc, idx) => {
      out += this.chunk({
        tool_calls: [
          {
            index: idx,
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.args },
          },
        ],
      });
    });
    // pause_turn 等未知 stop_reason 有意 fallback 到 "stop"，保证 finish chunk 必带原因。
    const finishReason = STOP_REASON_MAP[String(data["stop_reason"] ?? "")] ?? "stop";
    this.finishReason = finishReason;
    out += this.chunk({}, finishReason);
    out += this.done();
    return out;
  }

  private chunk(delta: Record<string, any>, finishReason: string | null = null): string {
    const payload: Record<string, any> = {
      id: this.chunkId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (finishReason != null) payload["usage"] = { ...this.usage };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
}
