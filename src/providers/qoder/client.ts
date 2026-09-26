import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { extractStreamFlag, rewriteModel, toUpstreamResult } from "../types.js";
import { anthropicToOpenAI, openAIToAnthropicResponse, translateOpenAIStreamToAnthropic } from "../../translate/anthropic.js";
import type { AnthropicRequest } from "../../translate/anthropic.js";
import type { QoderProviderConfig } from "../../config.js";
import type { BridgeHandle } from "./bridge.js";
import { regionToProviderId } from "./constants.js";

/**
 * Qoder provider backed by the local qoder2api bridge sidecar.
 *  - OpenAI requests are proxied through unchanged (the bridge is OpenAI-native).
 *  - Anthropic requests are translated to OpenAI, sent to the bridge, and the
 *    response (stream or not) is translated back to Anthropic format.
 */
export class QoderProvider implements ProviderAdapter {
  readonly id: string;
  private readonly modelsCacheTtlMs = 5 * 60_000;
  private modelsCache: { at: number; ids: string[] } | null = null;
  private readonly modelsFallback: string[];

  constructor(
    config: QoderProviderConfig,
    private readonly bridge: BridgeHandle,
    private readonly timeoutMs: number,
  ) {
    this.id = regionToProviderId(config.region ?? "cn");
    this.modelsFallback = config.models;
  }

  async models(): Promise<string[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < this.modelsCacheTtlMs) {
      return this.modelsCache.ids;
    }
    try {
      const res = await fetch(`${this.bridge.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${this.bridge.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
        if (ids.length > 0) {
          this.modelsCache = { at: Date.now(), ids };
          return ids;
        }
      }
    } catch {
      // fall back to the static list below
    }
    return this.modelsFallback;
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    const res = await this.upstream(rewriteModel(rawBody, model));
    return toUpstreamResult(res);
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    const req = JSON.parse(rawBody) as AnthropicRequest;
    req.model = model;
    const openaiBody = anthropicToOpenAI(req);
    const wantsStream = extractStreamFlag(rawBody) || openaiBody.stream === true;
    openaiBody.stream = wantsStream;

    const res = await this.upstream(JSON.stringify(openaiBody));

    if (!res.ok || res.body === null) {
      return { status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body: await res.text() };
    }
    if (!wantsStream) {
      const json = (await res.json()) as Parameters<typeof openAIToAnthropicResponse>[0];
      return { status: 200, contentType: "application/json", body: JSON.stringify(openAIToAnthropicResponse(json, model)) };
    }
    return {
      status: 200,
      contentType: "text/event-stream",
      body: translateOpenAIStreamToAnthropic(res.body as ReadableStream<Uint8Array>, model),
    };
  }

  private upstream(body: string): Promise<Response> {
    return fetch(`${this.bridge.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.bridge.apiKey}` },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
