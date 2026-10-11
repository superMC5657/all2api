import { extractStreamFlag, rewriteModel } from "./types.js";
import type { UpstreamResult } from "./types.js";

/**
 * Provider Forward 公共胶水（架构候选 #1）。
 *
 * 收拢各 client 重复的 Forward 形状：
 *   stream-flag 检查 → rewriteModel → send → aggregate-or-passthrough → Translate，
 * 以及 timeout/signal/stream_options 样板。
 *
 * 约定：
 * - 只收无争议的样板；超时值、URL、header 差异留在各 adapter（行为语义保持各家原样）。
 * - 本模块不碰磁盘/网络，只做纯组装 + Response→UpstreamResult 映射；
 *   各 provider 的特殊分支（codebuddy 矩阵、trae/trae-cn 归一化、zcode start-plan、
 *   qoder sidecar）仍在各自 client 内。
 * - ProviderAdapter 对外 3 方法签名不变（见 ./types.ts）。
 */

/** 400 透传体（trae-cn / zcode 两处同形，收拢一处）。 */
export function badRequest(message: string): UpstreamResult {
  return {
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: { message, type: "invalid_request_error" } }),
  };
}

/**
 * 流式请求不设整体超时，由客户端断连驱动取消；非流式保留超时。
 * 每次 fetch 前新建（AbortSignal.timeout 从创建起点计时，复用会导致 401 重试误报超时）。
 */
export function streamSignal(timeoutMs: number, wantsStream: boolean): AbortSignal | undefined {
  return wantsStream ? undefined : AbortSignal.timeout(timeoutMs);
}

/** 缺省即附带 stream_options（非流时上游忽略，流式时要求上游附带 usage 终帧）。 */
export function ensureStreamOptions(body: Record<string, unknown>): void {
  if (!body["stream_options"]) body["stream_options"] = { include_usage: true };
}

/** OpenAI body 的 stream 意图（`stream === true` 才算流式）。 */
export function wantsStreamFromOpenAIBody(body: Record<string, unknown>): boolean {
  return body["stream"] === true;
}

/** Anthropic 侧的 stream 意图（原 rawBody 标记或转译后 openaiBody.stream）。 */
export function wantsStreamForAnthropic(rawBody: string, openaiBody: { stream?: unknown }): boolean {
  return extractStreamFlag(rawBody) || openaiBody.stream === true;
}

/**
 * rewriteModel 后解析为对象（codebuddy openai 形：原语义为
 * `JSON.parse(rewriteModel(rawBody, model))`，非法 JSON 直接抛，由上层按原路径处理）。
 */
export function rewriteModelToObject(rawBody: string, model: string): Record<string, unknown> {
  return JSON.parse(rewriteModel(rawBody, model)) as Record<string, unknown>;
}

/**
 * 宽容解析：非法 JSON / 非对象一律返回 null，调用方按原语义回 badRequest
 *（trae-cn / zcode 形；codebuddy/qoder 的抛错路径保持不动，不用此函数）。
 */
export function tryParseJsonObject(rawBody: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** 上游非 2xx 透传（保留原 status + content-type，body 为已读文本）。 */
export function upstreamError(res: Response, text: string): UpstreamResult {
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "application/json",
    body: text,
  };
}

/** 200 JSON 回包。 */
export function okJson(payload: unknown): UpstreamResult {
  return { status: 200, contentType: "application/json", body: JSON.stringify(payload) };
}

/** 200 SSE 回包（string 便于单包合成，ReadableStream 便于透传/转译流）。 */
export function okStream(body: ReadableStream<Uint8Array> | string): UpstreamResult {
  return { status: 200, contentType: "text/event-stream", body };
}

/** 读尽上游流为文本（zcode openai 非流/错误映射用，原语义照搬）。 */
export async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    reader.releaseLock();
  }
}
