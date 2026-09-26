import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { extractStreamFlag, rewriteModel, toUpstreamResult } from "../types.js";
import { anthropicToOpenAI, openAIToAnthropicResponse, translateOpenAIStreamToAnthropic } from "../../translate/anthropic.js";
import type { AnthropicRequest } from "../../translate/anthropic.js";
import { aggregateOpenAIStream } from "../../translate/openai-aggregate.js";
import type { CodeBuddyProviderConfig } from "../../config.js";
import { CodeBuddyCredentials } from "./credentials.js";

/**
 * CodeBuddy / WorkBuddy (Tencent) provider — direct connection to
 * copilot.tencent.com. The gateway speaks the OpenAI chat protocol with
 * native tools, but only serves streaming responses, so:
 *   - client wants stream   -> SSE passthrough (OpenAI) or translated SSE (Anthropic)
 *   - client wants non-stream -> upstream SSE aggregated locally
 * Token expiry is handled by the credentials module (auto refresh + write-back);
 * a 401 triggers one forced refresh + retry.
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
    // the gateway only serves streaming responses
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
 * The gateway's tool_choice is a plain string field ("auto"/"none"/"required");
 * object forms that OpenAI/Anthropic clients send are rejected with a 400
 * (code 11101, "cannot unmarshal object into ... tool_choice of type string").
 * Named-function forcing is not supported upstream, so it degrades to
 * "required" — the model still sees the tools and picks one.
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
