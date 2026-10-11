import type { ProviderAdapter, UpstreamResult } from "../types.js";
import { TraeCredentials } from "./credentials.js";

/**
 * Trae Intl（海外版）provider——MVP 骨架。
 *
 * 身份读取（storage.json 明文 / TRAE_API_TOKEN / ~/.trae_token）与模型表已就绪；
 * 聊天转发留空：Intl 走 AES-256-GCM agent v3（ProjectEio 路径），与 CN 的
 * 明文 llm_utils_chat 完全不同，需按 ProjectEio 抓包另起实现，本首版不碰。
 * openai/anthropic 一律 501，明确指向上游与 trae-cn。
 */

export interface TraeProviderConfig {
  enabled: boolean;
  /** 显式 token（最高优；留空走 TRAE_API_TOKEN > ~/.trae_token > storage.json）。 */
  apiToken?: string;
  /** 版本显式覆盖（Trae / TRAE SOLO；环境 TRAE_EDITION 同效，config 优先）。 */
  edition?: string;
  /** User 目录显式覆盖（环境 TRAE_DATA_DIR 同效，config 优先）。 */
  dataDir?: string;
  /** IDE 版本显式覆盖（默认读 local_env.json / TRAE_IDE_VERSION）。 */
  ideVersion?: string;
  /** 整 UA 覆盖（默认 `Trae/<ver>`）。 */
  userAgent?: string;
  /** 非空即为模型白名单（为空用内置兜底）。 */
  models: string[];
}

/** 兜底模型（静态；Intl 模型目录待 ProjectEio 路径实机后替换为拉取+白名单过滤）。 */
const DEFAULT_TRAE_MODELS = ["auto"];

function notImplemented(): UpstreamResult {
  return {
    status: 501,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        message: "trae (intl) chat is not implemented in this MVP — Intl AES-256-GCM agent v3 (ProjectEio path) reserved; use trae-cn for CN chat",
        type: "not_implemented",
      },
    }),
  };
}

export class TraeProvider implements ProviderAdapter {
  readonly id = "trae";
  private readonly credentials: TraeCredentials;
  private readonly modelsList: string[];

  constructor(
    config: TraeProviderConfig,
    private readonly timeoutMs: number,
  ) {
    // 构造期不碰磁盘（与 codebuddy 对齐，懒加载便于 orchestrator 接线）。
    this.credentials = new TraeCredentials({
      apiToken: config.apiToken?.trim() || undefined,
      edition: config.edition?.trim() || undefined,
      dataDir: config.dataDir?.trim() || undefined,
      ideVersion: config.ideVersion?.trim() || undefined,
      userAgent: config.userAgent?.trim() || undefined,
    });
    void this.timeoutMs;
    this.modelsList = config.models.length > 0 ? config.models : DEFAULT_TRAE_MODELS;
  }

  async models(): Promise<string[]> {
    return this.modelsList;
  }

  /** 诊断用：当前身份是否可用（读不到返回 null，不抛）。 */
  async probeIdentity(): Promise<{ uid: string; edition: string; source: string } | null> {
    try {
      const id = await this.credentials.get();
      return { uid: id.uid, edition: id.edition, source: id.source };
    } catch {
      return null;
    }
  }

  async openai(_model: string, _rawBody: string): Promise<UpstreamResult> {
    return notImplemented();
  }

  async anthropic(_model: string, _rawBody: string): Promise<UpstreamResult> {
    return notImplemented();
  }
}
