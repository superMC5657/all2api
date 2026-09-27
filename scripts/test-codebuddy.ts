/**
 * CodeBuddy/WorkBuddy provider 各部件的离线检查（无需联网）：
 * 信封（envelope）密封/解封往返 + AAD 字节布局，以及 OpenAI SSE 聚合。
 */
import { createHash, randomBytes } from "node:crypto";
import { aggregateOpenAIStream } from "../src/translate/openai-aggregate.js";
import { buildAuthenticatedContextAad, openEnvelope, parseEnvelope, sealField } from "../src/providers/codebuddy/credentials.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. AAD 字节布局："WB-AAD\0" + 0x01 + lp("WBEV1") + lp("sym-v1") + suite + lp(keyId) + [2,0,0]
const aad = buildAuthenticatedContextAad("0123456789abcdef", 1);
const expected = Buffer.concat([
  Buffer.from("WB-AAD\0", "ascii"),
  Buffer.from([1]),
  Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from("WBEV1")]),
  Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.from("sym-v1")]),
  Buffer.from([0, 0, 0, 1]),
  Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("0123456789abcdef")]),
  Buffer.from([2, 0, 0]),
]);
check("AAD byte layout", aad.equals(expected), `got ${aad.toString("hex")}`);

// 2. 用派生密钥做密封/解封往返（与真实流程的派生方式相同）
const secret = Buffer.from(randomBytes(32)).toString("base64");
const key = createHash("sha256").update(secret, "utf8").digest();
const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
const wrapped = sealField(key, keyId, "jwt-token-abc");
check("sealed envelope carries the flag + base64", wrapped["$wbEncrypted"] === 1 && wrapped.envelope.length > 20);
const envelope = parseEnvelope(wrapped);
check("envelope parses back", envelope !== undefined && envelope.keyId === keyId);
check("seal -> open roundtrip", envelope !== undefined && openEnvelope(key, envelope) === "jwt-token-abc");
check("open rejects wrong key", envelope !== undefined && openEnvelope(createHash("sha256").update("other", "utf8").digest(), envelope) === undefined);

// 3. SSE 聚合：content + reasoning + tool_calls + usage + finish
function sseOf(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks
    .map((c) => (c === "DONE" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(c)}\n\n`))
    .join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const aggregated = await aggregateOpenAIStream(
  sseOf([
    { model: "glm-5.2", choices: [{ delta: { role: "assistant", reasoning_content: "think" } }] },
    { choices: [{ delta: { content: "he" } }] },
    { choices: [{ delta: { content: "llo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "{\"a\":" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 }, choices: [] },
    "DONE",
  ]),
);
check("aggregated content", aggregated.choices[0]?.message.content === "hello");
check("aggregated reasoning", aggregated.choices[0]?.message.reasoning_content === "think");
check("aggregated tool_calls", JSON.stringify(aggregated.choices[0]?.message.tool_calls?.[0]?.function?.arguments) === JSON.stringify('{"a":1}'));
check("aggregated finish_reason", aggregated.choices[0]?.finish_reason === "tool_calls");
check("aggregated usage", aggregated.usage.total_tokens === 14);
check("aggregated model", aggregated.model === "glm-5.2");

console.log(failures === 0 ? "\nALL CODEBUDDY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
