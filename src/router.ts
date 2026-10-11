import type { ProviderAdapter } from "./providers/types.js";

export interface RouteTarget {
  provider: ProviderAdapter;
  model: string;
}

/**
 * 将模型 ID 路由到 provider。"zcode/glm-5.3-flash" 会 pin 住指定 provider；
 * 裸模型 ID 则走默认 provider。有斜杠但前缀未命中时抛错（调用方返回 400 并提示可用 provider）。
 */
export function routeModel(model: string, providers: ProviderAdapter[], defaultProviderId: string): RouteTarget {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const providerId = model.slice(0, slash);
    const pinned = providers.find((p) => p.id === providerId);
    if (pinned) return { provider: pinned, model: model.slice(slash + 1) };
    throw new Error(`unknown provider "${providerId}" in model "${model}"; available providers: ${providers.map((p) => p.id).join(", ")}`);
  }
  const fallback = providers.find((p) => p.id === defaultProviderId) ?? providers[0];
  if (!fallback) throw new Error("no provider is enabled in config.json");
  return { provider: fallback, model };
}

/** 路由结果的规范 id（"provider/model"，与 /v1/models 的 id 形状一致）。 */
export function canonicalModelId(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}
