/**
 * Anthropic <-> OpenAI 互译，面向仅支持 OpenAI chat completions（聊天补全接口）的上游
 * （Qoder 经 qoder2api 桥接接入）。
 *
 * 覆盖范围：system（系统提示）、text（文本）、images（图像）、tool definitions/calls/results
 * （工具定义/调用/结果）、thinking（思考块，reasoning_content）、双向 streaming（流式）。
 */

// ---------- 请求：Anthropic -> OpenAI ----------

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: string; media_type?: string; data?: string; url?: string } }
  | { type: "tool_use"; id?: string; name: string; input?: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };

export interface AnthropicRequest {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages: Array<{ role: string; content: string | AnthropicBlock[] }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
  thinking?: { type?: string; budget_tokens?: number };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
      .join("");
  }
  return "";
}

export function anthropicToOpenAI(req: AnthropicRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (req.system) {
    const text = typeof req.system === "string" ? req.system : req.system.map((p) => p.text ?? "").join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  for (const msg of req.messages ?? []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "assistant") {
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const toolCalls = msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const tb = b as Extract<AnthropicBlock, { type: "tool_use" }>;
          return {
            id: tb.id ?? `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
            type: "function",
            function: { name: tb.name, arguments: JSON.stringify(tb.input ?? {}) },
          };
        });
      const entry: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      messages.push(entry);
      continue;
    }

    // user（用户）消息：text（文本）/images（图像）内联，tool_results（工具结果）转为 "tool" 消息。
    // M6：先 push tool 消息、再 push inline text，保证 tool 紧跟上一个 assistant（含 tool_calls），
    // 满足 OpenAI tool 紧随 assistant 的顺序要求。
    const inline: Array<Record<string, unknown>> = [];
    const toolResults: Extract<AnthropicBlock, { type: "tool_result" }>[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        inline.push({ type: "text", text: (block as { text: string }).text });
      } else if (block.type === "image") {
        const src = (block as Extract<AnthropicBlock, { type: "image" }>).source;
        const url = src.type === "base64" ? `data:${src.media_type ?? "image/png"};base64,${src.data ?? ""}` : (src.url ?? "");
        if (url) inline.push({ type: "image_url", image_url: { url } });
      } else if (block.type === "tool_result") {
        toolResults.push(block as Extract<AnthropicBlock, { type: "tool_result" }>);
      }
    }
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: textOf(tr.content) || (tr.is_error ? "tool execution failed" : ""),
      });
    }
    if (inline.length > 0) {
      messages.push({ role: "user", content: inline.length === 1 && inline[0]!.type === "text" ? inline[0]!.text : inline });
    }
  }

  const tools = req.tools?.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object" } },
  }));

  // H1-req：Anthropic tool_choice -> OpenAI tool_choice。
  // 下游契约只允许 "auto"|"none"|"required" 字符串或 {type:"function",function:{name}} 对象：
  // none->"none"、auto->"auto"、any->"required"、tool->对象形式。
  let toolChoice: unknown;
  if (req.tool_choice) {
    const tc = req.tool_choice;
    if (tc.type === "none") toolChoice = "none";
    else if (tc.type === "auto") toolChoice = "auto";
    else if (tc.type === "any") toolChoice = "required";
    else toolChoice = { type: "function", function: { name: tc.name } };
  }

  // Anthropic thinking（思考）控制 → OpenAI reasoning_effort（推理强度）。仅在客户端显式要求时生效：
  // "enabled" 按 token 预算映射为 effort（强度）档位，
  // "disabled" 关闭思考（由支持该参数的上游执行——
  // 例如 qoder；zcode 改为原生透传 Anthropic 请求体，不走此处）。
  let reasoningEffort: string | undefined;
  if (req.thinking?.type === "enabled") {
    const budget = req.thinking.budget_tokens ?? 8192;
    reasoningEffort = budget <= 1024 ? "low" : budget <= 8192 ? "medium" : budget <= 32768 ? "high" : "xhigh";
  } else if (req.thinking?.type === "disabled") {
    reasoningEffort = "none";
  }

  return {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop_sequences,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools && tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
    stream: req.stream === true,
  };
}

// ---------- 响应：OpenAI -> Anthropic（非流式） ----------

interface OpenAIMessage {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning_content_signature?: string | null;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}
interface OpenAIResponse {
  id?: string;
  choices?: Array<{ message?: OpenAIMessage; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

const STOP_REASON: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

export function openAIToAnthropicResponse(resp: OpenAIResponse, model: string): Record<string, unknown> {
  const choice = resp.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: Array<Record<string, unknown>> = [];

  if (message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content, signature: message.reasoning_content_signature ?? "" });
  }
  if (message.content) content.push({ type: "text", text: message.content });
  // M4：tool 参数 JSON.parse 失败不再静默 {}——保留原始串，后续强制 stop_reason 为 max_tokens。
  // （上游 arguments 截断/坏 JSON 意味着输出被截断，按截断口径上报。）
  let toolParseFailed = false;
  for (const call of message.tool_calls ?? []) {
    const rawArgs = call.function?.arguments;
    let input: unknown = {};
    if (rawArgs === undefined || rawArgs === null || rawArgs === "") {
      input = {};
    } else {
      try {
        input = JSON.parse(rawArgs);
      } catch {
        input = rawArgs;
        toolParseFailed = true;
      }
    }
    content.push({ type: "tool_use", id: call.id ?? `toolu_${crypto.randomUUID()}`, name: call.function?.name ?? "", input });
  }

  // M2：非流式看 tool_calls.length>0 时，把 end_turn 覆写为 tool_use。
  // M4 优先级高于 M2：坏 JSON 时强制 max_tokens。
  let stopReason = STOP_REASON[choice.finish_reason ?? ""] ?? "end_turn";
  if (toolParseFailed) {
    stopReason = "max_tokens";
  } else if ((message.tool_calls?.length ?? 0) > 0 && stopReason === "end_turn") {
    stopReason = "tool_use";
  }

  // M3：互斥口径 input_tokens = prompt_tokens - cached_tokens，cache_read 照报。
  const cachedTokens = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const inputTokens = Math.max(0, (resp.usage?.prompt_tokens ?? 0) - cachedTokens);
  return {
    id: resp.id ?? `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cachedTokens,
    },
  };
}

// ---------- 流式：OpenAI SSE -> Anthropic SSE ----------

interface StreamChunk {
  choices?: Array<{ delta?: OpenAIMessage & { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: OpenAIResponse["usage"];
  error?: { message?: string; type?: string; code?: string } | string;
}

/** 由一串 OpenAI deltas（增量片段）组装 Anthropic SSE（服务端推送事件流）帧。 */
interface ToolBlockEntry {
  anthropicIndex: number;
  started: boolean;
  /** 上游 tool_call id（首次非空 id 绑定），用于 M10 去重/开新块。 */
  id?: string;
  /** 累积的 arguments 片段（原样拼接），用于 M4 坏 JSON 检测。 */
  json: string;
  /** 是否已输出 content_block_stop（M9 提前关闭后 finish 不再重复）。 */
  stopped: boolean;
  upstreamIndex: number;
}
class AnthropicStreamBuilder {
  private blockIndex = -1;
  private openBlock: "thinking" | "text" | null = null;
  private readonly toolBlocks = new Map<number, ToolBlockEntry>();
  private readonly toolIdMap = new Map<string, ToolBlockEntry>();
  private readonly allToolEntries: ToolBlockEntry[] = [];
  private nextFreeIndex = 0;
  private finishReason: string | null = null;
  private usage: OpenAIResponse["usage"];
  private readonly messageId: string;
  private errored = false;

  constructor(private readonly model: string) {
    this.messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    this.usage = undefined;
  }

  start(): string {
    // H3：message_start 的 usage 保持 0——网关在流起始时无法预知上游用量，
    // 真实用量只在尾帧 usage 到达后经 message_delta 透传。
    return this.frame("message_start", {
      type: "message_start",
      message: { id: this.messageId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  /** 上游错误载荷进入 error 状态后为 true；此时 finish() 不再补收尾帧。 */
  get hasError(): boolean {
    return this.errored;
  }

  /** 输入一个 OpenAI chunk（数据块）；返回零或多个 Anthropic SSE 帧。 */
  feed(chunk: StreamChunk): string[] {
    if (this.errored) return [];
    // 上游错误载荷（如 data:{"error":{...}}）：有 error 字段、无正常 choices，
    // 不再当正常 chunk 吞掉，直接进入 error 状态并输出 event: error。
    const rawError = (chunk as StreamChunk)?.error;
    if (rawError !== undefined && rawError !== null) {
      this.errored = true;
      const message =
        typeof rawError === "string"
          ? rawError
          : typeof rawError.message === "string" && rawError.message
            ? rawError.message
            : JSON.stringify(rawError);
      return this.error(message);
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
        out.push(this.frame("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "", signature: "" } }));
      }
      out.push(this.frame("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } }));
    }

    if (delta.content) {
      if (this.openBlock !== "text") {
        // M9：开新 text 块前先 close 所有已开 tool 块，保证块严格顺序开合。
        out.push(...this.closeAllToolBlocks());
        out.push(...this.closeOpenBlock());
        this.blockIndex = this.nextFreeIndex++;
        this.openBlock = "text";
        out.push(this.frame("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } }));
      }
      out.push(this.frame("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text: delta.content } }));
    }

    // M10：新的非空 id 即开新块，不只靠 index（无 index/复用 index 的双 tool 场景）。
    // M4：input_json_delta 原样透传（不做 JSON 校验/重组），坏 JSON 判定推迟到 finish()。
    for (const call of delta.tool_calls ?? []) {
      const idx = call.index ?? 0;
      const rawId = call.id;
      const newId = typeof rawId === "string" && rawId !== "" ? rawId : undefined;
      let entry: ToolBlockEntry | undefined;
      if (newId && this.toolIdMap.has(newId)) {
        entry = this.toolIdMap.get(newId)!;
      } else {
        const byIndex = this.toolBlocks.get(idx);
        if (!newId) {
          // 无 id：按 index 复用最新块（延续片段）；无块则开新块。
          entry = byIndex;
        } else if (!byIndex) {
          entry = undefined; // 新 index + 新 id → 开新块
        } else if (!byIndex.id) {
          // 该 index 首个 id：认领复用，不开新块。
          byIndex.id = newId;
          this.toolIdMap.set(newId, byIndex);
          entry = byIndex;
        } else if (byIndex.id === newId) {
          entry = byIndex;
        } else {
          entry = undefined; // 同 index 不同非空 id → 开新块
        }
      }
      // 高-2/M9-M10：closeAllToolBlocks 后迟到片段不得向已 stopped 的 entry
      // 发 input_json_delta（Anthropic 违例）。已 stop 的块不可复用——开新块
      // （新 anthropic index + content_block_start）；旧 entry 的 json 保留在
      // allToolEntries 中，仍参与 finish() 坏 JSON 判定。
      if (entry?.stopped) entry = undefined;
      if (!entry) {
        out.push(...this.closeOpenBlock());
        const anthropicIndex = this.nextFreeIndex++;
        entry = { anthropicIndex, started: true, id: newId, json: "", stopped: false, upstreamIndex: idx };
        this.allToolEntries.push(entry);
        // index 映射永远指向该 index 的最新块；id 映射指向所属块。
        this.toolBlocks.set(idx, entry);
        if (newId) this.toolIdMap.set(newId, entry);
        out.push(
          this.frame("content_block_start", {
            type: "content_block_start",
            index: anthropicIndex,
            content_block: { type: "tool_use", id: call.id ?? `toolu_${crypto.randomUUID()}`, name: call.function?.name ?? "", input: {} },
          }),
        );
      }
      const args = call.function?.arguments;
      if (args) {
        entry.json += args;
        out.push(this.frame("content_block_delta", { type: "content_block_delta", index: entry.anthropicIndex, delta: { type: "input_json_delta", partial_json: args } }));
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
    for (const entry of this.allToolEntries) {
      if (!entry.stopped) {
        entry.stopped = true;
        out.push(this.frame("content_block_stop", { type: "content_block_stop", index: entry.anthropicIndex }));
      }
    }
    // M4：流式累积的 tool arguments 坏 JSON（截断）时强制 max_tokens，优先级高于 M2 的 tool_use 覆写。
    // input_json_delta 已原样透传，此处只做终止口径判定，不重写已发 delta。
    let toolParseFailed = false;
    for (const entry of this.allToolEntries) {
      const raw = entry.json;
      if (raw) {
        try {
          JSON.parse(raw);
        } catch {
          toolParseFailed = true;
          break;
        }
      }
    }
    // M2：流式看 toolBlocks.size>0（此处为 allToolEntries.length>0，含无 index/复用 index 的新块）
    // 时，把 end_turn 覆写为 tool_use。
    let stopReason = STOP_REASON[this.finishReason ?? ""] ?? "end_turn";
    if (toolParseFailed) {
      stopReason = "max_tokens";
    } else if (this.allToolEntries.length > 0 && stopReason === "end_turn") {
      stopReason = "tool_use";
    }
    // H3+M3：message_delta usage 透传上游用量；互斥口径 input_tokens = prompt - cached，cache_read 照报。
    const cachedTokens = this.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const inputTokens = Math.max(0, (this.usage?.prompt_tokens ?? 0) - cachedTokens);
    out.push(
      this.frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: this.usage?.completion_tokens ?? 0, cache_read_input_tokens: cachedTokens },
      }),
    );
    out.push(this.frame("message_stop", { type: "message_stop" }));
    return out;
  }

  error(message: string): string[] {
    return [this.frame("error", { type: "error", error: { type: "api_error", message } })];
  }

  private closeOpenBlock(): string[] {
    if (this.openBlock === null) return [];
    const frame = this.frame("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.openBlock = null;
    return [frame];
  }

  /** M9：关闭所有尚未 stop 的 tool 块，保证后开的 thinking/text 块严格顺序开合。 */
  private closeAllToolBlocks(): string[] {
    const out: string[] = [];
    for (const entry of this.allToolEntries) {
      if (!entry.stopped) {
        entry.stopped = true;
        out.push(this.frame("content_block_stop", { type: "content_block_stop", index: entry.anthropicIndex }));
      }
    }
    return out;
  }

  private frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

/** 将 OpenAI SSE 流包装为 Anthropic SSE 流。 */
export function translateOpenAIStreamToAnthropic(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const builder = new AnthropicStreamBuilder(model);
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  let done = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const encoder = new TextEncoder();
      let madeProgress = false;
      const push = (text: string) => {
        madeProgress = true;
        controller.enqueue(encoder.encode(text));
      };

      if (done) {
        controller.close();
        return;
      }
      if (!started) {
        started = true;
        push(builder.start());
      }

      const reader = upstream.getReader();
      // 单帧多行 data: 按 SSE 规范用 \n 拼接；无 data: 行的帧（如 event:/注释）跳过。
      const payloadOf = (frame: string): string | null => {
        const lines = frame.split("\n");
        const dataParts: string[] = [];
        for (const line of lines) {
          // 低-8：容忍行首空格（trimStart 后再判 data: 前缀），与聚合器 trim 行为对齐。
          const trimmedLine = line.trimStart();
          if (trimmedLine.startsWith("data:")) dataParts.push(trimmedLine.slice(5).trimStart());
          else if (trimmedLine === "data" || trimmedLine === "data;") dataParts.push("");
        }
        if (dataParts.length === 0) return null;
        return dataParts.join("\n");
      };
      // 消费 buffer 中所有完整帧（\r\n 已归一化为 \n），有进展时标记。
      const drainFrames = (): boolean => {
        buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
        let sep: number;
        let errored = false;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // 空帧（心跳）跳过
          if (!frame.trim()) continue;
          const payload = payloadOf(frame);
          if (payload === null) continue;
          const trimmed = payload.trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            for (const out of builder.feed(JSON.parse(trimmed) as StreamChunk)) push(out);
          } catch {
            // 忽略上游发来的畸形帧
          }
          if (builder.hasError) {
            errored = true;
            break;
          }
        }
        return errored;
      };

      try {
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });

          if (drainFrames() || builder.hasError) {
            // 上游错误载荷：只发 event: error 就 close，不补 finish 收尾帧。
            // 中-6：close 前先 cancel 上游 reader 再 releaseLock（finally），防 socket 悬挂。
            try {
              await reader.cancel();
            } catch {
              // 忽略 cancel 自身失败
            }
            done = true;
            controller.close();
            return;
          }

          if (streamDone) {
            // 终 flush + drain 残余帧（含无尾空行的 usage 尾帧），再 finish。
            buffer += decoder.decode();
            if (drainFrames() || builder.hasError) {
              try {
                await reader.cancel();
              } catch {
                // 忽略 cancel 自身失败
              }
              done = true;
              controller.close();
              return;
            }
            const tail = buffer.trim();
            if (tail) {
              buffer = "";
              const payload = payloadOf(tail) ?? tail;
              const trimmed = payload.trim();
              if (trimmed && trimmed !== "[DONE]") {
                try {
                  for (const out of builder.feed(JSON.parse(trimmed) as StreamChunk)) push(out);
                } catch {
                  // 忽略上游发来的畸形帧
                }
              }
              if (builder.hasError) {
                try {
                  await reader.cancel();
                } catch {
                  // 忽略 cancel 自身失败
                }
                done = true;
                controller.close();
                return;
              }
            }
            for (const out of builder.finish()) push(out);
            done = true;
            controller.close();
            return;
          }
          // T1 挂起修复：有进展才 return 让下游消费；零产出（部分帧/空读）
          // 继续消费上游直到 done/close，避免两帧+[DONE] 被饿死。
          if (madeProgress) return;
        }
      } catch (err) {
        // 错误/中止/超时后只发 event: error 就 close，禁止再调 finish()。
        // 中-6：close 前先 cancel 上游 reader 再 releaseLock（finally），防 socket 悬挂。
        try {
          await reader.cancel();
        } catch {
          // 忽略 cancel 自身失败
        }
        if (!builder.hasError) {
          for (const out of builder.error(`upstream stream failed: ${(err as Error).message}`)) push(out);
        }
        done = true;
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
    cancel() {
      void upstream.cancel();
    },
  });
}
