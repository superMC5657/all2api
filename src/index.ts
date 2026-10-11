import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { loadConfig } from "./config.js";
import { forwardCompletion, forwardErrorBody } from "./forward.js";
import { CodeBuddyProvider } from "./providers/codebuddy/index.js";
import { startQoderProvider } from "./providers/qoder/index.js";
import { TraeCnProvider } from "./providers/trae-cn/index.js";
import { TraeProvider } from "./providers/trae/index.js";
import type { ProviderAdapter } from "./providers/types.js";
import { ZCodeProvider } from "./providers/zcode/index.js";

// 包一层 main()：esbuild CJS 单文件不支持顶层 await，SEA 又要求 CJS；
// 逻辑与之前完全一致，只是把顶层 await 收进函数内。
async function main(): Promise<void> {
  const cfg = loadConfig();

  const providers: ProviderAdapter[] = [];
  if (cfg.providers.zcode.enabled) providers.push(new ZCodeProvider(cfg.providers.zcode, cfg.upstreamTimeoutMs));
  if (cfg.providers.qoder.enabled)
    providers.push(await startQoderProvider(cfg.providers.qoder, cfg.upstreamTimeoutMs));
  if (cfg.providers.qoderIntl.enabled)
    providers.push(await startQoderProvider(cfg.providers.qoderIntl, cfg.upstreamTimeoutMs));
  // region 缺省已在 resolveConfig 归一（codebuddy→"cn"，显式 "auto" 保留），这里直接透传。
  if (cfg.providers.codebuddy.enabled)
    providers.push(new CodeBuddyProvider(cfg.providers.codebuddy, cfg.upstreamTimeoutMs, "codebuddy"));
  // codebuddyIntl（海外，https://www.workbuddy.ai / https://www.codebuddy.ai）：构造期不碰磁盘（懒加载）。
  // region 缺省→"intl" 同样由 resolveConfig 落定；双开时两边必须配不同的 authDir，否则默认探测会撞到同一份 session。
  if (cfg.providers.codebuddyIntl.enabled)
    providers.push(new CodeBuddyProvider(cfg.providers.codebuddyIntl, cfg.upstreamTimeoutMs, "codebuddy-intl"));
  // trae (intl, https://api.trae.ai)：MVP 聊天 501 骨架，models 兜底 ["auto"]，构造期不碰磁盘。
  // dataDir（dataDir || authDir 归一，dataDir 优先）与 models 兜底已在 resolveConfig 落定，这里直接透传。
  if (cfg.providers.trae.enabled) providers.push(new TraeProvider(cfg.providers.trae, cfg.upstreamTimeoutMs));
  // trae-cn (CN AgentHost https://trae-api-cn.mchost.guru)：直连 llm_utils_chat 轻聊天；接线同 trae，直接透传。
  if (cfg.providers["trae-cn"].enabled)
    providers.push(new TraeCnProvider(cfg.providers["trae-cn"], cfg.upstreamTimeoutMs));
  if (providers.length === 0) {
    console.error("[config] all providers are disabled — enable at least one in config.jsonc");
    process.exit(1);
  }

  const app = new Hono();

  app.use("*", cors());

  // all2api 自身的 Bearer 鉴权（客户端用 cfg.apiKey 鉴权，而非上游密钥）：
  // 401 信封复用 Forward 的统一 envelope（取 openai 形状，与原手写体一致，状态码语义不变）。
  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${cfg.apiKey}`) {
      return c.json(forwardErrorBody("openai", "authentication_error", "invalid or missing API key"), 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, providers: providers.map((p) => p.id) }));

  app.get("/v1/models", async (c) => {
    // 每个条目都以规范的 "provider/model" 形式列出；裸 ID
    // 为向后兼容仍路由到默认 provider。
    // strictModels 只约束转发，列表本就只列各渠道 models() 表内模型，无需过滤。
    const data = (
      await Promise.all(
        providers.map(async (p) =>
          (await p.models()).map((id) => ({
            id: `${p.id}/${id}`,
            object: "model",
            owned_by: `all2api:${p.id}`,
          })),
        ),
      )
    ).flat();
    return c.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", (c) =>
    forwardCompletion(c, "openai", { providers, defaultProvider: cfg.defaultProvider, strictModels: cfg.strictModels }),
  );
  app.post("/v1/messages", (c) =>
    forwardCompletion(c, "anthropic", { providers, defaultProvider: cfg.defaultProvider, strictModels: cfg.strictModels }),
  );

  serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    console.log(`all2api listening on http://${info.address}:${info.port}`);
    console.log(`  OpenAI   : POST /v1/chat/completions`);
    console.log(`  Anthropic: POST /v1/messages`);
    console.log(`  providers: ${providers.map((p) => p.id).join(", ")} (default: ${cfg.defaultProvider})`);
    console.log(`  auth     : Authorization: Bearer ${cfg.apiKey.slice(0, 12)}…`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
