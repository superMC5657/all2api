import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { loadConfig } from "./config.js";
import { forwardCompletion } from "./forward.js";
import { startBridge } from "./providers/qoder/bridge.js";
import { QoderProvider } from "./providers/qoder/client.js";
import type { ProviderAdapter } from "./providers/types.js";
import { ZCodeProvider } from "./providers/zcode/index.js";

const cfg = loadConfig();

const providers: ProviderAdapter[] = [];
if (cfg.providers.zcode.enabled) providers.push(new ZCodeProvider(cfg.providers.zcode, cfg.upstreamTimeoutMs));
if (cfg.providers.qoder.enabled) {
  const bridge = await startBridge({
    binaryPath: cfg.providers.qoder.bridgePath,
    dataPath: "bridges/qoder-data.json",
    pat: cfg.providers.qoder.pat,
    port: cfg.providers.qoder.bridgePort,
    apiKey: cfg.providers.qoder.bridgeApiKey,
  });
  providers.push(new QoderProvider(cfg.providers.qoder, bridge, cfg.upstreamTimeoutMs));
}
if (providers.length === 0) {
  console.error("[config] all providers are disabled — enable at least one in config.json");
  process.exit(1);
}

const app = new Hono();

app.use("*", cors());

// all2api's own Bearer auth (clients authenticate with cfg.apiKey, not the upstream keys)
app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${cfg.apiKey}`) {
    return c.json({ error: { message: "invalid or missing API key", type: "authentication_error" } }, 401);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true, providers: providers.map((p) => p.id) }));

app.get("/v1/models", async (c) => {
  const defaultId = cfg.defaultProvider;
  const data = (
    await Promise.all(
      providers.map(async (p) =>
        (await p.models()).map((id) => ({
          id: p.id === defaultId ? id : `${p.id}/${id}`,
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
