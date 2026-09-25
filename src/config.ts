import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ZCodeProviderConfig {
  enabled: boolean;
  /** Explicit API key; when empty, the key is decrypted from ~/.zcode/v2/credentials.json */
  apiKey?: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  models: string[];
}

export interface QoderProviderConfig {
  enabled: boolean;
  /** Personal Access Token from Qoder Integrations (pt-…). Empty = bridge admin panel or previous data.json value is used. */
  pat?: string;
  /** Path to the qoder2api sidecar binary (Qoder-2API-Go). */
  bridgePath: string;
  /** Local port the sidecar listens on. */
  bridgePort: number;
  /** Bearer key all2api uses towards the sidecar. */
  bridgeApiKey?: string;
  /** Fallback model ids when the sidecar catalog is unavailable. */
  models: string[];
}

export interface All2ApiConfig {
  host: string;
  port: number;
  /** Bearer key clients must send to all2api itself */
  apiKey: string;
  defaultProvider: string;
  upstreamTimeoutMs: number;
  providers: {
    zcode: ZCodeProviderConfig;
    qoder: QoderProviderConfig;
  };
}

const CONFIG_PATH = join(process.cwd(), "config.json");

const DEFAULTS: All2ApiConfig = {
  host: "127.0.0.1",
  port: 8787,
  apiKey: "",
  defaultProvider: "zcode",
  upstreamTimeoutMs: 600_000,
  providers: {
    zcode: {
      enabled: true,
      anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
      openaiBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      models: ["glm-5.3-flash", "glm-5.3", "glm-5.3-flashx"],
    },
    qoder: {
      enabled: false,
      bridgePath: "bridges/qoder2api.exe",
      bridgePort: 10081,
      models: ["Qwen3.8-Max", "DeepSeek-V4-Pro", "GLM-5.3", "Kimi-K2.7-Code", "MiniMax-M2.7"],
    },
  },
};

export function loadConfig(): All2ApiConfig {
  let fileConfig: Partial<All2ApiConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    fileConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<All2ApiConfig>;
  } else {
    const generated: All2ApiConfig = {
      ...DEFAULTS,
      apiKey: `sk-all2api-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(generated, null, 2) + "\n");
    console.log(`[config] created ${CONFIG_PATH} with a generated apiKey — edit it to your liking`);
    fileConfig = generated;
  }

  const cfg: All2ApiConfig = {
    ...DEFAULTS,
    ...fileConfig,
    providers: {
      zcode: { ...DEFAULTS.providers.zcode, ...fileConfig.providers?.zcode },
      qoder: { ...DEFAULTS.providers.qoder, ...fileConfig.providers?.qoder },
    },
  };
  cfg.host = process.env.ALL2API_HOST ?? cfg.host;
  cfg.port = Number(process.env.ALL2API_PORT ?? cfg.port);
  cfg.apiKey = process.env.ALL2API_API_KEY ?? cfg.apiKey;
  if (!cfg.apiKey) {
    cfg.apiKey = `sk-all2api-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    console.warn(`[config] no apiKey configured — generated a temporary one for this run: ${cfg.apiKey}`);
  }
  return cfg;
}
