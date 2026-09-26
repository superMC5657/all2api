import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { extractStreamFlag, rewriteModel, toUpstreamResult } from "../types.js";
import { anthropicToOpenAI, openAIToAnthropicResponse, translateOpenAIStreamToAnthropic } from "../../translate/anthropic.js";
import type { AnthropicRequest } from "../../translate/anthropic.js";
import { aggregateOpenAIStream } from "../../translate/openai-aggregate.js";
import type { CodeBuddyProviderConfig } from "../../config.js";
import { CodeBuddyCredentials } from "./credentials.js";

/**
 * CodeBuddy / WorkBuddy（腾讯）provider——直连 copilot.tencent.com。
 * 网关使用 OpenAI chat 协议并支持原生 tools，但只提供流式（streaming）响应，因此：
 *   - 客户端要流式   -> SSE 透传（OpenAI）或转译后的 SSE（Anthropic）
 *   - 客户端要非流式 -> 在本地聚合上游 SSE
 * Token 过期由 credentials 模块处理（自动刷新 + 写回）；
 * 遇到 401 会触发一次强制刷新 + 重试。
 */
export class CodeBuddyProvider implements ProviderAdapter {
  readonly id = "codebuddy";
  private readonly credentials: CodeBuddyCredentials;
  private readonly modelsList: string[];

  constructor(
    config: CodeBuddyProviderConfig,
    private readonly timeoutMs: number,
  ) {
    this.credentials = new CodeBuddyCredentials(undefined, undefined, config.userAgent);
    this.modelsList = config.models.length > 0 ? config.models : DEFAULT_MODELS;
  }

  async models(): Promise<string[]> {
    return this.modelsList;
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    const body = JSON.parse(rewriteModel(rawBody, model)) as Record<string, unknown>;
    const clientWantsStream = body["stream"] === true;
    // 网关只提供流式响应
    body["stream"] = true;
    if (!body["stream_options"]) body["stream_options"] = { include_usage: true };
    sanitizeToolChoice(body);

    const res = await this.send(JSON.stringify(body));
    if (!res.ok) {
      return { status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body: await res.text() };
    }
    if (clientWantsStream) return toUpstreamResult(res);
    const aggregated = await aggregateOpenAIStream(res.body as ReadableStream<Uint8Array>);
    return { status: 200, contentType: "application/json", body: JSON.stringify(aggregated) };
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    const req = JSON.parse(rawBody) as AnthropicRequest;
    req.model = model;
    const openaiBody = anthropicToOpenAI(req) as Record<string, unknown>;
    const clientWantsStream = extractStreamFlag(rawBody) || openaiBody["stream"] === true;
    openaiBody["stream"] = true;
    if (!openaiBody["stream_options"]) openaiBody["stream_options"] = { include_usage: true };
    sanitizeToolChoice(openaiBody);

    const res = await this.send(JSON.stringify(openaiBody));
    if (!res.ok) {
      return { status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body: await res.text() };
    }
    if (clientWantsStream) {
      return {
        status: 200,
        contentType: "text/event-stream",
        body: translateOpenAIStreamToAnthropic(res.body as ReadableStream<Uint8Array>, model),
      };
    }
    const aggregated = await aggregateOpenAIStream(res.body as ReadableStream<Uint8Array>);
    return { status: 200, contentType: "application/json", body: JSON.stringify(openAIToAnthropicResponse(aggregated, model)) };
  }

  private async send(body: string): Promise<Response> {
    const headers = await this.credentials.headers();
    let res = await fetch(this.chatUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401) {
      await this.credentials.refresh();
      res = await fetch(this.chatUrl, {
        method: "POST",
        headers: await this.credentials.headers(),
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    }
    return res;
  }

  private readonly chatUrl = "https://copilot.tencent.com/v2/chat/completions";
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
  if (typeof choice === "string") return;
  if (choice === null) {
    delete body["tool_choice"];
    return;
  }
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
