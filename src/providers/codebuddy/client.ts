import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { toUpstreamResult } from "../types.js";
import {
  ensureStreamOptions,
  okJson,
  okStream,
  rewriteModelToObject,
  streamSignal,
  upstreamError,
  wantsStreamForAnthropic,
  wantsStreamFromOpenAIBody,
} from "../base.js";
import { anthropicToOpenAI, openAIToAnthropicResponse, translateOpenAIStreamToAnthropic } from "../../translate/anthropic.js";
import type { AnthropicRequest } from "../../translate/anthropic.js";
import { aggregateOpenAIStream } from "../../translate/openai-aggregate.js";
import type { CodeBuddyProviderConfig } from "../../config.js";
import { CodeBuddyCredentials, chatUrlFor, normalizeRegion, type CodeBuddyRegion } from "./credentials.js";

/**
 * CodeBuddy / WorkBuddy（含海外 WorkBuddy AI / CodeBuddy AI）provider——base 按 auth.domain 经 pickBase 派生
 *（CN copilot.tencent.com；海外 workbuddy.ai / codebuddy.ai），路径同为 /v2/chat/completions。
 * 网关使用 OpenAI chat 协议并支持原生 tools，但只提供流式（streaming）响应，因此：
 *   - 客户端要流式   -> SSE 透传（OpenAI）或转译后的 SSE（Anthropic）
 *   - 客户端要非流式 -> 在本地聚合上游 SSE
 * Token 过期由 credentials 模块处理（自动刷新 + 写回）；
 * 遇到 401 会触发一次强制刷新 + 重试。
 *
 * 双开：providers.codebuddy（CN，id "codebuddy"）+ providers.codebuddyIntl（海外，id "codebuddy-intl"）
 * 可同时启用（对齐 qoder/qoderIntl、trae/trae-cn 模式）。第二实例经构造参 id 覆盖
 * （缺省按 region 派生：intl → "codebuddy-intl"，其余 → "codebuddy"）；models 照常。
 * 双开必须给两边配不同的 authDir（否则默认探测会撞到同一份 session）。
 */
export class CodeBuddyProvider implements ProviderAdapter {
  readonly id: string;
  private readonly credentials: CodeBuddyCredentials;
  private readonly modelsList: string[];
  private readonly region: CodeBuddyRegion;

  constructor(
    config: CodeBuddyProviderConfig,
    private readonly timeoutMs: number,
    idOverride?: string,
  ) {
    this.region = normalizeRegion(config.region);
    this.id = idOverride?.trim() || (this.region === "intl" ? "codebuddy-intl" : "codebuddy");
    this.credentials = new CodeBuddyCredentials(
      config.authDir?.trim() || undefined,
      config.electronPath?.trim() || config.electronBinary?.trim() || undefined,
      config.userAgent,
      config.keyBinding?.trim() || undefined,
      {
        dbPath: config.vscdbPath?.trim() || undefined,
        key: config.vscdbKey?.trim() || undefined,
        app: config.vscdbApp?.trim() || undefined,
        vscdbDir: config.vscdbDir?.trim() || undefined,
        region: this.region,
      },
      this.region,
    );
    this.modelsList = config.models.length > 0 ? config.models : DEFAULT_MODELS;
  }

  async models(): Promise<string[]> {
    return this.modelsList;
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    const body = rewriteModelToObject(rawBody, model);
    const clientWantsStream = wantsStreamFromOpenAIBody(body);
    // 网关只提供流式响应
    body["stream"] = true;
    ensureStreamOptions(body);
    sanitizeToolChoice(body);

    const res = await this.send(JSON.stringify(body), { stream: clientWantsStream });
    if (!res.ok) {
      return upstreamError(res, await res.text());
    }
    if (clientWantsStream) return toUpstreamResult(res);
    const aggregated = await aggregateOpenAIStream(res.body as ReadableStream<Uint8Array>);
    return okJson(aggregated);
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    const req = JSON.parse(rawBody) as AnthropicRequest;
    req.model = model;
    const openaiBody = anthropicToOpenAI(req) as Record<string, unknown>;
    const clientWantsStream = wantsStreamForAnthropic(rawBody, openaiBody);
    openaiBody["stream"] = true;
    ensureStreamOptions(openaiBody);
    sanitizeToolChoice(openaiBody);

    const res = await this.send(JSON.stringify(openaiBody), { stream: clientWantsStream });
    if (!res.ok) {
      return upstreamError(res, await res.text());
    }
    if (clientWantsStream) {
      return okStream(translateOpenAIStreamToAnthropic(res.body as ReadableStream<Uint8Array>, model));
    }
    const aggregated = await aggregateOpenAIStream(res.body as ReadableStream<Uint8Array>);
    return okJson(openAIToAnthropicResponse(aggregated, model));
  }

  private async send(body: string, opts: { stream: boolean }): Promise<Response> {
    // 流式请求不设整体超时，由客户端断连驱动取消；非流式保留超时。
    // 注意：每次 fetch 前新建 AbortSignal——AbortSignal.timeout 从创建起点计时，
    // 复用首次的 signal 会导致 401 重试时立即 TimeoutError（误报 502）。
    // 信号构造收拢至 base.streamSignal（语义不变：此处调用两次，各自新建）。
    const headers = await this.credentials.headers();
    const signal = streamSignal(this.timeoutMs, opts.stream);
    let res = await fetch(chatUrlFor(headers["x-domain"], this.region), {
      method: "POST",
      headers,
      body,
      ...(signal ? { signal } : {}),
    });
    if (res.status === 401) {
      // 重试前消费掉旧响应体，避免 socket 泄漏。
      await res.body?.cancel();
      await this.credentials.refresh();
      const retryHeaders = await this.credentials.headers();
      const retrySignal = streamSignal(this.timeoutMs, opts.stream);
      res = await fetch(chatUrlFor(retryHeaders["x-domain"], this.region), {
        method: "POST",
        headers: retryHeaders,
        body,
        ...(retrySignal ? { signal: retrySignal } : {}),
      });
    }
    return res;
  }
}

/**
 * 网关的 tool_choice 是纯字符串字段（"auto"/"none"/"required"）；
 * OpenAI/Anthropic 客户端发送的对象形式会被 400 拒绝
 *（code 11101，"cannot unmarshal object into ... tool_choice of type string"）。
 * 上游不支持按名称强制调用函数（Named-function forcing），因此降级为
 * "required"——模型仍能看到 tools 并自行选择其一。
 */
function sanitizeToolChoice(body: Record<string, unknown>): void {
  const choice = body["tool_choice"];
  if (choice === undefined) return;
  // 合法字符串原样透传。
  if (choice === "auto" || choice === "none" || choice === "required") return;
  if (choice === null) {
    delete body["tool_choice"];
    return;
  }
  // translate 只产出 { type: "function" }（按名强制，无名称字段）；上游不支持按名强制，
  // 与其他对象形式一律降级为 "required"——模型仍能看到 tools 并自行选择其一。
  body["tool_choice"] = "required";
}

const DEFAULT_MODELS = [
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "kimi-k2.7",
  "kimi-k2.6",
  "kimi-k2.5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "minimax-m3-pay",
  "hy3-preview-agent",
  "auto",
];
