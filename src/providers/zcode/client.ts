/**
 * ZCode Start Plan（JWT）提供方。
 *
 * 单账号直透：Anthropic 与 OpenAI 双协议统一走
 *   https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 * Bearer JWT + 身份/trace/验证码头 + body 变换（见 start-plan/）。
 * OpenAI 请求先做 OpenAI→Anthropic 最小转换；非流原样回译，
 * 流透传时做 StreamConverter 翻译 + 首 role chunk + 尾 [DONE]。
 *
 * 不再依赖 open.bigmodel.cn / api.z.ai 按量端点（已彻底移除）。
 * 错误语义（单账号，无换号；抛错带 upstream status+body）：
 *  - 验证码挑战：换码重试最多 3 次
 *  - 402/额度关键词 → EXHAUSTED，直接抛 402
 *  - 429：按 Retry-After（封顶 120s）原地重试最多 5 次
 *  - 401/403（非验证码）→ INVALID，直接抛
 *  - 405/3012 → DISABLED（风控），直接抛
 *  - 5xx：重试 3 次（间隔 5s）
 *  - 其他 4xx：原样回传
 */

import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { ProviderError, toUpstreamResult } from "../types.js";
import type { ZCodeProviderConfig } from "../../config.js";
import { readZCodeCredentials } from "./credentials.js";
import {
  MAX_429_RETRIES,
  MAX_5XX_RETRIES,
  MAX_CAPTCHA_RETRIES,
  RETRY_429_DEFAULT_WAIT_S,
  RETRY_5XX_WAIT_MS,
} from "./start-plan/constants.js";
import {
  StreamConverter,
  anthropicToOpenai,
  buildUpstreamRequest,
  detectCaptchaChallenge,
  isExhausted,
  isRiskControl,
  normalizeBody,
  openaiToAnthropic,
  parseRetryAfter,
  type AnthropicBody,
} from "./start-plan/agent.js";
import { jwtUserId } from "./start-plan/body-transform.js";
import { getVerifyParam } from "./start-plan/captcha.js";
import { profileForJwt, resolveDeviceFile } from "./start-plan/fingerprint.js";

const APP_VERSION_DEFAULT = "3.11.2";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function badRequest(message: string): UpstreamResult {
  return {
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: { message, type: "invalid_request_error" } }),
  };
}

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
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
    this.appVersion = config.appVersion?.trim() || APP_VERSION_DEFAULT;
    this.deviceFile = resolveDeviceFile(config.deviceFile);
    this.timeoutMs = timeoutMs;
    this.modelList = config.models;
  }

  async models(): Promise<string[]> {
    return this.modelList;
  }

  async anthropic(model: string, rawBody: string): Promise<UpstreamResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return badRequest('request body must be JSON with a "model" field');
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return badRequest('request body must be JSON with a "model" field');
    }
    const body = parsed as AnthropicBody;
    body["model"] = model;
    normalizeBody(body);
    return this.dispatchAnthropic(body);
  }

  async openai(model: string, rawBody: string): Promise<UpstreamResult> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return badRequest('request body must be JSON with a "model" field');
    }
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
      return badRequest('request body must be JSON with a "model" field');
    }
    const record = payload as Record<string, any>;
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
      // 上游非流式回包却被要求流式：合成单 chunk SSE，保证协议不断
      const conv = new StreamConverter(model);
      let sse = conv.start();
      try {
        const data = JSON.parse(upstream.body) as Record<string, any>;
        const openai = anthropicToOpenai(data, model);
        const content = openai?.["choices"]?.[0]?.["message"]?.["content"];
        if (typeof content === "string" && content) {
          sse += `data: ${JSON.stringify({
            id: openai["id"],
            object: "chat.completion.chunk",
            created: openai["created"],
            model,
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`;
        }
      } catch {
        // 解析失败则只发首尾空流
      }
      sse += conv.done();
      return { status: upstream.status, contentType: "text/event-stream", body: sse };
    }
    return {
      status: upstream.status,
      contentType: "text/event-stream",
      body: translateStreamToOpenai(upstream.body, model),
    };
  }

  /** 单账号调度：成功或 4xx 回传时返回 UpstreamResult，其余按错误语义抛 ProviderError。 */
  private async dispatchAnthropic(body: AnthropicBody): Promise<UpstreamResult> {
    const profile = profileForJwt(jwtUserId(this.jwt), this.deviceFile);
    let verifyParam: string | null = null;
    let verifyRegion: string | null = null;
    let captchaRetries = 0;
    let retries429 = 0;
    let retries5xx = 0;

    for (;;) {
      const { url, headers, payload } = buildUpstreamRequest({
        jwt: this.jwt,
        profile,
        appVersion: this.appVersion,
        body,
        verifyParam,
        verifyRegion,
      });

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        // 连接失败/超时按 5xx 类重试
        if (retries5xx < MAX_5XX_RETRIES) {
          retries5xx += 1;
          await sleep(RETRY_5XX_WAIT_MS);
          continue;
        }
        throw new ProviderError(
          `zcode: upstream request failed after ${MAX_5XX_RETRIES} retries: ${(err as Error).message}`,
          502,
        );
      }

      if (res.status < 400) return toUpstreamResult(res);

      const text = await res.text();

      // 验证码挑战：换码重试最多 3 次（solver 二期前多为空值重试）
      if (detectCaptchaChallenge(res.status, text, res.headers)) {
        captchaRetries += 1;
        if (captchaRetries > MAX_CAPTCHA_RETRIES) {
          throw new ProviderError(
            `zcode: captcha challenge unresolved after ${MAX_CAPTCHA_RETRIES} retries (upstream ${res.status}): ${text.slice(0, 500)}`,
            403,
          );
        }
        const token = await getVerifyParam(this.appVersion);
        verifyParam = token?.param ?? null;
        verifyRegion = token?.region ?? null;
        continue;
      }

      // 风控（3012/unusual activity / 405）→ DISABLED，直接抛
      if (isRiskControl(res.status, text)) {
        throw new ProviderError(
          `zcode: DISABLED — upstream risk control (status ${res.status}): ${text.slice(0, 500)}`,
          res.status,
        );
      }

      // 402/额度关键词 → EXHAUSTED，直接抛 402
      if (isExhausted(res.status, text)) {
        throw new ProviderError(
          `zcode: EXHAUSTED — plan quota used up (upstream ${res.status}): ${text.slice(0, 500)}`,
          402,
        );
      }

      // 401/403（已排除验证码挑战）→ INVALID，直接抛
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(
          `zcode: INVALID — upstream rejected credentials (status ${res.status}): ${text.slice(0, 500)}`,
          res.status,
        );
      }

      // 429：按 Retry-After（封顶 120s）原地重试最多 5 次
      if (res.status === 429) {
        if (retries429 < MAX_429_RETRIES) {
          retries429 += 1;
          const waitS = parseRetryAfter(res.headers.get("retry-after")) ?? RETRY_429_DEFAULT_WAIT_S;
          await sleep(waitS * 1000);
          continue;
        }
        throw new ProviderError(
          `zcode: rate limited, 429 retries exhausted (upstream 429): ${text.slice(0, 500)}`,
          429,
        );
      }

      // 5xx：重试 3 次（间隔 5s）
      if (res.status >= 500) {
        if (retries5xx < MAX_5XX_RETRIES) {
          retries5xx += 1;
          await sleep(RETRY_5XX_WAIT_MS);
          continue;
        }
        throw new ProviderError(
          `zcode: upstream error ${res.status} after ${MAX_5XX_RETRIES} retries: ${text.slice(0, 500)}`,
          502,
        );
      }

      // 其他 4xx：原样回传
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "application/json",
        body: text,
      };
    }
  }
}
