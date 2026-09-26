/**
 * Qoder region single-source constants (P2 dedup).
 * No imports from config/bridge to avoid cycles.
 */

export type QoderRegion = "cn" | "intl";

/** Placeholder PAT == region id ("cn" / "intl"): only clears the Go non-empty gate. */
export const placeholderFor = (r: QoderRegion): string => r;

/** Provider id for a region: cn -> "qoder", intl -> "qoder-intl". */
export function regionToProviderId(region: QoderRegion): string {
  return region === "intl" ? "qoder-intl" : "qoder";
}

/** Sidecar data file for a region. */
export const dataPathFor = (r: QoderRegion): string => `bridges/qoder-${r}.json`;

/** Default sidecar binary path (win32 uses .exe). */
export function defaultBridgePath(): string {
  return process.platform === "win32" ? "bridges/qoder2api.exe" : "bridges/qoder2api";
}

/** Fallback model list for cn (verbatim). */
export const QODER_MODELS_BASE: string[] = [
  "Qwen3.8-Max",
  "DeepSeek-V4-Pro",
  "GLM-5.3",
  "Kimi-K2.7-Code",
  "MiniMax-M2.7",
];

/** Fallback model list for intl: BASE[0], Qwen3.7-Max, ...BASE.slice(1). */
export const QODER_MODELS_INTL: string[] = [QODER_MODELS_BASE[0] as string, "Qwen3.7-Max", ...QODER_MODELS_BASE.slice(1)];

export interface QoderRegionDefaults {
  enabled: boolean;
  pat: string;
  bridgePort: number;
  models: string[];
}

export const QODER_REGION_DEFAULTS: Record<QoderRegion, QoderRegionDefaults> = {
  cn: {
    enabled: false,
    // explicit "": 待填，domestic 必填。cn 未填时保持空字符串直通，由 loadConfig() 校验提示（去 config 或 admin 填），
    // 避免字段缺失时旧 config.json（只有 baseUrl/models）合并后更迷惑。
    pat: "",
    bridgePort: 10081,
    models: QODER_MODELS_BASE,
  },
  intl: {
    enabled: true,
    // Go 门槛要求非空，此 "intl" 占位仅过门槛，真鉴权走本机 IDE 的 securityOauthToken；如有真实 intl PAT 可替换。
    pat: "intl",
    bridgePort: 10082,
    // 显示名，sidecar 映射到内部 key
    models: QODER_MODELS_INTL,
  },
};

export interface DefaultQoderConfig {
  enabled: boolean;
  pat: string;
  bridgePath: string;
  bridgePort: number;
  region: QoderRegion;
  models: string[];
}

/** Factory for the default per-region Qoder provider config (fresh models array per call). */
export function makeDefaultQoderConfig(region: QoderRegion): DefaultQoderConfig {
  const d = QODER_REGION_DEFAULTS[region];
  return {
    enabled: d.enabled,
    pat: d.pat,
    // win32 用 .exe，其余平台（Linux/macOS）用无后缀二进制。
    bridgePath: defaultBridgePath(),
    bridgePort: d.bridgePort,
    region,
    models: [...d.models],
  };
}

/** Extra env for the sidecar per region. */
export const REGION_ENV: Record<QoderRegion, Record<string, string>> = {
  cn: {},
  intl: { QODER_REGION: "intl" },
};
