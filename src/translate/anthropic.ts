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
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
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

    // user（用户）消息：text（文本）/images（图像）内联，tool_results（工具结果）转为后续 "tool" 消息
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
    if (inline.length > 0) {
      messages.push({ role: "user", content: inline.length === 1 && inline[0]!.type === "text" ? inline[0]!.text : inline });
    }
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: textOf(tr.content) || (tr.is_error ? "tool execution failed" : ""),
      });
    }
  }

  const tools = req.tools?.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object" } },
  }));

  let toolChoice: unknown;
  if (req.tool_choice) {
    toolChoice =
      req.tool_choice.type === "auto" ? "auto" : req.tool_choice.type === "any" ? "required" : { type: "function", function: { name: req.tool_choice.name } };
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
  for (const call of message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id ?? `toolu_${crypto.randomUUID()}`, name: call.function?.name ?? "", input });
  }

  return {
    id: resp.id ?? `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP_REASON[choice.finish_reason ?? ""] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: resp.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

// ---------- 流式：OpenAI SSE -> Anthropic SSE ----------

interface StreamChunk {
  choices?: Array<{ delta?: OpenAIMessage & { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
  usage?: OpenAIResponse["usage"];
}

/** 由一串 OpenAI deltas（增量片段）组装 Anthropic SSE（服务端推送事件流）帧。 */
export class AnthropicStreamBuilder {
  private blockIndex = -1;
  private openBlock: "thinking" | "text" | null = null;
  private readonly toolBlocks = new Map<number, { anthropicIndex: number; started: boolean }>();
  private nextFreeIndex = 0;
  private finishReason: string | null = null;
  private usage: OpenAIResponse["usage"];
  private readonly messageId: string;

  constructor(private readonly model: string) {
    this.messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    this.usage = undefined;
  }

  start(): string {
    return this.frame("message_start", {
      type: "message_start",
      message: { id: this.messageId, type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  /** 输入一个 OpenAI chunk（数据块）；返回零或多个 Anthropic SSE 帧。 */
  feed(chunk: StreamChunk): string[] {
    const out: string[] = [];
    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    if (delta.reasoning_content) {
      if (this.openBlock !== "thinking") {
        out.push(...this.closeOpenBlock());
        this.blockIndex = this.nextFreeIndex++;
        this.openBlock = "thinking";
        out.push(this.frame("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "thinking", thinking: "", signature: "" } }));
      }
      out.push(this.frame("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } }));
    }

    if (delta.content) {
      if (this.openBlock !== "text") {
        out.push(...this.closeOpenBlock());
        this.blockIndex = this.nextFreeIndex++;
        this.openBlock = "text";
        out.push(this.frame("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } }));
      }
      out.push(this.frame("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text: delta.content } }));
    }

    for (const call of delta.tool_calls ?? []) {
      const idx = call.index ?? 0;
      let entry = this.toolBlocks.get(idx);
      if (!entry) {
        out.push(...this.closeOpenBlock());
        const anthropicIndex = this.nextFreeIndex++;
        entry = { anthropicIndex, started: true };
        this.toolBlocks.set(idx, entry);
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
        out.push(this.frame("content_block_delta", { type: "content_block_delta", index: entry.anthropicIndex, delta: { type: "input_json_delta", partial_json: args } }));
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  /** 关闭剩余 blocks（内容块）并输出收尾 delta（增量）/stop（结束）帧。 */
  finish(): string[] {
    const out = this.closeOpenBlock();
    for (const [, entry] of this.toolBlocks) {
      out.push(this.frame("content_block_stop", { type: "content_block_stop", index: entry.anthropicIndex }));
    }
    out.push(
      this.frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: STOP_REASON[this.finishReason ?? ""] ?? "end_turn", stop_sequence: null },
        usage: { output_tokens: this.usage?.completion_tokens ?? 0 },
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
      const push = (text: string) => controller.enqueue(encoder.encode(text));

      if (done) {
        controller.close();
        return;
      }
      if (!started) {
        started = true;
        push(builder.start());
      }

      const reader = upstream.getReader();
      try {
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              for (const out of builder.feed(JSON.parse(payload) as StreamChunk)) push(out);
            } catch {
              // 忽略上游发来的畸形帧
            }
          }

          if (streamDone) {
            for (const out of builder.finish()) push(out);
            done = true;
            controller.close();
            return;
          }
          return; // wait for next pull
        }
      } catch (err) {
        for (const out of builder.error(`upstream stream failed: ${(err as Error).message}`)) push(out);
        for (const out of builder.finish()) push(out);
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
