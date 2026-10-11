/**
 * ZCode Start Plan（JWT）提供方（薄适配器）。
 *
 * 单账号直透：Anthropic 与 OpenAI 双协议统一走
 *   https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 * Bearer JWT + 身份/trace/验证码头 + body 变换（见 start-plan/agent 内核）。
 * OpenAI 请求先做 OpenAI→Anthropic 最小转换；非流原样回译，
 * 流透传时做 StreamConverter 翻译 + 首 role chunk + 尾 [DONE]。
 *
 * 本文件只做协议适配（Anthropic/OpenAI 出入口 + OpenAI 错误形/流合成）：
 * 一次 Forward 所需的 JWT、身份头、body 变换、验证码/429/5xx 重试
 * 全部由 start-plan/agent.dispatchStartPlan 拥有，不再直引
 * constants / body-transform / captcha / fingerprint / version。
 *
 * 错误语义（单账号，无换号；抛错带 upstream status+body）见 agent.dispatchStartPlan：
 *  - 验证码挑战：换码重试最多 3 次
 *  - 402/额度关键词 → EXHAUSTED，直接抛 402
 *  - 429：按 Retry-After（封顶 120s）原地重试最多 5 次
 *  - 401/403（非验证码）→ INVALID，直接抛
 *  - 405/3012 → DISABLED（风控），直接抛
 *  - 5xx：重试 3 次（间隔 5s）
 *  - 其他 4xx：原样回传
 */

import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { ProviderError } from "../types.js";
import { badRequest, readStreamText, tryParseJsonObject } from "../base.js";
import type { ZCodeProviderConfig } from "../../config.js";
import { readZCodeCredentials } from "./credentials.js";
import {
  StreamConverter,
  anthropicToOpenai,
  dispatchStartPlan,
  normalizeBody,
  openaiToAnthropic,
  resolveStartPlanAppVersion,
  resolveStartPlanDeviceFile,
  type AnthropicBody,
} from "./start-plan/agent.js";

/** 上游 4xx 透传体 → OpenAI 错误形（保留原 status；captcha/429/5xx 的 throw 路径不受影响）。 */
function upstreamErrorToOpenai(status: number, text: string): UpstreamResult {
  let message = text;
  let type = "upstream_error";
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const data: unknown = JSON.parse(trimmed);
      if (data != null && typeof data === "object" && !Array.isArray(data)) {
        const rec = data as Record<string, any>;
        const err = rec["error"];
        if (err != null && typeof err === "object" && !Array.isArray(err)) {
          const e = err as Record<string, any>;
          if (typeof e["message"] === "string" && e["message"]) message = e["message"] as string;
          if (typeof e["type"] === "string" && e["type"]) type = e["type"] as string;
        } else if (typeof rec["message"] === "string" && (rec["message"] as string)) {
          message = rec["message"] as string;
          if (typeof rec["type"] === "string" && (rec["type"] as string)) type = rec["type"] as string;
        } else if (typeof rec["detail"] === "string" && (rec["detail"] as string)) {
          message = rec["detail"] as string;
        }
      }
    } catch {
      // 非 JSON：原文透传
    }
  }
  if (!message.trim()) message = `upstream error ${status}`;
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: { message, type } }),
  };
}

/** 上游 Anthropic SSE 流 → OpenAI chunk 流（含首 role chunk 与尾 [DONE]）。 */
function translateStreamToOpenai(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const conv = new StreamConverter(model);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buf = "";

  function* extractLines(chunk: string): Generator<string> {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }

  function* drainLines(): Generator<string> {
    if (buf.length > 0) {
      yield buf;
      buf = "";
    }
  }

  function convertLine(line: string): string[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return [];
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") return [];
    let evt: unknown;
    try {
      evt = JSON.parse(dataStr);
    } catch {
      return [];
    }
    if (evt == null || typeof evt !== "object" || Array.isArray(evt)) return [];
    return conv.feed(evt as Record<string, any>);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(conv.start()));
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of extractLines(decoder.decode(value, { stream: true }))) {
            for (const out of convertLine(line)) controller.enqueue(encoder.encode(out));
          }
        }
        for (const line of extractLines(decoder.decode())) {
          for (const out of convertLine(line)) controller.enqueue(encoder.encode(out));
        }
        for (const line of drainLines()) {
          for (const out of convertLine(line)) controller.enqueue(encoder.encode(out));
        }
      } catch (err) {
        controller.error(err);
        return;
      } finally {
        reader.releaseLock();
      }
      controller.enqueue(encoder.encode(conv.done()));
      controller.close();
    },
  });
}

export class ZCodeProvider implements ProviderAdapter {
  readonly id = "zcode";
  private readonly jwt: string;
  private readonly appVersion: string;
  private readonly deviceFile: string;
  private readonly timeoutMs: number;
  private readonly modelList: string[];

  constructor(config: ZCodeProviderConfig, timeoutMs: number) {
    // config.jwt 非空则视为显式 JWT，否则读本机 `zcode login` 的 zcodeJwt
    const jwt = config.jwt?.trim() || readZCodeCredentials()?.zcodeJwt || "";
    if (!jwt) {
      throw new Error(
        "zcode: no Start Plan JWT available — run `zcode login`, or set providers.zcode.jwt in config.jsonc",
      );
    }
    this.jwt = jwt;
    // 缺省跟随本地（config 显式值 > ZCODE_APP_VERSION > 注册表 > exe > runtime），找不到回落常量（经由 agent 内核解析）
    this.appVersion = resolveStartPlanAppVersion(config.appVersion);
    this.deviceFile = resolveStartPlanDeviceFile(config.deviceFile);
    this.timeoutMs = timeoutMs;
    this.modelList = config.models;
  }

  async models(): Promise<string[]> {
    return this.modelList;
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    const parsed = tryParseJsonObject(rawBody);
    if (!parsed) {
      return badRequest('request body must be JSON with a "model" field');
    }
    const body = parsed as unknown as AnthropicBody;
    body["model"] = model;
    normalizeBody(body);
    return this.dispatchAnthropic(body);
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    const parsed = tryParseJsonObject(rawBody);
    if (!parsed) {
      return badRequest('request body must be JSON with a "model" field');
    }
    const record = parsed as Record<string, any>;
    if (typeof record["model"] === "string" && (record["model"] as string).includes("/")) {
      record["model"] = (record["model"] as string).split("/").slice(1).join("/");
    }
    const converted = openaiToAnthropic(record);
    if ("error" in converted) return badRequest(converted.error);
    const body = converted.body;
    body["model"] = model;
    normalizeBody(body);

    const stream = record["stream"] === true;
    const upstream = await this.dispatchAnthropic(body);
    // H5：上游 4xx 透传一律转 OpenAI 错误形、原 status 返回（流/非流同理：错误走 JSON 而非 SSE）。
    if (upstream.status >= 400) {
      const text = typeof upstream.body === "string" ? upstream.body : await readStreamText(upstream.body);
      return upstreamErrorToOpenai(upstream.status, text);
    }
    if (!stream) {
      const text = typeof upstream.body === "string" ? upstream.body : await readStreamText(upstream.body);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new ProviderError(
          `zcode: upstream returned non-JSON (status ${upstream.status}): ${text.slice(0, 500)}`,
          502,
        );
      }
      if (data == null || typeof data !== "object" || Array.isArray(data)) {
        throw new ProviderError(`zcode: upstream response format error (status ${upstream.status})`, 502);
      }
      return {
        status: upstream.status,
        contentType: "application/json",
        body: JSON.stringify(anthropicToOpenai(data as Record<string, any>, model)),
      };
    }
    if (typeof upstream.body === "string") {
      // 上游非流式回包却被要求流式：经 StreamConverter 合成完整 SSE（含 tool_calls 与 finish chunk）
      const conv = new StreamConverter(model);
      let sse: string;
      try {
        const data = JSON.parse(upstream.body) as Record<string, any>;
        // 中-7：上游 200 携带 {"error":...} 时不合成空内容 stop 流，走 OpenAI 错误 JSON（对齐 codebuddy H2）。
        if (data != null && typeof data === "object" && !Array.isArray(data) && data["error"] != null) {
          return upstreamErrorToOpenai(upstream.status, upstream.body);
        }
        sse = conv.synthesize(data);
      } catch {
        // 解析失败则只发首尾空流
        sse = conv.start() + conv.done();
      }
      return { status: upstream.status, contentType: "text/event-stream", body: sse };
    }
    return {
      status: upstream.status,
      contentType: "text/event-stream",
      body: translateStreamToOpenai(upstream.body, model),
    };
  }

  /** 单账号调度（薄转发）：真实重试/验证码语义由 agent.dispatchStartPlan 拥有。 */
  private async dispatchAnthropic(body: AnthropicBody): Promise<UpstreamResult> {
    return dispatchStartPlan(body, {
      jwt: this.jwt,
      appVersion: this.appVersion,
      deviceFile: this.deviceFile,
      timeoutMs: this.timeoutMs,
    });
  }
}
