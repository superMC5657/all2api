import type { Context } from "hono";

import type { ProviderAdapter } from "./providers/types.js";
import { ProviderError, extractStreamFlag } from "./providers/types.js";
import { canonicalModelId, routeModel } from "./router.js";
import type { RouteTarget } from "./router.js";
import { logUsage } from "./usage.js";

/** Forward 负责的 API 种类：决定错误信封形状与上游失败 type 取值。 */
export type ForwardKind = "openai" | "anthropic";

export interface ForwardEnv {
  providers: ProviderAdapter[];
  defaultProvider: string;
  /** 严格模型校验开关（缺省 false=透传任意模型名；true=只允许各渠道 models 表内模型）。 */
  strictModels: boolean;
}

// 路由是 Forward 内部的纯 helper：经由 Forward re-export，调用方无需直引 router。
export { canonicalModelId, routeModel };
export type { RouteTarget };

/**
 * 统一错误信封：openai 用 `{ error: { message, type } }`，
 * anthropic 用 Anthropic 原生 `{ type: "error", error: { type, message } }`。
 * index.ts 的 401 鉴权信封也复用它（取 openai 形状，与原手写体逐字节一致）。
 */
export function forwardErrorBody(kind: ForwardKind, type: string, message: string): object {
  if (kind === "anthropic") return { type: "error", error: { type, message } };
  return { error: { message, type } };
}

/** 上游失败时的 type 取值：Anthropic 侧用 api_error，OpenAI 侧用 upstream_error。 */
export function forwardUpstreamType(kind: ForwardKind): string {
  return kind === "anthropic" ? "api_error" : "upstream_error";
}

/** model-parse：body 非 JSON 或缺 model 时返回 ""，调用方统一按 400 处理。 */
export function parseRequestedModel(rawBody: string): string {
  try {
    return (JSON.parse(rawBody) as { model?: string }).model ?? "";
  } catch {
    // 透传——空模型下面会返回 400
    return "";
  }
}

/** TimeoutError 单独映射，其余按 upstream request failed 包装。 */
export function mapUpstreamMessage(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "upstream request timed out";
  return `upstream request failed: ${(err as Error).message}`;
}

/** strictModels 命中检查：未命中返回拦截用的错误文案，命中返回 null（放行）。 */
export async function checkStrictAllowlist(target: RouteTarget, requestedModel: string): Promise<string | null> {
  const table = await target.provider.models();
  if (table.includes(target.model)) return null;
  const canonicalId = canonicalModelId(target.provider.id, target.model);
  return `model "${requestedModel}" (resolved "${canonicalId}") is not in strictModels allowlist for provider "${target.provider.id}": [${table.join(", ")}]`;
}

/** 双 logUsage 收口：成功与异常路径共用同一记账形状。 */
function recordForwardUsage(
  target: RouteTarget,
  kind: ForwardKind,
  stream: boolean,
  status: number,
  startedAt: number,
): void {
  logUsage({
    ts: new Date().toISOString(),
    provider: target.provider.id,
    model: target.model,
    api: kind,
    stream,
    status,
    ms: Date.now() - startedAt,
  });
}

export async function forwardCompletion(c: Context, kind: ForwardKind, env: ForwardEnv): Promise<Response> {
  const rawBody = await c.req.text();
  const requestedModel = parseRequestedModel(rawBody);
  if (!requestedModel) {
    return c.json(forwardErrorBody(kind, "invalid_request_error", 'request body must be JSON with a "model" field'), 400);
  }

  let target: RouteTarget;
  try {
    target = routeModel(requestedModel, env.providers, env.defaultProvider);
  } catch (err) {
    return c.json(forwardErrorBody(kind, "invalid_request_error", (err as Error).message), 400);
  }

  // strictModels=true 时按目标渠道 models() 表精确校验（精确字符串相等，无通配符）：
  // 先按现有规则把裸 ID 经 defaultProvider 解析出规范 id 再查表；未命中直接 400，
  // OpenAI/Anthropic 双路径共用同一拦截点。
  if (env.strictModels) {
    const message = await checkStrictAllowlist(target, requestedModel);
    if (message !== null) {
      return c.json(forwardErrorBody(kind, "invalid_request_error", message), 400);
    }
  }

  const stream = extractStreamFlag(rawBody);
  const startedAt = Date.now();
  try {
    const result =
      kind === "openai"
        ? await target.provider.openai(target.model, rawBody)
        : await target.provider.anthropic(target.model, rawBody);

    recordForwardUsage(target, kind, stream, result.status, startedAt);

    const headers = { "content-type": result.contentType };
    return new Response(result.body, { status: result.status, headers });
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : 502;
    recordForwardUsage(target, kind, stream, status, startedAt);
    // OpenAI 用 { error: { message, type } }，Anthropic 用 { type: "error", error: { type, message } }；
    // type 取值用两边各自合法的枚举（Anthropic 侧上游失败用 api_error）。
    return c.json(forwardErrorBody(kind, forwardUpstreamType(kind), mapUpstreamMessage(err)), status as 400 | 401 | 402 | 403 | 405 | 429 | 502);
  }
}
