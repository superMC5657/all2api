import type { Context } from "hono";

import type { ProviderAdapter } from "./providers/types.js";
import { ProviderError, extractStreamFlag } from "./providers/types.js";
import { canonicalModelId, isModelAllowed, routeModel } from "./router.js";
import { logUsage } from "./usage.js";

interface ForwardEnv {
  providers: ProviderAdapter[];
  defaultProvider: string;
  /** 顶层模型白名单（规范 "provider/model" 精确匹配；空 = 不过滤）。 */
  allowedModels: readonly string[];
}

export async function forwardCompletion(c: Context, kind: "openai" | "anthropic", env: ForwardEnv): Promise<Response> {
  const rawBody = await c.req.text();
  let requestedModel = "";
  try {
    requestedModel = (JSON.parse(rawBody) as { model?: string }).model ?? "";
  } catch {
    // 透传——空模型下面会返回 400
  }
  if (!requestedModel) {
    return c.json(errorBody(kind, "invalid_request_error", "request body must be JSON with a \"model\" field"), 400);
  }

  let target;
  try {
    target = routeModel(requestedModel, env.providers, env.defaultProvider);
  } catch (err) {
    return c.json(errorBody(kind, "invalid_request_error", (err as Error).message), 400);
  }

  // 顶层模型白名单：按解析出的规范 provider/model 精确匹配（裸 ID 已在上一步经
  // defaultProvider 回落为规范 id）；未命中直接 400（与未知 provider 同码），OpenAI/Anthropic 双路径共用。
  const canonicalId = canonicalModelId(target.provider.id, target.model);
  if (!isModelAllowed(env.allowedModels, canonicalId)) {
    return c.json(
      errorBody(kind, "invalid_request_error", `model "${requestedModel}" (resolved "${canonicalId}") is not in allowedModels whitelist`),
      400,
    );
  }

  const stream = extractStreamFlag(rawBody);
  const startedAt = Date.now();
  try {
    const result =
      kind === "openai"
        ? await target.provider.openai(target.model, rawBody)
        : await target.provider.anthropic(target.model, rawBody);

    logUsage({
      ts: new Date().toISOString(),
      provider: target.provider.id,
      model: target.model,
      api: kind,
      stream,
      status: result.status,
      ms: Date.now() - startedAt,
    });

    const headers = { "content-type": result.contentType };
    return new Response(result.body, { status: result.status, headers });
  } catch (err) {
    const status = err instanceof ProviderError ? err.status : 502;
    logUsage({
      ts: new Date().toISOString(),
      provider: target.provider.id,
      model: target.model,
      api: kind,
      stream,
      status,
      ms: Date.now() - startedAt,
    });
    const message = err instanceof Error && err.name === "TimeoutError" ? "upstream request timed out" : `upstream request failed: ${(err as Error).message}`;
    // OpenAI 用 { error: { message, type } }，Anthropic 用 { type: "error", error: { type, message } }；
    // type 取值用两边各自合法的枚举（Anthropic 侧上游失败用 api_error）。
    const type = kind === "anthropic" ? "api_error" : "upstream_error";
    return c.json(errorBody(kind, type, message), status as 400 | 401 | 402 | 403 | 405 | 429 | 502);
  }
}

/** 按 API 种类包装错误体：openai 保持现有形状，anthropic 用 Anthropic 原生错误信封。 */
function errorBody(kind: "openai" | "anthropic", type: string, message: string): object {
  if (kind === "anthropic") return { type: "error", error: { type, message } };
  return { error: { message, type } };
}
