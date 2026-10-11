import type { Context } from "hono";

import type { ProviderAdapter } from "./providers/types.js";
import { ProviderError, extractStreamFlag } from "./providers/types.js";
import { canonicalModelId, routeModel } from "./router.js";
import { logUsage } from "./usage.js";

interface ForwardEnv {
  providers: ProviderAdapter[];
  defaultProvider: string;
  /** 严格模型校验开关（缺省 false=透传任意模型名；true=只允许各渠道 models 表内模型）。 */
  strictModels: boolean;
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

  // strictModels=true 时按目标渠道 models() 表精确校验（精确字符串相等，无通配符）：
  // 先按现有规则把裸 ID 经 defaultProvider 解析出规范 id 再查表；未命中直接 400，
  // OpenAI/Anthropic 双路径共用同一拦截点。
  if (env.strictModels) {
    const canonicalId = canonicalModelId(target.provider.id, target.model);
    const table = await target.provider.models();
    if (!table.includes(target.model)) {
      return c.json(
        errorBody(
          kind,
          "invalid_request_error",
          `model "${requestedModel}" (resolved "${canonicalId}") is not in strictModels allowlist for provider "${target.provider.id}": [${table.join(", ")}]`,
        ),
        400,
      );
    }
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
