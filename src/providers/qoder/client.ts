import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { extractStreamFlag, rewriteModel, toUpstreamResult } from "../types.js";
import {
  ensureStreamOptions,
  okJson,
  okStream,
  streamSignal,
  upstreamError,
  wantsStreamForAnthropic,
} from "../base.js";
import { anthropicToOpenAI, openAIToAnthropicResponse, translateOpenAIStreamToAnthropic } from "../../translate/anthropic.js";
import type { AnthropicRequest } from "../../translate/anthropic.js";
import type { QoderProviderConfig } from "../../config.js";
import type { BridgeHandle } from "./bridge.js";
import { regionToProviderId } from "./constants.js";

/**
 * 由本地 qoder2api 桥接 sidecar 驱动的 Qoder provider。
 *  - OpenAI 请求原样透传（该桥接本身是 OpenAI 兼容的）。
 *  - Anthropic 请求先转换为 OpenAI 格式发给桥接，
 *    再将返回（流式或非流式）转回 Anthropic 格式。
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
          const filtered = this.applyAllowList(ids);
          this.modelsCache = { at: Date.now(), ids: filtered };
          return filtered;
        }
      }
    } catch {
      // 回退到下方的静态列表
    }
    return this.modelsFallback;
  }

  /**
   * config.models 白名单过滤（与 codebuddy 语义对齐）：
   * - 为空 = 不限制，直接暴露动态目录；
   * - 非空 = 动态目录 ∩ config.models，只暴露交集，隐藏已下线/未授权模型。
   */
  private applyAllowList(ids: string[]): string[] {
    if (this.modelsFallback.length === 0) return ids;
    const allow = new Set(this.modelsFallback);
    return ids.filter((id) => allow.has(id));
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    const wantsStream = extractStreamFlag(rawBody);
    const res = await this.upstream(rewriteModel(rawBody, model), { stream: wantsStream });
    return toUpstreamResult(res);
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    const req = JSON.parse(rawBody) as AnthropicRequest;
    req.model = model;
    const openaiBody = anthropicToOpenAI(req);
    const wantsStream = wantsStreamForAnthropic(rawBody, openaiBody);
    openaiBody.stream = wantsStream;
    // 对齐 codebuddy：缺省即附带 stream_options（非流时上游忽略），流式时用于要求上游附带 usage 终帧。
    ensureStreamOptions(openaiBody as Record<string, unknown>);

    const res = await this.upstream(JSON.stringify(openaiBody), { stream: wantsStream });

    if (!res.ok || res.body === null) {
      return upstreamError(res, await res.text());
    }
    if (!wantsStream) {
      const json = (await res.json()) as Parameters<typeof openAIToAnthropicResponse>[0];
      return okJson(openAIToAnthropicResponse(json, model));
    }
    return okStream(translateOpenAIStreamToAnthropic(res.body as ReadableStream<Uint8Array>, model));
  }

  private upstream(body: string, opts: { stream: boolean }): Promise<Response> {
    // 流式请求不设整体超时，由客户端断连驱动取消；非流式保留超时（见 base.streamSignal）。
    const signal = streamSignal(this.timeoutMs, opts.stream);
    return fetch(`${this.bridge.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.bridge.apiKey}` },
      body,
      ...(signal ? { signal } : {}),
    });
  }
}
