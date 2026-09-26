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

import { randomUUID } from "node:crypto";

import { jwtUserId, transformBody, type AnthropicBody } from "./body-transform.js";
export type { AnthropicBody } from "./body-transform.js";
import {
  ANTHROPIC_VERSION,
  CAPTCHA_BODY_MARKERS,
  CAPTCHA_HEADER,
  CAPTCHA_REGION_HEADER,
  EXHAUST_HTTP_STATUSES,
  EXHAUST_KEYWORDS,
  MAX_TOKENS_LIMIT,
  MESSAGES_URL,
  MODEL_NAME_MAP,
  RETRY_429_WAIT_MAX_S,
  RISK_CONTROL_HTTP_STATUSES,
  RISK_CONTROL_MARKERS,
} from "./constants.js";
import { buildIdentityHeaders, buildTraceHeaders } from "./identity.js";
import type { DeviceProfile } from "./fingerprint.js";

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

// ── OpenAI 双向翻译最小集 ────────────────────────────────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
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
      outMsgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(record["tool_call_id"] ?? ""),
            content: textFromContent(content),
          },
        ],
      });
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

  const maxTokens = asInt(payload["max_tokens"] ?? payload["max_completion_tokens"]) ?? 4096;
  const body: AnthropicBody = { model, messages: outMsgs, max_tokens: maxTokens };
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

/** Anthropic message 响应 → OpenAI chat.completion。 */
export function anthropicToOpenai(data: Record<string, any>, model: string): Record<string, any> {
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, any>> = [];
  const content = data["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block == null || typeof block !== "object") continue;
      const b = block as Record<string, any>;
      if (b["type"] === "text" && typeof b["text"] === "string") textParts.push(b["text"] as string);
      else if (b["type"] === "tool_use") {
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
