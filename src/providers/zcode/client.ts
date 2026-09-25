import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { rewriteModel, toUpstreamResult } from "../types.js";
import type { ZCodeProviderConfig } from "../../config.js";
import { readZCodeCredentials } from "./credentials.js";

/**
 * ZCode (智谱 GLM coding plan) provider.
 *
 * The coding-plan API key decrypted from the ZCode CLI's credential store is a
 * standard Zhipu key that works against two native endpoints:
 *  - Anthropic format: {anthropicBaseUrl}/v1/messages
 *  - OpenAI format:    {openaiBaseUrl}/chat/completions
 * Both are passthroughs — no request/response translation needed.
 */
export class ZCodeProvider implements ProviderAdapter {
  readonly id = "zcode";
  private readonly apiKey: string;
  private readonly anthropicBaseUrl: string;
  private readonly openaiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly modelList: string[];

  constructor(config: ZCodeProviderConfig, timeoutMs: number) {
    const key = config.apiKey?.trim() || readZCodeCredentials()?.apiKeys.individual || "";
    if (!key) {
      throw new Error(
        "zcode: no API key available — run `zcode login`, or set providers.zcode.apiKey in config.json",
      );
    }
    this.apiKey = key;
    this.anthropicBaseUrl = config.anthropicBaseUrl.replace(/\/$/, "");
    this.openaiBaseUrl = config.openaiBaseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.modelList = config.models;
  }

  async models(): Promise<string[]> {
    return this.modelList;
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    return this.forward(`${this.anthropicBaseUrl}/v1/messages`, model, rawBody, {
      "anthropic-version": "2023-06-01",
    });
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    return this.forward(`${this.openaiBaseUrl}/chat/completions`, model, rawBody);
  }

  private async forward(
    url: string,
    model: string,
    rawBody: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<UpstreamResult> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...extraHeaders,
      },
      body: rewriteModel(rawBody, model),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return toUpstreamResult(res);
  }
}
