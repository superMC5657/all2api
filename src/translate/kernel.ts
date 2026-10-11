/**
 * Translate Kernel（转译内核）：流式 / 聚合共享语义的唯一收拢点。
 *
 * 收拢项（与旧注释编号对应）：
 *   - M10 tool-call 槽位重装：ToolCallLedger（id/index slotting + entries 台账）
 *   - H2 error-with-choices：hasUpstreamError（error 非空即错，即使同时带 choices）
 *   - M4 bad-JSON→max_tokens：tryParseToolInput / hasBadToolJson
 *   - M2 tool_use 覆盖：resolveAnthropicStopReason
 *   - M3/H3 usage 拆分：splitAnthropicUsage（input = prompt - cached，cache_read 照报；
 *     message_start usage 恒 0，真实用量只在尾帧透传）
 *   - SSE 成帧统一：takeSseFrame / decodeFrameJsonTexts / tailPayloadTexts
 *   - Anthropic 输出成帧：frameAnthropicEvent（`event: ..\ndata: ..\n\n`，LF）
 *   - Deep 逻辑下沉：AnthropicStreamKernel（block open/close 排序、stopped-entry reopen、
 *     M9 先关 tool 块再开 thinking/text）；OpenAIAggregateKernel（M11 index 0 过滤、L9 空响应拒绝）
 *
 * 行为分歧抉择（统一两种旧分歧时选其一，见文件尾注释 BEHAVIOR CHOICES）：
 *   - 分隔符选 openai-aggregate 侧：CRLF 安全正则 /(?:\r\n|\n|\r){2}/（不做 buffer 全量 replaceAll）。
 *   - 行 trim 选 openai-aggregate/zcode 侧：line.trim() 后判 data: 前缀，payload 再 trim。
 *   - 多 data 行选 openai-aggregate 侧：joined 整体 JSON.parse，失败回落逐行（M1d 不丢包；
 *     流式侧此前直接丢帧，此后获得同等容忍）。
 *   - tail 残余选 anthropic 侧超集：无 data: 前缀的残余仍尝试按原始 JSON 直解（聚合侧此前要求
 *     data: 前缀；超集兼容双方线上流量，有效 JSON 行为一致）。
 *   - 输出帧选 anthropic 侧：LF `\n\n` 结尾（聚合侧不产出 SSE，无冲突）。
 */

export interface UpstreamToolCallDelta {
  index?: number;
  id?: string | null;
  function?: { name?: string; arguments?: string };
}

export interface UpstreamChunkBase {
  error?: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/** H2：只要 error 非空即视为上游错误，即使同时携带 choices 也不当正常帧聚合/透传。 */
export function hasUpstreamError(chunk: UpstreamChunkBase): boolean {
  return chunk.error !== undefined && chunk.error !== null;
}

/** 流式侧错误文案（不截断；保持 anthropic.ts 旧口径）。 */
export function upstreamErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec["message"] === "string" && (rec["message"] as string).length > 0) {
      return rec["message"] as string;
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 聚合侧错误明细（500 字符截断；保持 openai-aggregate.ts 旧口径）。 */
export function upstreamErrorDetail(error: unknown): string {
  if (typeof error === "string") return error.slice(0, 500);
  if (error !== null && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec["message"] === "string" && (rec["message"] as string).length > 0) {
      return (rec["message"] as string).slice(0, 500);
    }
  }
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return String(error).slice(0, 500);
  }
}

// ---------------------------------------------------------------------------
// M10：tool-call 槽位台账
// ---------------------------------------------------------------------------

export interface ToolLedgerEntry {
  /** 上游 tool_call id（首次非空 id 绑定），用于 M10 去重/开新槽。 */
  id?: string;
  name?: string;
  /** 累积的 arguments 片段（原样拼接），用于 M4 坏 JSON 检测。 */
  json: string;
  upstreamIndex: number;
  /** 流式侧专用：Anthropic block 序号（聚合侧保持 -1，不使用）。 */
  anthropicIndex: number;
  started: boolean;
  /** 是否已输出 content_block_stop（M9 提前关闭后 finish 不再重复；重入时开新槽）。 */
  stopped: boolean;
}

/**
 * M10 分槽：按 id 分槽累积，无 id 回落 index（对齐两处旧实现逐行语义）。
 * 同 index 不同非空 id 开新槽，避免双 tool 同 index 的 arguments 拼成乱码。
 * index 映射永远指向该 index 的最新槽；id 映射指向所属槽。
 */
export class ToolCallLedger {
  readonly entries: ToolLedgerEntry[] = [];
  private readonly byIndex = new Map<number, ToolLedgerEntry>();
  private readonly byId = new Map<string, ToolLedgerEntry>();

  slot(upstreamIndex: number, newId: string | undefined, opts?: { reopenStopped?: boolean }): { entry: ToolLedgerEntry; isNew: boolean } {
    const reopenStopped = opts?.reopenStopped ?? false;
    if (newId && this.byId.has(newId)) {
      const known = this.byId.get(newId)!;
      // 高-2/M9-M10：已 stopped 的 entry 不可复用——调用方开新槽（流式侧），
      // 旧 entry 的 json 保留在 entries 中，仍参与 finish() 坏 JSON 判定。
      if (!(reopenStopped && known.stopped)) return { entry: known, isNew: false };
    } else {
      const byIndex = this.byIndex.get(upstreamIndex);
      let candidate: ToolLedgerEntry | undefined;
      if (!newId) {
        // 无 id：按 index 复用最新槽（延续片段）；无槽则开新槽。
        candidate = byIndex;
      } else if (!byIndex) {
        candidate = undefined; // 新 index + 新 id → 开新槽
      } else if (!byIndex.id) {
        // 该 index 首个 id：认领复用，不开新槽。
        byIndex.id = newId;
        this.byId.set(newId, byIndex);
        candidate = byIndex;
      } else if (byIndex.id === newId) {
        candidate = byIndex;
      } else {
        candidate = undefined; // 同 index 不同非空 id → 开新槽
      }
      if (candidate && !(reopenStopped && candidate.stopped)) return { entry: candidate, isNew: false };
    }
    const entry: ToolLedgerEntry = {
      id: newId,
      json: "",
      upstreamIndex,
      anthropicIndex: -1,
      started: false,
      stopped: false,
    };
    this.entries.push(entry);
    // index 映射永远指向该 index 的最新槽；id 映射指向所属槽。
    this.byIndex.set(upstreamIndex, entry);
    if (newId) this.byId.set(newId, entry);
    return { entry, isNew: true };
  }
}

/** M10 id 归一化：非空字符串才视为有效 id，否则按无 id（回落 index）处理。 */
export function normalizeToolId(rawId: unknown): string | undefined {
  return typeof rawId === "string" && rawId !== "" ? rawId : undefined;
}

// ---------------------------------------------------------------------------
// M4 / M2：坏 JSON 判定与 stop_reason
// ---------------------------------------------------------------------------

/** M4 单个 tool arguments 判定：空串视为 {}（不失败）；坏 JSON 保留原始串并标记失败。 */
export function tryParseToolInput(rawArgs: string | undefined | null): { input: unknown; failed: boolean } {
  if (rawArgs === undefined || rawArgs === null || rawArgs === "") return { input: {}, failed: false };
  try {
    return { input: JSON.parse(rawArgs) as unknown, failed: false };
  } catch {
    return { input: rawArgs, failed: true };
  }
}

/** M4 流式判定：任一累积 json 非空且坏 JSON 即视为截断（调用方已原样透传 delta，此处只定终止口径）。 */
export function hasBadToolJson(jsons: string[]): boolean {
  for (const raw of jsons) {
    if (!raw) continue;
    try {
      JSON.parse(raw);
    } catch {
      return true;
    }
  }
  return false;
}

export const ANTHROPIC_STOP_REASON: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

/**
 * M2+M4 终止口径：M4（坏 JSON→max_tokens）优先级高于 M2（有 tool 即 end_turn→tool_use）。
 */
export function resolveAnthropicStopReason(finishReason: string | null, hasTools: boolean, toolParseFailed: boolean): string {
  const base = ANTHROPIC_STOP_REASON[finishReason ?? ""] ?? "end_turn";
  if (toolParseFailed) return "max_tokens";
  if (hasTools && base === "end_turn") return "tool_use";
  return base;
}

// ---------------------------------------------------------------------------
// M3/H3：usage 拆分
// ---------------------------------------------------------------------------

export interface SplitAnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
}

/** M3 互斥口径：input_tokens = prompt_tokens - cached_tokens，cache_read 照报。 */
export function splitAnthropicUsage(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
} | null): SplitAnthropicUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheRead: cached,
  };
}

// ---------------------------------------------------------------------------
// SSE 成帧统一（输入解析 + Anthropic 输出封装）
// ---------------------------------------------------------------------------

/** SSE 事件分隔符：任意两种换行组合（\n\n / \r\n\r\n / \r\r 及混用），CRLF 安全。 */
export const SSE_SEPARATOR = /(?:\r\n|\n|\r){2}/;

export function takeSseFrame(buffer: string): { frame: string; rest: string } | null {
  const m = SSE_SEPARATOR.exec(buffer);
  if (!m || m.index === undefined) return null;
  return { frame: buffer.slice(0, m.index), rest: buffer.slice(m.index + m[0].length) };
}

function isDonePayloadText(trimmed: string): boolean {
  return trimmed === "" || trimmed === "[DONE]";
}

/**
 * 统一 data 行提取：每行 trim 后再判 data: 前缀（aggregate/zcode 侧）；
 * 空 payload 与 [DONE] 按行丢弃；同一事件内多行 data: 返回多行。
 */
export function extractDataTexts(frame: string): string[] {
  const out: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    out.push(data);
  }
  return out;
}

/**
 * 统一帧解码：多行 data 按 SSE 规范用 \n 拼接后整体 JSON.parse；
 * 若拼接体不是合法 JSON（某些上游把两个完整 chunk 挤进一帧、省略空行分隔），
 * 则回落为逐行解析，保证 M1d 类多 data 行不丢包（aggregate 侧语义；流式侧新增同等容忍）。
 * 返回待 JSON.parse 的文本列表（0..n 个）。
 */
export function decodeFrameJsonTexts(frame: string): string[] {
  const dataLines = extractDataTexts(frame);
  if (dataLines.length === 0) return [];
  const joined = dataLines.join("\n");
  try {
    JSON.parse(joined);
    return [joined];
  } catch {
    // 拼接体不是合法 JSON，走逐行回落。
    return dataLines;
  }
}

/**
 * tail 残余解码（上游 close 时 buffer 剩余无尾空行的内容）：
 * 先按正常帧解码；若无 data: 行（payloadOf 为空），则把残余整体 trim 后
 * 按原始 JSON 直解（anthropic 侧超集语义；聚合侧此前直接丢弃此类残余）。
 */
export function tailPayloadTexts(tail: string): string[] {
  const trimmedTail = tail.trim();
  if (!trimmedTail) return [];
  const framed = decodeFrameJsonTexts(tail);
  if (framed.length > 0) return framed;
  const direct = trimmedTail;
  if (isDonePayloadText(direct)) return [];
  return [direct];
}

/** Anthropic SSE 输出成帧（LF `\n\n` 结尾；保持 anthropic.ts 旧字节语义）。 */
export function frameAnthropicEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Deep 逻辑下沉：Anthropic 流式 kernel（M9/M10/M2/M4/H2/H3）
// ---------------------------------------------------------------------------

export interface AnthropicStreamDeltaToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface AnthropicStreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: AnthropicStreamDeltaToolCall[];
}

export interface AnthropicStreamChunk extends UpstreamChunkBase {
  choices?: Array<{ delta?: AnthropicStreamDelta; finish_reason?: string | null }>;
}

/** 由一串 OpenAI deltas（增量片段）组装 Anthropic SSE（服务端推送事件流）帧。 */
export class AnthropicStreamKernel {
  private blockIndex = -1;
  private openBlock: "thinking" | "text" | null = null;
  private readonly ledger = new ToolCallLedger();
  private nextFreeIndex = 0;
  private finishReason: string | null = null;
  private usage: UpstreamChunkBase["usage"];
  private readonly messageId: string;
  private errored = false;

  constructor(private readonly model: string) {
    this.messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    this.usage = undefined;
  }

  start(): string {
    // H3：message_start 的 usage 保持 0——网关在流起始时无法预知上游用量，
    // 真实用量只在尾帧 usage 到达后经 message_delta 透传。
    return frameAnthropicEvent("message_start", {
      type: "message_start",
      message: { id: this.messageId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  /** 上游错误载荷进入 error 状态后为 true；此时 finish() 不再补收尾帧。 */
  get hasError(): boolean {
    return this.errored;
  }

  /** 输入一个 OpenAI chunk（数据块）；返回零或多个 Anthropic SSE 帧。 */
  feed(chunk: AnthropicStreamChunk): string[] {
    if (this.errored) return [];
    // 上游错误载荷（如 data:{"error":{...}}）：有 error 字段、无正常 choices，
    // 不再当正常 chunk 吞掉，直接进入 error 状态并输出 event: error。
    const rawError = chunk?.error;
    if (rawError !== undefined && rawError !== null) {
      this.errored = true;
      return this.error(upstreamErrorMessage(rawError));
    }
    const out: string[] = [];
    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    if (delta.reasoning_content) {
      if (this.openBlock !== "thinking") {
        // M9：开新 thinking 块前先 close 所有已开 tool 块，保证块严格顺序开合。
        out.push(...this.closeAllToolBlocks());
        out.push(...this.closeOpenBlock());
        this.blockIndex = this.nextFreeIndex++;
        this.openBlock = "thinking";
        out.push(frameAnthropicEvent("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "", signature: "" } }));
      }
      out.push(frameAnthropicEvent("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } }));
    }

    if (delta.content) {
      if (this.openBlock !== "text") {
        // M9：开新 text 块前先 close 所有已开 tool 块，保证块严格顺序开合。
        out.push(...this.closeAllToolBlocks());
        out.push(...this.closeOpenBlock());
        this.blockIndex = this.nextFreeIndex++;
        this.openBlock = "text";
        out.push(frameAnthropicEvent("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } }));
      }
      out.push(frameAnthropicEvent("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text: delta.content } }));
    }

    // M10：新的非空 id 即开新块，不只靠 index（无 index/复用 index 的双 tool 场景）。
    // M4：input_json_delta 原样透传（不做 JSON 校验/重组），坏 JSON 判定推迟到 finish()。
    for (const call of delta.tool_calls ?? []) {
      const idx = call.index ?? 0;
      const newId = normalizeToolId(call.id);
      const { entry } = this.ledger.slot(idx, newId, { reopenStopped: true });
      if (entry.anthropicIndex < 0) {
        out.push(...this.closeOpenBlock());
        entry.anthropicIndex = this.nextFreeIndex++;
        entry.started = true;
        out.push(
          frameAnthropicEvent("content_block_start", {
            type: "content_block_start",
            index: entry.anthropicIndex,
            content_block: { type: "tool_use", id: call.id ?? `toolu_${crypto.randomUUID()}`, name: call.function?.name ?? "", input: {} },
          }),
        );
      }
      // tool_use 块名取首见非空（保持旧行为：start 帧 name 为首包名，后续包不再改名）。
      if (call.function?.name && !entry.name) entry.name = call.function.name;
      const args = call.function?.arguments;
      if (args) {
        entry.json += args;
        out.push(frameAnthropicEvent("content_block_delta", { type: "content_block_delta", index: entry.anthropicIndex, delta: { type: "input_json_delta", partial_json: args } }));
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  /** 关闭剩余 blocks（内容块）并输出收尾 delta（增量）/stop（结束）帧。 */
  finish(): string[] {
    // 错误后只发 event: error 就 close，禁止再补 message_delta/message_stop。
    if (this.errored) return [];
    const out = this.closeOpenBlock();
    for (const entry of this.ledger.entries) {
      if (!entry.stopped) {
        entry.stopped = true;
        out.push(frameAnthropicEvent("content_block_stop", { type: "content_block_stop", index: entry.anthropicIndex }));
      }
    }
    // M4：流式累积的 tool arguments 坏 JSON（截断）时强制 max_tokens，优先级高于 M2 的 tool_use 覆写。
    // input_json_delta 已原样透传，此处只做终止口径判定，不重写已发 delta。
    const toolParseFailed = hasBadToolJson(this.ledger.entries.map((e) => e.json));
    // M2：流式看 entries.length>0（含无 index/复用 index 的新块）时，把 end_turn 覆写为 tool_use。
    const stopReason = resolveAnthropicStopReason(this.finishReason, this.ledger.entries.length > 0, toolParseFailed);
    // H3+M3：message_delta usage 透传上游用量；互斥口径 input_tokens = prompt - cached，cache_read 照报。
    const split = splitAnthropicUsage(this.usage ?? undefined);
    out.push(
      frameAnthropicEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: split.inputTokens, output_tokens: split.outputTokens, cache_read_input_tokens: split.cacheRead },
      }),
    );
    out.push(frameAnthropicEvent("message_stop", { type: "message_stop" }));
    return out;
  }

  error(message: string): string[] {
    return [frameAnthropicEvent("error", { type: "error", error: { type: "api_error", message } })];
  }

  private closeOpenBlock(): string[] {
    if (this.openBlock === null) return [];
    const frame = frameAnthropicEvent("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.openBlock = null;
    return [frame];
  }

  /** M9：关闭所有尚未 stop 的 tool 块，保证后开的 thinking/text 块严格顺序开合。 */
  private closeAllToolBlocks(): string[] {
    const out: string[] = [];
    for (const entry of this.ledger.entries) {
      if (!entry.stopped) {
        entry.stopped = true;
        out.push(frameAnthropicEvent("content_block_stop", { type: "content_block_stop", index: entry.anthropicIndex }));
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Deep 逻辑下沉：OpenAI 聚合 kernel（M10/M11/H2/L9）
// ---------------------------------------------------------------------------

export interface AggregateStreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: UpstreamToolCallDelta[];
}

export interface AggregateStreamChunk extends UpstreamChunkBase {
  id?: string;
  model?: string;
  choices?: Array<{ index?: number; delta?: AggregateStreamDelta; finish_reason?: string | null }>;
}

export interface AggregateUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AggregatedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * 聚合收集器：content/reasoning 拼接 + M10 分槽 + M11（仅 index 0）+ H2。
 * 最终组装（L9 空响应拒绝、tool_calls 排序、finish 缺省）由调用方 build() 完成，
 * 保持与旧 openai-aggregate.ts 一致的 chat.completion 形状。
 */
export class OpenAIAggregateKernel {
  private readonly contentParts: string[] = [];
  private readonly reasoningParts: string[] = [];
  private readonly ledger = new ToolCallLedger();
  model = "";
  finishReason: string | null = null;
  usage: AggregateUsage | null = null;

  handleChunk(chunk: AggregateStreamChunk, errorPrefix: string): void {
    // H2：只要 chunk.error 非空即抛错（即使同时带 choices），与流式侧口径统一。
    // 禁止把错误帧当正常聚合，避免 error+choices 共存时吞错合成 200。
    if (hasUpstreamError(chunk)) {
      throw new Error(`${errorPrefix}upstream error: ${upstreamErrorDetail(chunk.error)}`);
    }
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) {
      this.usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? 0,
        completion_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      };
    }
    for (const choice of chunk.choices ?? []) {
      // M11 降级策略：上游 n>1（A/B 候选）时只聚合 index 0，直接忽略其他
      // choice，避免把两个候选的内容混包成一段乱码。
      if ((choice.index ?? 0) !== 0) continue;
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (delta.content) this.contentParts.push(delta.content);
      if (delta.reasoning_content) this.reasoningParts.push(delta.reasoning_content);
      for (const call of delta.tool_calls ?? []) {
        const idx = call.index ?? 0;
        const newId = normalizeToolId(call.id);
        const { entry } = this.ledger.slot(idx, newId);
        if (call.function?.name) entry.name = call.function.name;
        if (call.function?.arguments) entry.json += call.function.arguments;
      }
    }
  }

  get content(): string {
    return this.contentParts.join("");
  }

  get reasoning(): string {
    return this.reasoningParts.join("");
  }

  get toolEntries(): ToolLedgerEntry[] {
    return this.ledger.entries;
  }

  buildToolCalls(): AggregatedToolCall[] {
    // toolEntries 已按开槽顺序排列（M10 分槽插入序），直接输出保持稳定顺序。
    return this.ledger.entries.map((v) => ({ id: v.id ?? `call_${crypto.randomUUID()}`, type: "function" as const, function: { name: v.name ?? "", arguments: v.json } }));
  }
}

/*
 * BEHAVIOR CHOICES（行为分歧抉择说明，供 commit message 引用）：
 * 1. 分隔符：选 openai-aggregate 侧（CRLF 安全正则）， discarded anthropic 侧的 buffer
 *    全量 replaceAll(\r\n→\n)+\r→\n。两者对标准流量等价；正则侧不改动 JSON 字符串
 *    内部字符，更安全。线上字节语义不变。
 * 2. 行 trim：选 openai-aggregate/zcode 侧（line.trim() 后判 data: 前缀，payload 再 trim），
 *    discarded anthropic/trae-cn 侧的 trimStart。JSON.parse 对首尾空白不敏感，
 *    有效载荷行为一致。
 * 3. 单帧多 data 行：选 openai-aggregate 侧（joined 整体 parse，失败回落逐行；M1d），
 *    discarded anthropic 流式侧的直接丢帧。线上标准单 data 行流量字节一致；
 *    仅多 chunk 挤一帧的畸形流量从"丢帧"变为"容忍解析"（增量兼容）。
 * 4. tail 残余：选 anthropic 侧超集（无 data: 前缀残余仍尝试原始 JSON 直解），
 *    discarded 聚合侧的"必须含 data: 前缀"。标准流量（残余恒带 data: 或为空）字节一致；
 *    仅无前缀残余从"丢弃"变为"尝试解析"（增量兼容）。
 * 5. 输出帧：沿用 anthropic 侧 LF `event: ..\ndata: ..\n\n`（聚合侧不产出 SSE，无分歧）。
 * 6. tool 名：流式 start 帧 name 取首包非空名（旧行为：首包名快照，后续包不再改名；
 *    kernel 以 entry.name 首见锁定实现同等语义）。
 */
