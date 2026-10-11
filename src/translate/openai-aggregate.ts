/**
 * 将 OpenAI SSE（服务端推送事件流）聚合成单个 chat.completion（聊天补全）对象。
 * 适用于部分上游（CodeBuddy/WorkBuddy 网关）仅提供 streaming（流式）响应，
 * 而客户端仍请求非流式响应的场景。
 *
 * 本文件为 kernel 上的薄 adapter：M10 分槽 / H2 error-with-choices / M11 index 过滤 /
 * SSE 成帧 deep 逻辑下沉至 ./kernel.ts，对外导出 interface 保持不变（调用方零改）。
 */

import {
  decodeFrameJsonTexts,
  OpenAIAggregateKernel,
  tailPayloadTexts,
  takeSseFrame,
  type AggregateStreamChunk,
  type AggregateUsage,
} from "./kernel.js";

export interface AggregatedResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const ERROR_PREFIX = "codebuddy: ";

export async function aggregateOpenAIStream(stream: ReadableStream<Uint8Array>): Promise<AggregatedResponse> {
  const kernel = new OpenAIAggregateKernel();

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function handleFrame(frame: string): void {
    // kernel.decodeFrameJsonTexts：trim 后判 data: 前缀、跳过空/[DONE]、
    // 多行 data 先整体 JSON.parse、失败回落逐行（M1d 不丢包）。
    for (const payload of decodeFrameJsonTexts(frame)) {
      let chunk: AggregateStreamChunk;
      try {
        chunk = JSON.parse(payload) as AggregateStreamChunk;
      } catch {
        continue;
      }
      // 注意：handleChunk 的 upstream-error throw 必须直接透出，
      // 不可被 JSON 回落逻辑吞掉。
      kernel.handleChunk(chunk, ERROR_PREFIX);
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      let taken = takeSseFrame(buffer);
      // tail 兼容：done 时即使无尾分隔符，残余非空也按帧处理
      //（kernel.tailPayloadTexts：先正常帧解码，无 data: 行回落原始 JSON 直解）。
      while (taken !== null || (done && buffer.trim() !== "")) {
        if (taken !== null) {
          const frame = taken.frame;
          buffer = taken.rest;
          handleFrame(frame);
          taken = takeSseFrame(buffer);
        } else {
          const tail = buffer;
          buffer = "";
          for (const payload of tailPayloadTexts(tail)) {
            let chunk: AggregateStreamChunk;
            try {
              chunk = JSON.parse(payload) as AggregateStreamChunk;
            } catch {
              continue;
            }
            kernel.handleChunk(chunk, ERROR_PREFIX);
          }
        }
      }
      if (done) break;
    }
  } catch (err) {
    // 中-6（聚合侧）：抛错前 cancel 上游流，避免 error chunk 后 socket 悬挂。
    try {
      await reader.cancel();
    } catch {
      // cancel 本身失败不掩盖原始错误
    }
    throw err;
  } finally {
    reader.releaseLock();
  }

  const content = kernel.content;
  const reasoning = kernel.reasoning;
  const toolEntries = kernel.toolEntries;
  // L9：既无 finish_reason 又无任何内容（content/reasoning/tool_calls）时，
  // 禁止伪造 finish_reason:"stop" 的空 200，直接抛空响应错误。
  if (kernel.finishReason === null && content === "" && reasoning === "" && toolEntries.length === 0) {
    throw new Error("codebuddy: upstream returned empty response (no finish_reason, content, or tool_calls)");
  }

  const message: AggregatedResponse["choices"][number]["message"] = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  let finishReason = kernel.finishReason;
  if (toolEntries.length > 0) {
    message.tool_calls = kernel.buildToolCalls();
    finishReason = finishReason ?? "tool_calls";
  }

  const usage: AggregateUsage = kernel.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    // id 每次聚合重生成：上游 chunk 自带 id 只是流内分片标识，不可直接复用为最终 chat.completion id。
    id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: kernel.model || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage,
  };
}
