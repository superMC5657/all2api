/**
 * Anthropic <-> OpenAI 互译，面向仅支持 OpenAI chat completions（聊天补全接口）的上游
 * （Qoder 经 qoder2api 桥接接入）。
 *
 * 覆盖范围：system（系统提示）、text（文本）、images（图像）、tool definitions/calls/results
 * （工具定义/调用/结果）、thinking（思考块，reasoning_content）、双向 streaming（流式）。
 *
 * 本文件为 kernel 上的薄 adapter：请求转译（anthropicToOpenAI）保留本地实现；
 * 响应/流式的 M2/M3/M4/H2/H3/M9/M10 与 SSE 成帧 deep 逻辑下沉至 ./kernel.ts，
 * 对外导出 interface 保持不变（调用方零改）。
 */

import {
  AnthropicStreamKernel,
  decodeFrameJsonTexts,
  hasBadToolJson,
  resolveAnthropicStopReason,
  splitAnthropicUsage,
  tailPayloadTexts,
  takeSseFrame,
  tryParseToolInput,
  type AnthropicStreamChunk,
} from "./kernel.js";

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

export function openAIToAnthropicResponse(resp: OpenAIResponse, model: string): Record<string, unknown> {
  const choice = resp.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: Array<Record<string, unknown>> = [];

  if (message.reasoning_content) {
    content.push({ type: "thinking", thinking: message.reasoning_content, signature: message.reasoning_content_signature ?? "" });
  }
  if (message.content) content.push({ type: "text", text: message.content });
  // M4（kernel.tryParseToolInput）：tool 参数 JSON.parse 失败不再静默 {}——保留原始串，
  // 后续强制 stop_reason 为 max_tokens。（上游 arguments 截断/坏 JSON 意味着输出被截断，按截断口径上报。）
  const raws: string[] = [];
  for (const call of message.tool_calls ?? []) {
    const { input } = tryParseToolInput(call.function?.arguments);
    if (call.function?.arguments) raws.push(call.function.arguments);
    content.push({ type: "tool_use", id: call.id ?? `toolu_${crypto.randomUUID()}`, name: call.function?.name ?? "", input });
  }

  // M2+M4（kernel.resolveAnthropicStopReason）：坏 JSON 强制 max_tokens（优先级高于 tool_use 覆写）；
  // 非流式看 tool_calls.length>0 时，把 end_turn 覆写为 tool_use。
  const toolParseFailed = hasBadToolJson(raws);
  const stopReason = resolveAnthropicStopReason(choice.finish_reason ?? null, (message.tool_calls?.length ?? 0) > 0, toolParseFailed);

  // M3（kernel.splitAnthropicUsage）：互斥口径 input_tokens = prompt_tokens - cached_tokens，cache_read 照报。
  const split = splitAnthropicUsage(resp.usage ?? undefined);
  return {
    id: resp.id ?? `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: split.inputTokens,
      output_tokens: split.outputTokens,
      cache_read_input_tokens: split.cacheRead,
    },
  };
}

// ---------- 流式：OpenAI SSE -> Anthropic SSE（kernel 薄 adapter） ----------

/** 将 OpenAI SSE 流包装为 Anthropic SSE 流（成帧/SSE 解析与 block 状态机见 kernel）。 */
export function translateOpenAIStreamToAnthropic(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const builder = new AnthropicStreamKernel(model);
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
      // 消费 buffer 中所有完整帧（kernel.takeSseFrame，CRLF 安全），有进展时标记。
      const drainFrames = (): boolean => {
        let errored = false;
        let taken = takeSseFrame(buffer);
        while (taken !== null) {
          const frame = taken.frame;
          buffer = taken.rest;
          // 空帧（心跳）跳过
          if (!frame.trim()) {
            taken = takeSseFrame(buffer);
            continue;
          }
          for (const text of decodeFrameJsonTexts(frame)) {
            try {
              for (const out of builder.feed(JSON.parse(text) as AnthropicStreamChunk)) push(out);
            } catch {
              // 忽略上游发来的畸形帧
            }
            if (builder.hasError) {
              errored = true;
              break;
            }
          }
          if (errored) break;
          taken = takeSseFrame(buffer);
        }
        return errored;
      };
      // 终 tail：无尾空行的残余帧（含无尾空行的 usage 尾帧），kernel.tailPayloadTexts
      // 先按正常帧解码，无 data: 行时回落原始 JSON 直解。
      const drainTail = (): boolean => {
        const tail = buffer.trim();
        if (!tail) {
          buffer = "";
          return false;
        }
        buffer = "";
        for (const text of tailPayloadTexts(tail)) {
          try {
            for (const out of builder.feed(JSON.parse(text) as AnthropicStreamChunk)) push(out);
          } catch {
            // 忽略上游发来的畸形帧
          }
          if (builder.hasError) return true;
        }
        return builder.hasError;
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
            if (drainTail() || builder.hasError) {
              try {
                await reader.cancel();
              } catch {
                // 忽略 cancel 自身失败
              }
              done = true;
              controller.close();
              return;
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
