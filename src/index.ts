import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { loadConfig } from "./config.js";
import { forwardCompletion } from "./forward.js";
import { CodeBuddyProvider } from "./providers/codebuddy/index.js";
import { startQoderProvider } from "./providers/qoder/index.js";
import type { ProviderAdapter } from "./providers/types.js";
import { ZCodeProvider } from "./providers/zcode/index.js";

const cfg = loadConfig();

const providers: ProviderAdapter[] = [];
if (cfg.providers.zcode.enabled) providers.push(new ZCodeProvider(cfg.providers.zcode, cfg.upstreamTimeoutMs));
if (cfg.providers.qoder.enabled) providers.push(await startQoderProvider(cfg.providers.qoder, cfg.upstreamTimeoutMs));
if (cfg.providers.qoderIntl.enabled)
  providers.push(await startQoderProvider(cfg.providers.qoderIntl, cfg.upstreamTimeoutMs));
if (cfg.providers.codebuddy.enabled) providers.push(new CodeBuddyProvider(cfg.providers.codebuddy, cfg.upstreamTimeoutMs));
if (providers.length === 0) {
  console.error("[config] all providers are disabled — enable at least one in config.json");
  process.exit(1);
}

const app = new Hono();

app.use("*", cors());

// all2api 自身的 Bearer 鉴权（客户端用 cfg.apiKey 鉴权，而非上游密钥）
app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${cfg.apiKey}`) {
    return c.json({ error: { message: "invalid or missing API key", type: "authentication_error" } }, 401);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true, providers: providers.map((p) => p.id) }));

app.get("/v1/models", async (c) => {
  // 每个条目都以规范的 "provider/model" 形式列出；裸 ID
  // 为向后兼容仍路由到默认 provider
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

app.post("/v1/chat/completions", (c) => forwardCompletion(c, "openai", { providers, defaultProvider: cfg.defaultProvider }));
app.post("/v1/messages", (c) => forwardCompletion(c, "anthropic", { providers, defaultProvider: cfg.defaultProvider }));

serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
  console.log(`all2api listening on http://${info.address}:${info.port}`);
  console.log(`  OpenAI   : POST /v1/chat/completions`);
  console.log(`  Anthropic: POST /v1/messages`);
  console.log(`  providers: ${providers.map((p) => p.id).join(", ")} (default: ${cfg.defaultProvider})`);
  console.log(`  auth     : Authorization: Bearer ${cfg.apiKey.slice(0, 12)}…`);
});
