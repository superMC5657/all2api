/**
 * 将 OpenAI SSE（服务端推送事件流）聚合成单个 chat.completion（聊天补全）对象。
 * 适用于部分上游（CodeBuddy/WorkBuddy 网关）仅提供 streaming（流式）响应，
 * 而客户端仍请求非流式响应的场景。
 */

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

interface StreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string | null; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

export async function aggregateOpenAIStream(stream: ReadableStream<Uint8Array>): Promise<AggregatedResponse> {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  let model = "";
  let finishReason: string | null = null;
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1 || (done && buffer.trim() !== "")) {
        const frame = sep !== -1 ? buffer.slice(0, sep) : buffer;
        buffer = sep !== -1 ? buffer.slice(sep + 2) : "";
        const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          continue;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens ?? 0,
          };
        }
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta ?? {};
          if (delta.content) contentParts.push(delta.content);
          if (delta.reasoning_content) reasoningParts.push(delta.reasoning_content);
          for (const call of delta.tool_calls ?? []) {
            const idx = call.index ?? 0;
            const slot = toolCalls.get(idx) ?? { arguments: "" };
            if (call.id) slot.id = call.id;
            if (call.function?.name) slot.name = call.function.name;
            if (call.function?.arguments) slot.arguments += call.function.arguments;
            toolCalls.set(idx, slot);
          }
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  const content = contentParts.join("");
  const reasoning = reasoningParts.join("");
  const message: AggregatedResponse["choices"][number]["message"] = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({ id: v.id ?? `call_${crypto.randomUUID()}`, type: "function" as const, function: { name: v.name ?? "", arguments: v.arguments } }));
    finishReason = finishReason ?? "tool_calls";
  }

  return {
    id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
