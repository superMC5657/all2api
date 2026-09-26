import type { Context } from "hono";

import type { ProviderAdapter } from "./providers/types.js";
import { ProviderError, extractStreamFlag } from "./providers/types.js";
import { routeModel } from "./router.js";
import { logUsage } from "./usage.js";

interface ForwardEnv {
  providers: ProviderAdapter[];
  defaultProvider: string;
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
    return c.json({ error: { message: "request body must be JSON with a \"model\" field", type: "invalid_request_error" } }, 400);
  }

  let target;
  try {
    target = routeModel(requestedModel, env.providers, env.defaultProvider);
  } catch (err) {
    return c.json({ error: { message: (err as Error).message, type: "invalid_request_error" } }, 400);
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
    return c.json({ error: { message, type: "upstream_error" } }, status as 400 | 401 | 402 | 403 | 405 | 429 | 502);
  }
}
