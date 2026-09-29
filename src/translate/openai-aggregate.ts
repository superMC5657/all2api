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
  error?: unknown;
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string | null; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** SSE 事件分隔符：任意两种换行组合（\n\n / \r\n\r\n / \r\r 及混用），CRLF 安全。 */
const SSE_SEPARATOR = /(?:\r\n|\n|\r){2}/;

function takeFrame(buffer: string): { frame: string; rest: string } | null {
  const m = SSE_SEPARATOR.exec(buffer);
  if (!m || m.index === undefined) return null;
  return { frame: buffer.slice(0, m.index), rest: buffer.slice(m.index + m[0].length) };
}

function upstreamErrorDetail(error: unknown): string {
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

export async function aggregateOpenAIStream(stream: ReadableStream<Uint8Array>): Promise<AggregatedResponse> {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  // M10：tool_calls 按 id 分槽累积（无 id 回落 index），对齐 anthropic.ts M10 逻辑。
  // 同 index 不同非空 id 开新槽，避免双 tool 同 index 的 arguments 拼成乱码。
  // M11 降级策略保持：仅聚合 choice.index === 0，其他 choice 直接忽略。
  interface ToolSlot { id?: string; name?: string; arguments: string }
  const toolEntries: ToolSlot[] = [];
  const toolBlocks = new Map<number, ToolSlot>();
  const toolIdMap = new Map<string, ToolSlot>();
  let model = "";
  let finishReason: string | null = null;
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function handleChunk(chunk: StreamChunk): void {
    // H2：只要 chunk.error 非空即抛错（即使同时带 choices），与流式侧
    // anthropic.ts feed() 口径统一：rawError !== undefined && !== null 即 error。
    // 禁止把错误帧当正常聚合，避免 error+choices 共存时吞错合成 200。
    if (chunk.error !== undefined && chunk.error !== null) {
      throw new Error(`codebuddy: upstream error: ${upstreamErrorDetail(chunk.error)}`);
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
      // M11 降级策略：上游 n>1（A/B 候选）时只聚合 index 0，直接忽略其他
      // choice，避免把两个候选的内容混包成一段乱码。
      if ((choice.index ?? 0) !== 0) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (delta.content) contentParts.push(delta.content);
      if (delta.reasoning_content) reasoningParts.push(delta.reasoning_content);
      for (const call of delta.tool_calls ?? []) {
        const idx = call.index ?? 0;
        const rawId = call.id;
        const newId = typeof rawId === "string" && rawId !== "" ? rawId : undefined;
        let slot: ToolSlot | undefined;
        if (newId && toolIdMap.has(newId)) {
          slot = toolIdMap.get(newId)!;
        } else {
          const byIndex = toolBlocks.get(idx);
          if (!newId) {
            // 无 id：按 index 复用最新槽（延续片段）；无槽则开新槽。
            slot = byIndex;
          } else if (!byIndex) {
            slot = undefined; // 新 index + 新 id → 开新槽
          } else if (!byIndex.id) {
            // 该 index 首个 id：认领复用，不开新槽。
            byIndex.id = newId;
            toolIdMap.set(newId, byIndex);
            slot = byIndex;
          } else if (byIndex.id === newId) {
            slot = byIndex;
          } else {
            slot = undefined; // 同 index 不同非空 id → 开新槽
          }
        }
        if (!slot) {
          slot = { id: newId, arguments: "" };
          toolEntries.push(slot);
          // index 映射永远指向该 index 的最新槽；id 映射指向所属槽。
          toolBlocks.set(idx, slot);
          if (newId) toolIdMap.set(newId, slot);
        }
        if (call.function?.name) slot.name = call.function.name;
        if (call.function?.arguments) slot.arguments += call.function.arguments;
      }
    }
  }

  function handleFrame(frame: string): void {
    // 对齐 zcode client 逐行 + trim 做法：每行 trim 后再判 data: 前缀；
    // 同一事件内多行 data: 按 SSE 规范用 \n 拼成单个 payload。
    const dataLines: string[] = [];
    for (const line of frame.split(/\r\n|\n|\r/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      dataLines.push(data);
    }
    if (dataLines.length === 0) return;
    // SSE 规范路径：多行拼接后整体 JSON.parse；若拼接体不是合法 JSON
    //（某些上游把两个完整 chunk 挤进一帧、省略空行分隔），则回落为逐行解析，
    // 保证 M1d 类多 data 行不丢包。
    const joined = dataLines.join("\n");
    let joinedChunk: StreamChunk | null = null;
    try {
      joinedChunk = JSON.parse(joined) as StreamChunk;
    } catch {
      // 拼接体不是合法 JSON（某些上游把两个完整 chunk 挤进一帧、省略空行分隔），
      // 走逐行回落，保证 M1d 类多 data 行不丢包。
    }
    if (joinedChunk !== null) {
      // 注意：handleChunk 的 upstream-error throw 必须直接透出，
      // 不可被 JSON 回落逻辑吞掉。
      handleChunk(joinedChunk);
      return;
    }
    for (const payload of dataLines) {
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }
      handleChunk(chunk);
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      let taken = takeFrame(buffer);
      while (taken !== null || (done && buffer.trim() !== "")) {
        const frame = taken !== null ? taken.frame : buffer;
        buffer = taken !== null ? taken.rest : "";
        handleFrame(frame);
        taken = takeFrame(buffer);
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

  const content = contentParts.join("");
  const reasoning = reasoningParts.join("");
  // L9：既无 finish_reason 又无任何内容（content/reasoning/tool_calls）时，
  // 禁止伪造 finish_reason:"stop" 的空 200，直接抛空响应错误。
  if (finishReason === null && content === "" && reasoning === "" && toolEntries.length === 0) {
    throw new Error("codebuddy: upstream returned empty response (no finish_reason, content, or tool_calls)");
  }

  const message: AggregatedResponse["choices"][number]["message"] = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolEntries.length > 0) {
    // toolEntries 已按开槽顺序排列（M10 分槽插入序），直接输出保持稳定顺序。
    message.tool_calls = toolEntries.map((v) => ({ id: v.id ?? `call_${crypto.randomUUID()}`, type: "function" as const, function: { name: v.name ?? "", arguments: v.arguments } }));
    finishReason = finishReason ?? "tool_calls";
  }

  return {
    // id 每次聚合重生成：上游 chunk 自带 id 只是流内分片标识，不可直接复用为最终 chat.completion id。
    id: `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
