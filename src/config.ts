import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appRoot } from "./app-root.js";

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
  /**
   * 3012 将判 DISABLED 时是否先自动轮换设备指纹（默认 true）。
   * 环境变量 ZCODE_RISK_AUTO_ROTATE 同效（1/true/yes/on 为开），config 显式值优先于环境变量。
   */
  riskAutoRotate?: boolean;
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
   * region（区域）：codebuddy 缺省 "cn"，codebuddyIntl 缺省 "intl"；
   * "auto" 仅为保旧配置兼容（按 auth.domain 经 pickBase 动态路由）。
   * - "cn"：强制 CN 后端（copilot.tencent.com）；遇到海外 domain（workbuddy.ai/codebuddy.ai）抛错提示去开 codebuddyIntl；
   * - "intl"：强制 Global 后端（空 domain 默认 www.workbuddy.ai；workbuddy.ai/codebuddy.ai 均接受）；
   *   遇到 CN domain 抛错提示去开 codebuddy。
   * 双开（providers.codebuddy + providers.codebuddyIntl）必须给两边配不同的 authDir
   * （/ WORKBUDDY_AUTH_FILE / vscdbPath），否则默认探测会撞到同一份 session
   * （磁盘同一 CLI 只保留 ONE session，以 auth.domain 区分）。
   */
  region?: "auto" | "cn" | "intl";
  /**
   * auth 目录显式覆盖（其下 *.info 文件；也可直接指向单个 *.info 文件）。
   * 缺省自动探测（双 App 都要探测，cn/auto 为 CodeBuddy 在前，intl 为 WorkBuddy 在前）：
   * Windows 为 %LOCALAPPDATA% 下的 CodeBuddyExtension / WorkBuddyExtension；
   * Linux 为 $XDG_DATA_HOME → ~/.local/share → $XDG_CONFIG_HOME → ~/.config 下的同名双目录。
   * 双开时两边必须指向两份不同登录（见 region 注释）。
   */
  authDir?: string;
  /**
   * Electron 二进制显式覆盖（WORKBUDDY_ELECTRON_BIN 环境变量优先于此）。
   * 缺省自动探测（双 App 都要探测，cn/auto 为 WorkBuddy 在前，intl 为 WorkBuddy AI 在前）：
   * Windows 为 Program Files / LOCALAPPDATA 下的 Tencent WorkBuddy / CodeBuddy + 注册表卸载项双查；
   * Linux 为实测 buddycn 真实路径（/usr/share/buddycn/bin/buddycn）→ PATH 中的
   * codebuddy/workbuddy/buddycn → /opt 下 *buddy* 目录 → /usr/share 下 *buddy* 目录
   * → .desktop 桌面项 Exec → 常规安装位（intl 下 workbuddy 优先、buddycn 沉底）。
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
   * 未显式指定 vscdbKey 时候选顺序随 region：cn/auto 为 accessTokencn 优先，
   * intl 为 accessToken（海外）优先。
   */
  vscdbPath?: string;
  /** vscdb ItemTable 键名（默认 planning-genie.new.accessTokencn）。 */
  vscdbKey?: string;
  /** 钥匙环 application 名（默认 CodeBuddy CN）。 */
  vscdbApp?: string;
  /** vscdb 应用目录名覆盖（默认 CodeBuddy CN，仅改变平台惯例路径中的目录段）。 */
  vscdbDir?: string;
}

export interface TraeProviderConfig {
  enabled: boolean;
  /**
   * 显式 token（最高优；留空走环境/文件/storage.json）。
   * - trae-cn：config.apiToken > TRAE_CN_API_TOKEN > ~/.trae_cn_token > storage.json；
   * - trae（intl）：config.apiToken > TRAE_API_TOKEN > ~/.trae_token > storage.json。
   */
  apiToken?: string;
  /**
   * 版本显式覆盖（config 优先于 TRAE_EDITION 环境变量）。
   * - trae-cn：TRAE SOLO CN / Trae CN；
   * - trae（intl）：Trae / TRAE SOLO。
   */
  edition?: string;
  /**
   * User 目录显式覆盖（视为 User 目录直接用；config 优先于环境变量）。
   * - trae-cn：TRAE_CN_DATA_DIR；trae（intl）：TRAE_DATA_DIR。
   * 兼容别名见 authDir，两者都填时 dataDir 优先。
   */
  dataDir?: string;
  /** dataDir 的别名；两者都填时 dataDir 优先。 */
  authDir?: string;
  /** IDE 版本显式覆盖（默认读 local_env.json / TRAE_IDE_VERSION）。 */
  ideVersion?: string;
  /** 整 UA 覆盖（默认 `Trae/<ver>`）。 */
  userAgent?: string;
  /**
   * 非空即为模型白名单（为空用内置兜底 ["auto"]）。
   * tc 信封盐仅走 TRAE_TC_SALT 环境变量（诊断先跑 `npm run decrypt:trae` 核对）。
   */
  models: string[];
}

export interface All2ApiConfig {
  host: string;
  port: number;
  /** 客户端访问 all2api 本身必须携带的 Bearer 密钥 */
  apiKey: string;
  defaultProvider: string;
  upstreamTimeoutMs: number;
  /**
   * 严格模型校验开关（缺省 false=透传任意模型名，保旧配置兼容）。
   * true=只允许各渠道 models 表内模型：/v1/models 本就只列这些，
   * 转发遇到解析后不在目标渠道 models() 表里的模型直接 400。
   */
  strictModels: boolean;
  providers: {
    zcode: ZCodeProviderConfig;
    qoder: QoderProviderConfig;
    qoderIntl: QoderProviderConfig;
    codebuddy: CodeBuddyProviderConfig;
    codebuddyIntl: CodeBuddyProviderConfig;
    trae: TraeProviderConfig;
    "trae-cn": TraeProviderConfig;
  };
}

/**
 * resolve 后的对外配置——loadConfig 唯一返回的形状（收窄后的 Config surface）：
 * - 顶层 host/port/apiKey 已叠加 env 覆盖，strictModels 已归一为 boolean；
 * - 各渠道 models 表已规整为非空（缺失/全空回落各渠道默认值；条目 trim 去空），
 *   forward 的 strictModels 探针（经 provider.models() 读表）与 /v1/models 列表
 *   拿到的就是这张现成结论，不再各自解读原始 models 表；
 * - codebuddy 系 region 已补槽位缺省（codebuddy→"cn"、codebuddyIntl→"intl"，
 *   显式 "auto" 保留），调用方不再 `??`；
 * - trae 系 dataDir 已是 `dataDir || authDir` 的归一结论（dataDir 优先，缺省 ""），
 *   调用方直接用 dataDir，不再读 authDir。
 * 文件格式（config.jsonc / config.example.jsonc）与有效配置语义不变。
 */
export interface ResolvedCodeBuddyProviderConfig extends Omit<CodeBuddyProviderConfig, "region" | "models"> {
  /** 归一结论：显式 cn/intl/auto 保留，其余（缺失/空/非法）回槽位缺省。 */
  region: "auto" | "cn" | "intl";
  /** 规整后的非空模型表（缺失/全空回落内置默认表）。 */
  models: string[];
}

export interface ResolvedTraeProviderConfig extends Omit<TraeProviderConfig, "dataDir" | "models"> {
  /**
   * 归一结论：`dataDir || authDir`（dataDir 优先，取 trim 后首个非空，缺省 ""）。
   * 调用方直接用此字段；authDir 保留仅为回显文件原值，不要再解读。
   */
  dataDir: string;
  /** 规整后的非空模型表（缺失/全空回落 ["auto"]）。 */
  models: string[];
}

export interface ResolvedAll2ApiConfig extends Omit<All2ApiConfig, "providers"> {
  providers: {
    zcode: ZCodeProviderConfig;
    qoder: QoderProviderConfig;
    qoderIntl: QoderProviderConfig;
    codebuddy: ResolvedCodeBuddyProviderConfig;
    codebuddyIntl: ResolvedCodeBuddyProviderConfig;
    trae: ResolvedTraeProviderConfig;
    "trae-cn": ResolvedTraeProviderConfig;
  };
}

const CONFIG_JSONC_PATH = join(appRoot(), "config.jsonc");
const CONFIG_LEGACY_PATH = join(appRoot(), "config.json");

/**
 * 路径解析（load 三步的前置查找，纯判断、无 exit：
 * 两文件都缺失时返回 null，由最外层 loadConfig 统一报 console.error + process.exit）。
 * 顺序：优先 config.jsonc；仅 jsonc 缺失且 legacy config.json 存在时回落
 * （外层 warn 一次提示迁移）。
 */
function findConfigPath(): { path: string; isLegacy: boolean } | null {
  if (existsSync(CONFIG_JSONC_PATH)) return { path: CONFIG_JSONC_PATH, isLegacy: false };
  if (existsSync(CONFIG_LEGACY_PATH)) return { path: CONFIG_LEGACY_PATH, isLegacy: true };
  return null;
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

/** CodeBuddy 默认模型表（CN/Intl 共用展示 + 兜底；/v1/models 前缀由 provider id 区分）。 */
const CODEBUDDY_MODELS: string[] = [
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
];

/** 各 region 默认 CodeBuddy provider 配置的工厂函数（每次调用返回全新的 models 数组）。 */
function makeDefaultCodeBuddyConfig(region: "auto" | "cn" | "intl", enabled: boolean): CodeBuddyProviderConfig {
  return { enabled, userAgent: "all2api/0.1", region, models: [...CODEBUDDY_MODELS] };
}

const DEFAULTS: All2ApiConfig = {
  host: "127.0.0.1",
  port: 8787,
  apiKey: "",
  defaultProvider: "qoderIntl",
  upstreamTimeoutMs: 600_000,
  // 缺省 false=透传任意模型名（保旧配置兼容）；true=只允许各渠道 models 表内模型。
  strictModels: false,
  providers: {
    zcode: {
      enabled: false,
      jwt: "",
      // 空=跟随本地安装（注册表>exe>runtime）；显式填写才覆盖探测
      appVersion: "",
      // 3012 将判 DISABLED 时先自动轮换设备指纹（默认开；ZCODE_RISK_AUTO_ROTATE=0/false/no/off 可关）
      riskAutoRotate: true,
      // 2026-09-26 Start Plan JWT 通道：Anthropic/OpenAI 双协议统一走
      // https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages + Bearer JWT，
      // 不再依赖 open.bigmodel.cn / api.z.ai 按量端点。
      models: ["glm-5.3-flash", "glm-5.3-flashx"],
    },
    qoder: makeDefaultQoderConfig("cn"),
    qoderIntl: makeDefaultQoderConfig("intl"),
    trae: {
      enabled: false,
      apiToken: "",
      edition: "",
      dataDir: "",
      // 2026-10-10 Intl 首版为聊天 501 骨架（AES-256-GCM agent v3 预留），模型表静态兜底 ["auto"]。
      models: ["auto"],
    },
    "trae-cn": {
      enabled: false,
      apiToken: "",
      edition: "",
      dataDir: "",
      // 2026-10-10 CN 直连 AgentHost 轻聊天（solo_work_lite），动态模型表待实机后接，先静态兜底 ["auto"]。
      models: ["auto"],
    },
    codebuddy: {
      ...makeDefaultCodeBuddyConfig("cn", true),
      // 2026-09-26 实测网关逐个验证过；腾讯网关无模型目录接口，
      // 桌面端列表是它自己动态拉的，新模型出现时按 ID 规律探测补充
    },
    // 海外版默认关闭（避免老用户升级被 breaking；双开时与 codebuddy 共存，
    // 两边必须配不同的 authDir，否则默认探测会撞到同一份 session）。
    codebuddyIntl: {
      ...makeDefaultCodeBuddyConfig("intl", false),
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

// ── load / resolve / persist 三步 ──────────────────────────────────
// loadConfig（最外层入口）是唯一碰 process.exit 与磁盘写的地方；
// 三个步骤函数只做纯逻辑（load 仅读盘，不 exit、不写盘）。

/** 第一步 load 的产物：文件原文 + 解析后的 file shape + 遗留 bridges/qoder-cn.json 的 pat 回退。 */
interface RawConfigLoad {
  rawText: string;
  file: Partial<All2ApiConfig>;
  legacyQoderCnPat: string;
}

/** 遗留回退：bridges/qoder-cn.json 里遗留的 pat（读不到/非法一律当没有）。 */
function readLegacyQoderCnPat(): string {
  try {
    const legacyPath = join(appRoot(), "bridges", "qoder-cn.json");
    if (!existsSync(legacyPath)) return "";
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as { pat?: unknown };
    return typeof legacy.pat === "string" ? legacy.pat.trim() : "";
  } catch {
    // 读不到遗留文件就当没有，bridge 启动时还会再警告
    return "";
  }
}

/**
 * 第一步 load：只做读取+解析（JSONC 解析、legacy bridges/qoder-cn.json 回退读取）。
 * 不 exit、不写盘；缺失处理与写回由最外层 loadConfig 负责。
 */
function loadRawConfig(configPath: string): RawConfigLoad {
  const rawText = readFileSync(configPath, "utf8");
  return {
    rawText,
    file: parseJsonc<Partial<All2ApiConfig>>(rawText),
    legacyQoderCnPat: readLegacyQoderCnPat(),
  };
}

/** models 表规整：非数组/全空（trim 后无有效字符串）回落各渠道默认表；返回全新数组。 */
function normalizeModels(raw: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const cleaned = raw
    .filter((m): m is string => typeof m === "string")
    .map((m) => m.trim())
    .filter((m) => m !== "");
  return cleaned.length > 0 ? cleaned : [...fallback];
}

/** codebuddy 系 region 归一：显式 cn/intl/auto 保留，其余（缺失/空/非法）回槽位缺省。 */
function resolveCodeBuddyRegion(raw: unknown, slotDefault: "cn" | "intl"): "auto" | "cn" | "intl" {
  const v = typeof raw === "string" ? raw.trim() : "";
  return v === "cn" || v === "intl" || v === "auto" ? v : slotDefault;
}

/** trae 系 dataDir 归一结论：dataDir || authDir（dataDir 优先，取 trim 后首个非空，缺省 ""）。 */
function resolveTraeDataDir(file: TraeProviderConfig | undefined): string {
  return file?.dataDir?.trim() || file?.authDir?.trim() || "";
}

/** zcode 风控指纹轮换开关：config 显式值 > ZCODE_RISK_AUTO_ROTATE > 默认 true。 */
function resolveZCodeRiskAutoRotate(fileValue: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof fileValue === "boolean") return fileValue;
  const raw = env["ZCODE_RISK_AUTO_ROTATE"]?.trim().toLowerCase();
  if (!raw) return true;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * 第二步 resolve：纯函数——env 覆盖应用 + 默认值合并 + models 表规整 +
 * codebuddy region 缺省 + trae dataDir||authDir 归一。不读盘、不写盘、不 exit。
 */
export function resolveConfig(
  fileConfig: Partial<All2ApiConfig>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAll2ApiConfig {
  const fileProviders = fileConfig.providers;
  return {
    host: env["ALL2API_HOST"] ?? fileConfig.host ?? DEFAULTS.host,
    port: Number(env["ALL2API_PORT"] ?? fileConfig.port ?? DEFAULTS.port),
    apiKey: env["ALL2API_API_KEY"] ?? fileConfig.apiKey ?? DEFAULTS.apiKey,
    defaultProvider: fileConfig.defaultProvider ?? DEFAULTS.defaultProvider,
    upstreamTimeoutMs: fileConfig.upstreamTimeoutMs ?? DEFAULTS.upstreamTimeoutMs,
    // strictModels 开关归一化（缺省 false=透传任意模型名，保旧配置兼容）。
    strictModels: fileConfig.strictModels === true,
    providers: {
      zcode: {
        ...DEFAULTS.providers.zcode,
        ...fileProviders?.zcode,
        models: normalizeModels(fileProviders?.zcode?.models, DEFAULTS.providers.zcode.models),
        riskAutoRotate: resolveZCodeRiskAutoRotate(fileProviders?.zcode?.riskAutoRotate, env),
      },
      qoder: {
        ...DEFAULTS.providers.qoder,
        ...fileProviders?.qoder,
        models: normalizeModels(fileProviders?.qoder?.models, DEFAULTS.providers.qoder.models),
      },
      qoderIntl: {
        ...DEFAULTS.providers.qoderIntl,
        ...fileProviders?.qoderIntl,
        models: normalizeModels(fileProviders?.qoderIntl?.models, DEFAULTS.providers.qoderIntl.models),
      },
      codebuddy: {
        ...DEFAULTS.providers.codebuddy,
        ...fileProviders?.codebuddy,
        region: resolveCodeBuddyRegion(fileProviders?.codebuddy?.region, "cn"),
        models: normalizeModels(fileProviders?.codebuddy?.models, DEFAULTS.providers.codebuddy.models),
      },
      codebuddyIntl: {
        ...DEFAULTS.providers.codebuddyIntl,
        ...fileProviders?.codebuddyIntl,
        region: resolveCodeBuddyRegion(fileProviders?.codebuddyIntl?.region, "intl"),
        models: normalizeModels(fileProviders?.codebuddyIntl?.models, DEFAULTS.providers.codebuddyIntl.models),
      },
      trae: {
        ...DEFAULTS.providers.trae,
        ...fileProviders?.trae,
        dataDir: resolveTraeDataDir(fileProviders?.trae),
        models: normalizeModels(fileProviders?.trae?.models, DEFAULTS.providers.trae.models),
      },
      "trae-cn": {
        ...DEFAULTS.providers["trae-cn"],
        ...fileProviders?.["trae-cn"],
        dataDir: resolveTraeDataDir(fileProviders?.["trae-cn"]),
        models: normalizeModels(fileProviders?.["trae-cn"]?.models, DEFAULTS.providers["trae-cn"].models),
      },
    },
  };
}

/**
 * 第三步 persist：纯函数——apiKey 缺失/占位时生成新 key 并算出回写文本，
 * 不碰磁盘；是否写盘由最外层 loadConfig 决定。
 */
function persistApiKey(rawText: string, apiKey: string): { apiKey: string; nextText: string | null } {
  if (apiKey.trim() && apiKey.trim() !== "sk-all2api-change-me") return { apiKey, nextText: null };
  const generated = `sk-all2api-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return { apiKey: generated, nextText: persistApiKeyPreservingComments(rawText, generated) };
}

/**
 * 最外层入口：编排 load → resolve → persist，并承担全部副作用——
 * 本函数是 config 模块唯一调用 process.exit 与 writeFileSync 的地方。
 */
export function loadConfig(): ResolvedAll2ApiConfig {
  const found = findConfigPath();
  if (!found) {
    console.error("[config] config.jsonc not found — cp config.example.jsonc config.jsonc then edit apiKey/providers");
    process.exit(1);
  }
  if (found.isLegacy) {
    console.warn("[config] using legacy config.json — cp config.json config.jsonc to migrate");
  }
  // load：读取+解析（含 JSONC、legacy bridges/qoder-cn.json 回退）。
  const loaded = loadRawConfig(found.path);
  // resolve：env 覆盖、默认值与 models 表规整（region 缺省、dataDir||authDir 归一）。
  const cfg = resolveConfig(loaded.file);
  // persist：apiKey 自动生成回写（磁盘写只在这里）。
  const persisted = persistApiKey(loaded.rawText, cfg.apiKey);
  if (persisted.nextText !== null) {
    const next = persisted.nextText;
    writeFileSync(found.path, next.endsWith("\n") ? next : next + "\n");
    console.log(`[config] apiKey missing or placeholder — generated a new one and wrote it to ${found.path}`);
    cfg.apiKey = persisted.apiKey;
  }
  // qoder 配置体验校验（只 warn、不 throw，旧 config.jsonc（或 legacy config.json）形状缺字段时也能跑但要提示清楚）。
  if (cfg.providers.qoder.enabled) {
    const filePat = cfg.providers.qoder.pat?.trim() ?? "";
    if (!filePat && !loaded.legacyQoderCnPat && !readQoderCnIdeIdentity()) {
      warnNoCredential("cn", cfg.providers.qoder.bridgePort);
    }
  }
  if (cfg.providers.qoderIntl.enabled && !cfg.providers.qoderIntl.pat?.trim()) {
    warnNoCredential("intl", cfg.providers.qoderIntl.bridgePort);
  }
  return cfg;
}
