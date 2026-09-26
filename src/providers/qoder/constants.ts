/**
 * Qoder region（区域）单一来源常量（P2 去重）。
 * 不从 config/bridge 导入，以避免循环依赖。
 */

export type QoderRegion = "cn" | "intl";

/** 占位 PAT == region id（"cn" / "intl"）：仅用于通过 Go 非空门槛校验。 */
export const placeholderFor = (r: QoderRegion): string => r;

/** 区域对应的 provider id：cn -> "qoder"，intl -> "qoder-intl"。 */
export function regionToProviderId(region: QoderRegion): string {
  return region === "intl" ? "qoder-intl" : "qoder";
}

/** 某区域的 sidecar 数据文件。 */
export const dataPathFor = (r: QoderRegion): string => `bridges/qoder-${r}.json`;

/** 默认 sidecar 二进制路径（win32 使用 .exe）。 */
export function defaultBridgePath(): string {
  return process.platform === "win32" ? "bridges/qoder2api.exe" : "bridges/qoder2api";
}

/** cn 兜底模型列表（原文照录）。 */
export const QODER_MODELS_BASE: string[] = [
  "Qwen3.8-Max",
  "DeepSeek-V4-Pro",
  "GLM-5.3",
  "Kimi-K2.7-Code",
  "MiniMax-M2.7",
];

/** intl 兜底模型列表：BASE[0]、Qwen3.7-Max、…BASE.slice(1)。 */
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

/** 创建各区域默认 Qoder provider 配置的工厂函数（每次调用返回全新的 models 数组）。 */
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

/** 各区域 sidecar 的额外环境变量。 */
export const REGION_ENV: Record<QoderRegion, Record<string, string>> = {
  cn: {},
  intl: { QODER_REGION: "intl" },
};
