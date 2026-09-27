/**
 * Start Plan (JWT) 通道上游常量收口。
 *
 * Python 对照：app/constants.py（ZCODE_ORIGIN、MESSAGES_PATHS、MODEL_NAME_MAP、
 * MAX_TOKENS_LIMIT、验证码头名、CLIENT_APP_VERSION=3.14.3）。
 * 模块代码禁止硬编码上游 URL / 模型名 / 关键字，一律 import 本模块。
 */

// ── 上游 origin / 端点 ──────────────────────────────────────────────────────
// Plan 通道（JWT + 验证码）：zcode.z.ai 的 coding-plan 代理端点。
// Anthropic 与 OpenAI 双协议统一走这一个端点（OpenAI 先转 Anthropic 再发）。
export const ZCODE_ORIGIN = "https://zcode.z.ai";
export const MESSAGES_PATH = "/api/v1/zcode-plan/anthropic/v1/messages";
export const MESSAGES_URL = `${ZCODE_ORIGIN}${MESSAGES_PATH}`;

// ── 客户端版本（单一真相源：官方桌面端现行版 3.14.3，仅找不到本地安装时回落用）────────────────────────
export const CLIENT_APP_VERSION_DEFAULT = "3.14.3";
export const CLIENT_CONFIGS_URL = `${ZCODE_ORIGIN}/api/v1/client/configs`;
export function clientConfigsUrl(appVersion: string): string {
  return `${CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}`;
}

// ── 验证码默认配置（client/configs 拉取失败时的兜底）────────────────────────
export const CAPTCHA_DEFAULTS = {
  enabled: true,
  prefix: "no8xfe",
  region: "cn",
  sceneId: "11xygtvd",
} as const;

// ── 模型名（上游大小写敏感；小写别名 → 官方名）──────────────────────────────
export const MODEL_NAME_MAP: Record<string, string> = {
  "glm-5.3-flash": "GLM-5.3-Flash",
  "glm-5.3": "GLM-5.3",
  "glm-5.2": "GLM-5.2",
  "glm-5-turbo": "GLM-5-Turbo",
  "glm-turbo": "GLM-5-Turbo",
  "glm-5.1": "GLM-5.1",
  "glm-4.7": "GLM-4.7",
};

// 上游 max_tokens 合法范围（超限报 400 code 1210）
export const MAX_TOKENS_LIMIT = 131072;

// ── 请求头 ──────────────────────────────────────────────────────────────────
export const ANTHROPIC_VERSION = "2023-06-01";
export function userAgent(appVersion: string): string {
  return `ZCode/${appVersion}`;
}
export const X_ZCODE_AGENT = "glm";
export const HTTP_REFERER = "https://zcode.z.ai/";
export const CAPTCHA_HEADER = "X-Aliyun-Captcha-Verify-Param";
export const CAPTCHA_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";

// ── 身份头仿真（darwin-arm64 桌面身份）───────────────────────────────────────
export const IDENTITY_TITLE = "Z Code@electron";
export const IDENTITY_RELEASE_CHANNEL = "stable";
export const IDENTITY_CLIENT_LANGUAGE = "zh-CN";
export const IDENTITY_CLIENT_TIMEZONE = "Asia/Shanghai";
export const IDENTITY_OS_VERSION = "25.5.0";

// ── 上游被拒信号 → 动作判定 ─────────────────────────────────────────────────
export const EXHAUST_HTTP_STATUSES = [402];
export const EXHAUST_KEYWORDS = ["quota", "insufficient", "balance", "exhaust", "额度", "余额不足"];
// 验证码挑战：HTTP 403 + 文案，或 HTTP 400/403 + body {"code":3007}
export const CAPTCHA_BODY_MARKERS = ['"code":3007', '"code": 3007'];
// 风控：3012「unusual activity」（HTTP 405 承载）
export const RISK_CONTROL_HTTP_STATUSES = [405];
export const RISK_CONTROL_MARKERS = ['"code":3012', '"code": 3012', "unusual activity"];

// ── 重试预算（单账号，无换号）───────────────────────────────────────────────
export const MAX_CAPTCHA_RETRIES = 3;
export const MAX_429_RETRIES = 5;
export const RETRY_429_DEFAULT_WAIT_S = 60;
export const RETRY_429_WAIT_MAX_S = 120; // Retry-After 采信上限（防吊死客户端）
export const MAX_5XX_RETRIES = 3;
export const RETRY_5XX_WAIT_MS = 5_000;
