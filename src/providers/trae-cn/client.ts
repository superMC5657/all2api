import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { extractStreamFlag, ProviderError } from "../types.js";
import { anthropicToOpenAI, openAIToAnthropicResponse, translateOpenAIStreamToAnthropic } from "../../translate/anthropic.js";
import type { AnthropicRequest } from "../../translate/anthropic.js";
import { aggregateOpenAIStream } from "../../translate/openai-aggregate.js";
import { TRAE_CN_AGENT_HOST, TRAE_CN_CHAT_PATH, TraeCnCredentials } from "./credentials.js";

/**
 * Trae CN（国内版）provider——直连 AgentHost 轻聊天入口。
 *
 *   POST {AGENT_HOST}/api/agent/v3/llm_utils_chat（明文 JSON）
 *   body: { function: "solo_work_lite", config_name: <model>, model: <model>,
 *           messages: [{role, content:[{type:"text",text}]}], stream: true }
 *   头：Authorization: Cloud-IDE-JWT <tok> + X-Cloudide-Token/X-Ide-Token/
 *       X-Uid/X-App-Id(6eefa01c-…) + X-Device-Id/X-Machine-Id/X-Ide-Version，
 *       UA Trae/<ver>（见 credentials.headers）。
 *
 * 出处：caigee-cmd/cli2api/internal/providers/trae/（credential.go+headers.go）、
 * smart-open/TraeWorkAssistant、Sliverkiss/traework2api。
 *
 * 首版范围：只做轻聊天族（solo_work_lite）+ 静态模型表；不碰 create_agent_task；
 * Intl AES-256-GCM agent v3（ProjectEio 路径）见 src/providers/trae/（留空）。
 *
 * 流式归一化策略：上游恒为流式。先把 Trae SSE 归一化为标准 OpenAI SSE
 *（OpenAI 形 data 帧透传并改写 model；其余从 content/text/delta 等字段
 * 提取文本增量合成 chunk），再复用现有转译器：
 *   - OpenAI 流式 → 归一化流透传；非流式 → aggregateOpenAIStream 聚合
 *   - Anthropic → anthropicToOpenAI 转请求 → 归一化流 → 转译/聚合回 Anthropic
 */

export interface TraeCnProviderConfig {
  enabled: boolean;
  /** 显式 token（最高优；留空走 TRAE_CN_API_TOKEN > ~/.trae_cn_token > storage.json）。 */
  apiToken?: string;
  /** 版本显式覆盖（TRAE SOLO CN / Trae CN；环境 TRAE_EDITION 同效，config 优先）。 */
  edition?: string;
  /** User 目录显式覆盖（环境 TRAE_CN_DATA_DIR 同效，config 优先）。 */
  dataDir?: string;
  /** IDE 版本显式覆盖（默认读 local_env.json / TRAE_IDE_VERSION）。 */
  ideVersion?: string;
  /** 整 UA 覆盖（默认 `Trae/<ver>`）。 */
  userAgent?: string;
  /** 非空即为模型白名单（为空用内置兜底；动态 get_detail_param 表待实机后接）。 */
  models: string[];
}

/** 兜底模型（静态；UgHost get_detail_param 动态表待实机后替换为拉取+白名单过滤）。 */
const DEFAULT_TRAE_CN_MODELS = ["auto"];

interface TraeChatMessage {
  role: string;
  content: Array<{ type: string; text: string }>;
}

/** OpenAI messages → Trae messages（content str→[{type:text}]；非文本块丢弃）。 */
function toTraeMessages(messages: unknown): TraeChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: TraeChatMessage[] = [];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const rec = m as Record<string, unknown>;
    const rawRole = typeof rec["role"] === "string" ? rec["role"] : "user";
    // Trae 轻聊天只认 user/assistant：system 并入 user 语义，tool/function 输出按 user 文本回放。
    const role = rawRole === "assistant" ? "assistant" : rawRole === "system" || rawRole === "tool" || rawRole === "function" ? "user" : rawRole;
    const content = rec["content"];
    if (typeof content === "string") {
      out.push({ role, content: [{ type: "text", text: content }] });
      continue;
    }
    if (Array.isArray(content)) {
      const parts: Array<{ type: string; text: string }> = [];
      for (const p of content) {
        if (typeof p !== "object" || p === null) continue;
        const pr = p as Record<string, unknown>;
        if (pr["type"] === "text" && typeof pr["text"] === "string") {
          parts.push({ type: "text", text: pr["text"] });
        } else if (typeof pr["text"] === "string") {
          parts.push({ type: "text", text: pr["text"] });
        }
        // image_url 等非文本块：轻聊天 MVP 丢弃（实机确认多模态字段后再补）。
      }
      out.push({ role, content: parts.length > 0 ? parts : [{ type: "text", text: "" }] });
      continue;
    }
    out.push({ role, content: [{ type: "text", text: content == null ? "" : String(content) }] });
  }
  return out;
}

/** 组装 llm_utils_chat 请求体（stream 恒 true，model→config_name+model）。 */
function buildTraeChatBody(model: string, openaiBody: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    function: "solo_work_lite",
    config_name: model,
    model,
    messages: toTraeMessages(openaiBody["messages"]),
    stream: true,
  };
  for (const key of ["temperature", "top_p", "max_tokens", "stop"]) {
    const v = openaiBody[key];
    if (v !== undefined) body[key] = v;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Trae SSE → 标准 OpenAI SSE 归一化
// ---------------------------------------------------------------------------

function openAIChunkEnvelope(model: string, id: string, created: number, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

/** 从 Trae 自定义帧提取文本增量（字段名按现网抓包补充，缺失返回 ""）。 */
export function extractTraeTextDelta(obj: Record<string, unknown>): string {
  const candidates: unknown[] = [
    obj["content"],
    obj["text"],
    obj["delta"],
    (obj["data"] as Record<string, unknown> | undefined)?.["content"],
    (obj["message"] as Record<string, unknown> | undefined)?.["content"],
    obj["answer"],
    obj["result"],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return "";
}

/** Trae 自定义结束信号（缺失返回 false，由 [DONE]/finish_reason 兜底）。 */
function isTraeDone(obj: Record<string, unknown>): boolean {
  if (obj["done"] === true || obj["is_end"] === true || obj["isEnd"] === true) return true;
  if (typeof obj["finish_reason"] === "string" && obj["finish_reason"]) return true;
  const status = obj["status"];
  if (status === "done" || status === "completed" || status === "finished" || status === "stop") return true;
  if (obj["event"] === "done") return true;
  return false;
}

/**
 * Trae SSE 流 → 标准 OpenAI SSE 流。
 * OpenAI 形 data 帧（含 choices）原样透传（改写 model 以对齐请求）；
 * 自定义帧提取文本增量合成 chunk；错误载荷直接抛（message 带上游原文）。
 */
export function normalizeTraeStreamToOpenAI(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const streamId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let finished = false;
  let sentRole = false;

  const emitText = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    const delta: Record<string, unknown> = sentRole ? { content: text } : { role: "assistant", content: text };
    sentRole = true;
    controller.enqueue(encoder.encode(openAIChunkEnvelope(model, streamId, created, delta, null)));
  };
  const emitDone = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (finished) return;
    finished = true;
    controller.enqueue(encoder.encode(openAIChunkEnvelope(model, streamId, created, {}, "stop")));
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  };

  const handlePayload = (controller: ReadableStreamDefaultController<Uint8Array>, payload: string): void => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") {
      if (trimmed === "[DONE]") emitDone(controller);
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // 畸形帧忽略
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return;
    const rec = obj as Record<string, unknown>;
    if (rec["error"] !== undefined && rec["error"] !== null) {
      const detail = typeof rec["error"] === "string" ? rec["error"] : JSON.stringify(rec["error"]);
      throw new Error(`trae-cn: upstream error: ${detail.slice(0, 500)}`);
    }
    const choices = rec["choices"];
    if (Array.isArray(choices)) {
      // OpenAI 形：透传并改写 model；终帧（finish_reason 非空）后收尾。
      if (typeof rec["model"] === "string") rec["model"] = model;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(rec)}\n\n`));
      const first = choices[0] as Record<string, unknown> | undefined;
      if (first && first["finish_reason"] !== undefined && first["finish_reason"] !== null) emitDone(controller);
      return;
    }
    const text = extractTraeTextDelta(rec);
    if (text) emitText(controller, text);
    if (isTraeDone(rec)) emitDone(controller);
  };

  const handleFrame = (controller: ReadableStreamDefaultController<Uint8Array>, frame: string): void => {
    const dataParts: string[] = [];
    for (const line of frame.split("\n")) {
      const t = line.trimStart();
      if (t.startsWith("data:")) dataParts.push(t.slice(5).trimStart());
    }
    if (dataParts.length === 0) return;
    // 单帧多行 data: 按 SSE 规范拼接；拼不出合法 JSON 则逐行回落。
    const joined = dataParts.join("\n");
    try {
      JSON.parse(joined);
      handlePayload(controller, joined);
      return;
    } catch {
      // 回落逐行
    }
    for (const part of dataParts) handlePayload(controller, part);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1 && !finished) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (frame.trim()) handleFrame(controller, frame);
            sep = buffer.indexOf("\n\n");
          }
          if (done || finished) break;
        }
        const tail = buffer.trim();
        if (tail && !finished) handleFrame(controller, tail);
        emitDone(controller);
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
    cancel() {
      void upstream.cancel();
    },
  });
}

/** 非 SSE 的单包 JSON 回包 → 标准 OpenAI SSE（接 normalize 复用聚合/转译）。 */
export function singleTraeJsonToOpenAIStream(text: string, model: string): ReadableStream<Uint8Array> {
  const streamId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    throw new ProviderError(`trae-cn: upstream returned non-JSON (non-SSE): ${text.slice(0, 500)}`, 502);
  }
  if (obj["error"] !== undefined && obj["error"] !== null && !Array.isArray(obj["choices"])) {
    const detail = typeof obj["error"] === "string" ? obj["error"] : JSON.stringify(obj["error"]);
    throw new ProviderError(`trae-cn: upstream error: ${detail.slice(0, 500)}`, 502);
  }
  const chunks: string[] = [];
  if (Array.isArray(obj["choices"])) {
    if (typeof obj["model"] === "string") obj["model"] = model;
    chunks.push(`data: ${JSON.stringify(obj)}\n\n`);
  } else {
    const delta = extractTraeTextDelta(obj);
    chunks.push(openAIChunkEnvelope(model, streamId, created, { role: "assistant", content: delta }, null));
    chunks.push(openAIChunkEnvelope(model, streamId, created, {}, "stop"));
  }
  chunks.push("data: [DONE]\n\n");
  const payload = chunks.join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class TraeCnProvider implements ProviderAdapter {
  readonly id = "trae-cn";
  private readonly credentials: TraeCnCredentials;
  private readonly modelsList: string[];
  private readonly chatUrl = `${TRAE_CN_AGENT_HOST}${TRAE_CN_CHAT_PATH}`;

  constructor(
    config: TraeCnProviderConfig,
    private readonly timeoutMs: number,
  ) {
    this.credentials = new TraeCnCredentials({
      apiToken: config.apiToken?.trim() || undefined,
      edition: config.edition?.trim() || undefined,
      dataDir: config.dataDir?.trim() || undefined,
      ideVersion: config.ideVersion?.trim() || undefined,
      userAgent: config.userAgent?.trim() || undefined,
    });
    this.modelsList = config.models.length > 0 ? config.models : DEFAULT_TRAE_CN_MODELS;
  }

  async models(): Promise<string[]> {
    return this.modelsList;
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      return badRequest('request body must be JSON with a "model" field');
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return badRequest('request body must be JSON with a "model" field');
    }
    const openaiBody = parsed as Record<string, unknown>;
    openaiBody["model"] = model;
    const clientWantsStream = openaiBody["stream"] === true;
    let upstream: Response;
    try {
      upstream = await this.send(JSON.stringify(buildTraeChatBody(model, openaiBody)), { stream: clientWantsStream });
    } catch (err) {
      throw err instanceof ProviderError ? err : new ProviderError(`trae-cn: upstream request failed: ${(err as Error).message}`, 502);
    }
    if (!upstream.ok) {
      return { status: upstream.status, contentType: upstream.headers.get("content-type") ?? "application/json", body: await upstream.text() };
    }
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.toOpenAIStream(upstream, model);
    } catch (err) {
      throw err instanceof ProviderError ? err : new ProviderError((err as Error).message, 502);
    }
    if (clientWantsStream) {
      return { status: 200, contentType: "text/event-stream", body: stream };
    }
    try {
      const aggregated = await aggregateOpenAIStream(stream);
      aggregated.model = model;
      return { status: 200, contentType: "application/json", body: JSON.stringify(aggregated) };
    } catch (err) {
      throw new ProviderError(`trae-cn: aggregate upstream stream failed: ${(err as Error).message}`, 502);
    }
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    let req: AnthropicRequest;
    try {
      req = JSON.parse(rawBody) as AnthropicRequest;
    } catch {
      return badRequest('request body must be JSON with a "model" field');
    }
    if (typeof req !== "object" || req === null || Array.isArray(req)) {
      return badRequest('request body must be JSON with a "model" field');
    }
    req.model = model;
    const openaiBody = anthropicToOpenAI(req) as Record<string, unknown>;
    const clientWantsStream = extractStreamFlag(rawBody) || openaiBody["stream"] === true;
    let upstream: Response;
    try {
      upstream = await this.send(JSON.stringify(buildTraeChatBody(model, openaiBody)), { stream: clientWantsStream });
    } catch (err) {
      throw err instanceof ProviderError ? err : new ProviderError(`trae-cn: upstream request failed: ${(err as Error).message}`, 502);
    }
    if (!upstream.ok || upstream.body === null) {
      return { status: upstream.status, contentType: upstream.headers.get("content-type") ?? "application/json", body: await upstream.text() };
    }
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.toOpenAIStream(upstream, model);
    } catch (err) {
      throw err instanceof ProviderError ? err : new ProviderError((err as Error).message, 502);
    }
    if (clientWantsStream) {
      return { status: 200, contentType: "text/event-stream", body: translateOpenAIStreamToAnthropic(stream, model) };
    }
    try {
      const aggregated = await aggregateOpenAIStream(stream);
      aggregated.model = model;
      return { status: 200, contentType: "application/json", body: JSON.stringify(openAIToAnthropicResponse(aggregated, model)) };
    } catch (err) {
      throw new ProviderError(`trae-cn: aggregate upstream stream failed: ${(err as Error).message}`, 502);
    }
  }

  /** 上游响应 → 标准 OpenAI SSE（SSE 归一化；单包 JSON 合成；空体 502）。 */
  private async toOpenAIStream(res: Response, model: string): Promise<ReadableStream<Uint8Array>> {
    const contentType = res.headers.get("content-type") ?? "";
    if (res.body !== null && (contentType.includes("text/event-stream") || contentType.includes("stream"))) {
      return normalizeTraeStreamToOpenAI(res.body as ReadableStream<Uint8Array>, model);
    }
    if (res.body === null) {
      throw new ProviderError("trae-cn: upstream returned empty body", 502);
    }
    const text = await res.text();
    if (!text.trim()) throw new ProviderError("trae-cn: upstream returned empty response", 502);
    return singleTraeJsonToOpenAIStream(text, model);
  }

  private async send(body: string, opts: { stream: boolean }): Promise<Response> {
    // 流式请求不设整体超时，由客户端断连驱动取消；非流式保留超时。
    // 每次 fetch 前新建 signal，避免复用已计时的 signal 导致重试误报超时。
    const signal = opts.stream ? undefined : AbortSignal.timeout(this.timeoutMs);
    const headers = await this.credentials.headers();
    try {
      return await fetch(this.chatUrl, {
        method: "POST",
        headers,
        body,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new ProviderError(`trae-cn: upstream request failed: ${(err as Error).message}`, 502);
    }
  }
}

function badRequest(message: string): UpstreamResult {
  return {
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: { message, type: "invalid_request_error" } }),
  };
}
