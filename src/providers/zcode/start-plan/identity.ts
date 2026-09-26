/**
 * 上游身份头仿真 —— 镜像官方 ZCode 桌面端的 companion 头集合。
 *
 * Python 对照：app/identity.py（build_identity_headers 12 身份头顺序、
 * build_trace_headers 3 trace 头）。
 *
 * 身份头顺序（固定）：
 *   HTTP-Referer, User-Agent, X-ZCode-App-Version, X-Title, X-ZCode-Agent,
 *   X-Platform, X-Release-Channel, X-Client-Language, X-Client-Timezone,
 *   X-Os-Category, X-Os-Version, X-Device-Mid
 * 追踪头（每请求全新 UUID，仅以下三个）：
 *   x-request-id / x-zcode-session-type / x-zcode-trace-id
 * 禁发 x-query-id / x-session-id（start-plan 通道误发触发上游 3012）。
 */

import { randomUUID } from "node:crypto";

import {
  HTTP_REFERER,
  IDENTITY_CLIENT_LANGUAGE,
  IDENTITY_CLIENT_TIMEZONE,
  IDENTITY_OS_VERSION,
  IDENTITY_RELEASE_CHANNEL,
  IDENTITY_TITLE,
  X_ZCODE_AGENT,
  userAgent,
} from "./constants.js";
import type { DeviceProfile } from "./fingerprint.js";

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
