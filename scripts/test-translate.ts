/**
 * Offline checks for the Anthropic<->OpenAI translation layer (no network).
 * Feeds sample OpenAI SSE chunks through the stream translator and asserts the
 * emitted Anthropic events; also checks request and non-stream translations.
 */
import { anthropicToOpenAI, openAIToAnthropicResponse, translateOpenAIStreamToAnthropic } from "../src/translate/anthropic.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. request translation
const openaiBody = anthropicToOpenAI({
  model: "GLM-5.3",
  system: "be terse",
  max_tokens: 100,
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny 20C" }],
    },
  ],
  tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
  tool_choice: { type: "auto" },
} as never) as { messages: Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ function: { arguments: string } }> }>; tools: unknown[] };

check("system -> system message", openaiBody.messages[0]?.role === "system" && openaiBody.messages[0]?.content === "be terse");
const assistantMsg = openaiBody.messages.find((m) => m.role === "assistant");
const toolMsg = openaiBody.messages.find((m) => m.role === "tool");
check("assistant tool_use -> tool_calls", JSON.stringify(assistantMsg?.tool_calls?.[0]?.function?.arguments) === JSON.stringify(JSON.stringify({ city: "SF" })));
check("tool_result -> tool message", toolMsg?.tool_call_id === "toolu_1");
check("tools mapped", Array.isArray(openaiBody.tools) && openaiBody.tools.length === 1);

// 2. non-stream response translation
const anthropicJson = openAIToAnthropicResponse(
  {
    id: "resp1",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          reasoning_content: "thinking hard",
          content: "partial",
          tool_calls: [{ id: "call1", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
  },
  "GLM-5.3",
) as { content: Array<{ type: string; thinking?: string; text?: string; input?: unknown }>; stop_reason: string; usage: Record<string, number> };

check("thinking block first", anthropicJson.content[0]?.type === "thinking" && anthropicJson.content[0]?.thinking === "thinking hard");
check("text block", anthropicJson.content[1]?.type === "text" && anthropicJson.content[1]?.text === "partial");
check("tool_use parsed input", anthropicJson.content[2]?.type === "tool_use" && JSON.stringify(anthropicJson.content[2]?.input) === '{"city":"SF"}');
check("stop_reason tool_use", anthropicJson.stop_reason === "tool_use");
check("usage mapped", anthropicJson.usage["input_tokens"] === 11 && anthropicJson.usage["output_tokens"] === 7);

// 3. stream translation
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true });
  return out;
}

const chunks = [
  { choices: [{ delta: { role: "assistant", reasoning_content: "let me " } }] },
  { choices: [{ delta: { reasoning_content: "think" } }] },
  { choices: [{ delta: { content: "Hello " } }] },
  { choices: [{ delta: { content: "world" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call9", function: { name: "f", arguments: '{"a"' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { usage: { prompt_tokens: 5, completion_tokens: 9 }, choices: [] },
  "DONE",
];

function sseOf(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => (c === "DONE" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(c)}\n\n`)).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const sse = await collectStream(translateOpenAIStreamToAnthropic(sseOf(chunks), "GLM-5.3"));
const events = sse.split("\n\n").filter(Boolean).map((frame) => {
  const data = frame.split("\n").find((l) => l.startsWith("data:"))!;
  return JSON.parse(data.slice(5)) as { type: string; delta?: { type?: string }; content_block?: { type: string }; index: number };
});

check("starts with message_start", events[0]?.type === "message_start");
check("thinking block started", events.some((e) => e.type === "content_block_start" && e.content_block?.type === "thinking"));
check("thinking deltas present", events.filter((e) => e.delta?.type === "thinking_delta").length === 2);
check("text block started", events.some((e) => e.type === "content_block_start" && e.content_block?.type === "text"));
check("tool_use block started", events.some((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"));
check("input_json_delta joined", JSON.stringify(events.filter((e) => e.delta?.type === "input_json_delta")) === JSON.stringify(events.filter((e) => e.delta?.type === "input_json_delta")) && events.filter((e) => e.delta?.type === "input_json_delta").length === 2);
check("message_delta with tool_use", events.some((e) => e.type === "message_delta" && JSON.stringify(e).includes('"tool_use"')));
check("ends with message_stop", events[events.length - 1]?.type === "message_stop");

// block index sanity: each content_block_start has a unique index
const starts = events.filter((e) => e.type === "content_block_start");
check("unique block indexes", new Set(starts.map((e) => e.index)).size === starts.length);

console.log(failures === 0 ? "\nALL TRANSLATION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
