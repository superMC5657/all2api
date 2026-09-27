import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readQoderCnIdeIdentity } from "./providers/qoder/credentials.js";
import { makeDefaultQoderConfig, type QoderRegion } from "./providers/qoder/constants.js";

export interface ZCodeProviderConfig {
  enabled: boolean;
  /**
   * Start Plan JWT（eyJ…）。留空/缺省则自动读本机 `zcode login` 的
   * ~/.zcode/v2/credentials.json（zcodeJwt）；非空视为显式 JWT 优先使用。
   * 禁配 bigmodel/open.bigmodel.cn 的 API Key——按量（coding-plan）通道已移除。
   */
  jwt?: string;
  models: string[];
  /** ZCode 桌面端版本号仿真（上游身份头 X-ZCode-App-Version）。留空跟随本机 zcode 安装（注册表>exe>runtime）；显式填写才覆盖探测；都找不到回落 CLIENT_APP_VERSION_DEFAULT 常量 */
  appVersion?: string;
  /** 一号一台设备指纹持久化文件，默认 ~/.zcode/v2/all2api-device.json */
  deviceFile?: string;
}

export interface QoderProviderConfig {
  enabled: boolean;
  /**
   * 来自 Qoder Integrations 的 Personal Access Token（pt-…）。
   * - cn 国内版 (region: "cn")：PAT 与本机 IDE 登录二选一——
   *   ① config.jsonc 的 `pat`；② sidecar 管理后台填的 PAT；③ `bridges/qoder-cn.json` 里遗留的 pat；
   *   ④ 留空则自动复用本机 Qoder CN 桌面端登录（auth.v1.dat + 系统钥匙环，
   *   此时 bridges 数据文件里写 "cn" 标记仅为通过 Go 非空门槛，真鉴权走 IDE 身份）。
   *   有真实 PAT 时 PAT 优先。
   * - intl 海外版 (region: "intl")：填 "intl" 占位或真实 PAT，空 = 起不来
   *   （Go 门槛要求非空，此占位仅过门槛，真鉴权走本机 IDE 的 securityOauthToken；
   *   如有真实 intl PAT 可替换）。
   */
  pat?: string;
  /** qoder2api sidecar 二进制文件路径（Qoder-2API-Go）。 */
  bridgePath: string;
  /** sidecar 监听的本地端口。 */
  bridgePort: number;
  /** all2api 访问 sidecar 时使用的 Bearer 密钥。 */
  bridgeApiKey?: string;
  /** "cn"（默认）= gateway.qoder.com.cn；"intl" = 海外版 qoder.com 部署。 */
  region?: "cn" | "intl";
  /** sidecar 模型目录不可用时的回退模型 ID。 */
  models: string[];
}

export interface CodeBuddyProviderConfig {
  enabled: boolean;
  userAgent: string;
  models: string[];
  /**
   * auth 目录显式覆盖（其下 *.info 文件；也可直接指向单个 *.info 文件）。
   * 缺省自动探测（双 App 都要探测，CodeBuddy 在前）：Windows 为 %LOCALAPPDATA%
   * 下的 CodeBuddyExtension / WorkBuddyExtension；Linux 为 $XDG_DATA_HOME →
   * ~/.local/share → $XDG_CONFIG_HOME → ~/.config 下的同名双目录。
   */
  authDir?: string;
  /**
   * Electron 二进制显式覆盖（WORKBUDDY_ELECTRON_BIN 环境变量优先于此）。
   * 缺省自动探测（双 App 都要探测，WorkBuddy 在前）：Windows 为 Program Files /
   * LOCALAPPDATA 下的 Tencent WorkBuddy / CodeBuddy + 注册表卸载项双查；
   * Linux 为实测 buddycn 真实路径（/usr/share/buddycn/bin/buddycn）→ PATH 中的
   * codebuddy/workbuddy/buddycn → /opt 下 *buddy* 目录 → /usr/share 下 *buddy* 目录
   * → .desktop 桌面项 Exec → 常规安装位。
   */
  electronPath?: string;
  /** electronPath 的别名；两者都填时 electronPath 优先。 */
  electronBinary?: string;
  /**
   * at-rest 密钥 linked-binding 名显式覆盖（缺省按序尝试
   * workbuddy 系 → codebuddy 系 → buddy 系变体，任一命中即用；keyId 校验保留）。
   * 仅在各 App 绑定名与预设都不一致时需要。
   */
  keyBinding?: string;
  /**
   * CodeBuddy CN vscdb 凭据源（仅当 .info 不可用时 fallback，Win 行为不变）。
   * 缺省 state.vscdb 路径为 ~/.config/CodeBuddy CN/User/globalStorage/state.vscdb，
   * 覆盖顺序：CODEBUDDY_VSCDB 环境变量 > vscdbPath。
   */
  vscdbPath?: string;
  /** vscdb ItemTable 键名（默认 planning-genie.new.accessTokencn）。 */
  vscdbKey?: string;
  /** 钥匙环 application 名（默认 CodeBuddy CN）。 */
  vscdbApp?: string;
  /** vscdb 应用目录名覆盖（默认 CodeBuddy CN，仅改变平台惯例路径中的目录段）。 */
  vscdbDir?: string;
}

export interface All2ApiConfig {
  host: string;
  port: number;
  /** 客户端访问 all2api 本身必须携带的 Bearer 密钥 */
  apiKey: string;
  defaultProvider: string;
  upstreamTimeoutMs: number;
  providers: {
    zcode: ZCodeProviderConfig;
    qoder: QoderProviderConfig;
    qoderIntl: QoderProviderConfig;
    codebuddy: CodeBuddyProviderConfig;
  };
}

const CONFIG_JSONC_PATH = join(process.cwd(), "config.jsonc");
const CONFIG_LEGACY_PATH = join(process.cwd(), "config.json");

/** 解析顺序：优先 config.jsonc；仅 jsonc 缺失且 legacy config.json 存在时回落（warn 一次提示迁移）。 */
function resolveConfigPath(): string {
  if (existsSync(CONFIG_JSONC_PATH)) return CONFIG_JSONC_PATH;
  if (existsSync(CONFIG_LEGACY_PATH)) {
    console.warn("[config] using legacy config.json — cp config.json config.jsonc to migrate");
    return CONFIG_LEGACY_PATH;
  }
  console.error("[config] config.jsonc not found — cp config.example.jsonc config.jsonc then edit apiKey/providers");
  process.exit(1);
}

/**
 * 小而稳的 JSONC strip：正确处理字符串内的 `//` 与 `/* *\/`，
 * 支持 `//` / `/* *\/` 注释与尾逗号。零依赖，手写故只做配置场景够用的子集。
 */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        if (i + 1 < text.length) out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i = Math.min(i + 2, text.length);
      continue;
    }
    if (c === ",") {
      // 尾逗号：往前看跳过空白与注释，若紧跟 } 或 ] 则丢弃该逗号
      let j = i + 1;
      while (j < text.length) {
        if (/\s/.test(text[j] ?? "")) {
          j++;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "/") {
          j += 2;
          while (j < text.length && text[j] !== "\n") j++;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "*") {
          j += 2;
          while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
          continue;
        }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** JSONC 解析：config.jsonc / config.example.jsonc（含 // 与块注释、尾逗号）统一走这里。 */
function parseJsonc<T>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}

/** 找到顶层 {（跳过字符串与注释，避免命中注释里的花括号）。 */
function findRootBrace(raw: string): number {
  let inStr = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      i++;
      continue;
    }
    if (c === "/" && raw[i + 1] === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "{") return i;
    i++;
  }
  return -1;
}

const API_KEY_VALUE_RE = /("apiKey"\s*:\s*)(?:"(?:\\.|[^"\\])*"|[^,\}\n\r]+)/;

/**
 * 文本级回写 apiKey（保留原文件全部注释与格式）：
 * - 存在 "apiKey" 值时原地替换值；
 * - 缺失时在顶层 { 后插入一行。
 */
function persistApiKeyPreservingComments(raw: string, generated: string): string {
  if (API_KEY_VALUE_RE.test(raw)) return raw.replace(API_KEY_VALUE_RE, `$1"${generated}"`);
  const brace = findRootBrace(raw);
  if (brace === -1) return raw;
  const rest = raw.slice(brace + 1);
  // 空对象（仅空白/注释 + }）时不留尾逗号，其余情况补逗号
  const emptyObj = /^\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*\}/.test(rest);
  const line = `\n  "apiKey": "${generated}"${emptyObj ? "" : ","}`;
  return raw.slice(0, brace + 1) + line + rest;
}

const DEFAULTS: All2ApiConfig = {
  host: "127.0.0.1",
  port: 8787,
  apiKey: "",
  defaultProvider: "qoderIntl",
  upstreamTimeoutMs: 600_000,
  providers: {
    zcode: {
      enabled: false,
      jwt: "",
      // 空=跟随本地安装（注册表>exe>runtime）；显式填写才覆盖探测
      appVersion: "",
      // 2026-09-26 Start Plan JWT 通道：Anthropic/OpenAI 双协议统一走
      // https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages + Bearer JWT，
      // 不再依赖 open.bigmodel.cn / api.z.ai 按量端点。
      models: ["glm-5.3-flash", "glm-5.3-flashx"],
    },
    qoder: makeDefaultQoderConfig("cn"),
    qoderIntl: makeDefaultQoderConfig("intl"),
    codebuddy: {
      enabled: true,
      userAgent: "all2api/0.1",
      // 2026-09-26 实测网关逐个验证过；腾讯网关无模型目录接口，
      // 桌面端列表是它自己动态拉的，新模型出现时按 ID 规律探测补充
      models: [
        "glm-5.3-flash",
        "glm-5.3-flashx",
        "glm-5.3",
        "glm-5.2",
        "glm-5.1",
        "glm-5v-turbo",
        "kimi-k2.7",
        "kimi-k2.6",
        "kimi-k2.5",
        "deepseek-v4.1-flash",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "minimax-m3-pay",
        "hy4-preview",
        "hy3",
        "hy3-preview",
        "hy3-preview-agent",
        "auto",
      ],
    },
  },
};

/** 只 warn 不 throw 的凭据缺失提示（文案原样，legacy bridges/qoder-cn.json 只回落 cn）。 */
function warnNoCredential(region: QoderRegion, port: number): void {
  if (region === "intl") {
    console.warn(
      `[config] providers.qoderIntl.pat 为空（空 = 起不来）— 请填 "intl" 占位或真实 PAT；` +
        `占位仅过 Go 非空门槛，真鉴权走本机 IDE 登录`,
    );
    return;
  }
  console.warn(
    `[config] providers.qoder 已启用但无可用凭据（config.pat / sidecar 管理后台 / bridges/qoder-cn.json 遗留 / 本机 Qoder CN 桌面端登录都没找到）— ` +
      `请在 config.json 的 providers.qoder.pat 填写 pt-…（PAT 与 IDE 登录二选一，有 PAT 则 PAT 优先），或打开 http://127.0.0.1:${port}/admin（默认密码 password）填写后重启，或登录国内版 Qoder 桌面端后重启`,
  );
}

export function loadConfig(): All2ApiConfig {
  const configPath = resolveConfigPath();
  const raw = readFileSync(configPath, "utf8");
  const fileConfig: Partial<All2ApiConfig> = parseJsonc<Partial<All2ApiConfig>>(raw);

  const cfg: All2ApiConfig = {
    ...DEFAULTS,
    ...fileConfig,
    providers: {
      zcode: { ...DEFAULTS.providers.zcode, ...fileConfig.providers?.zcode },
      qoder: { ...DEFAULTS.providers.qoder, ...fileConfig.providers?.qoder },
      qoderIntl: { ...DEFAULTS.providers.qoderIntl, ...fileConfig.providers?.qoderIntl },
      codebuddy: { ...DEFAULTS.providers.codebuddy, ...fileConfig.providers?.codebuddy },
    },
  };
  cfg.host = process.env.ALL2API_HOST ?? cfg.host;
  cfg.port = Number(process.env.ALL2API_PORT ?? cfg.port);
  cfg.apiKey = process.env.ALL2API_API_KEY ?? cfg.apiKey;
  if (!cfg.apiKey?.trim() || cfg.apiKey.trim() === "sk-all2api-change-me") {
    const generated = `sk-all2api-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const next = persistApiKeyPreservingComments(raw, generated);
    writeFileSync(configPath, next.endsWith("\n") ? next : next + "\n");
    console.log(`[config] apiKey missing or placeholder — generated a new one and wrote it to ${configPath}`);
    cfg.apiKey = generated;
  }
  // qoder 配置体验校验（只 warn、不 throw，旧 config.jsonc（或 legacy config.json）形状缺字段时也能跑但要提示清楚）。
  if (cfg.providers.qoder.enabled) {
    const filePat = cfg.providers.qoder.pat?.trim() ?? "";
    let legacyPat = "";
    try {
      const legacyPath = join(process.cwd(), "bridges", "qoder-cn.json");
      if (existsSync(legacyPath)) {
        const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as { pat?: unknown };
        if (typeof legacy.pat === "string") legacyPat = legacy.pat.trim();
      }
    } catch {
      // 读不到遗留文件就当没有，bridge 启动时还会再警告
    }
    if (!filePat && !legacyPat && !readQoderCnIdeIdentity()) {
      warnNoCredential("cn", cfg.providers.qoder.bridgePort);
    }
  }
  if (cfg.providers.qoderIntl.enabled && !cfg.providers.qoderIntl.pat?.trim()) {
    warnNoCredential("intl", cfg.providers.qoderIntl.bridgePort);
  }
  return cfg;
}
