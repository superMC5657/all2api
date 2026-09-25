/**
 * Probes ZCode credentials against candidate upstream endpoints to find the
 * working (auth, endpoint, model) combination that consumes the free plan.
 * Prints status codes + truncated response bodies only (no secrets echoed).
 */
import { readZCodeCredentials } from "../src/providers/zcode/credentials.js";

const creds = readZCodeCredentials();
if (!creds) {
  console.error("No ZCode credentials found — run `zcode login` first.");
  process.exit(1);
}

const authCandidates: Array<[string, string]> = (
  [
    ["indiv-key", creds.apiKeys.individual],
    ["team-key  ", creds.apiKeys.team],
    ["zcode-jwt ", creds.zcodeJwt],
    ["oauth-tok ", creds.oauthAccessToken],
  ] as Array<[string, string | undefined]>
).filter((c): c is [string, string] => Boolean(c[1]));

const anthropicEndpoints = [
  "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
  "https://open.bigmodel.cn/api/anthropic/v1/messages",
];
const openaiEndpoints = [
  "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
  "https://zcode.z.ai/api/v1/zcode-plan/paas/v4/chat/completions",
];

const MODELS = ["glm-5.3-flash", "GLM-5.3-Flash"];
const INDIVIDUAL_KEY = creds.apiKeys.individual ?? "";

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 260 ? text.slice(0, 260) + "…" : text };
}

function redact(s: string): string {
  return s.replaceAll(/sk-[A-Za-z0-9._-]+|eyJ[A-Za-z0-9._-]{20,}/g, (m) => m.slice(0, 6) + "…");
}

async function main() {
  console.log("=== Anthropic-format endpoints ===");
  for (const url of anthropicEndpoints) {
    console.log(`\n--- ${url}`);
    for (const [name, token] of authCandidates) {
      for (const headerStyle of ["bearer", "x-api-key"] as const) {
        const headers: Record<string, string> =
          headerStyle === "bearer" ? { authorization: `Bearer ${token}` } : { "x-api-key": token, "anthropic-version": "2023-06-01" };
        const { status, body } = await post(url, headers, {
          model: MODELS[0],
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        });
        const ok = status === 200;
        console.log(`  [${headerStyle}] ${name} -> ${status}${ok ? " ✅" : ""} ${status !== 200 ? redact(body).replaceAll("\n", " ").slice(0, 160) : ""}`);
        if (ok) console.log(`      body: ${redact(body).replaceAll("\n", " ")}`);
      }
    }
  }

  console.log("\n=== OpenAI-format endpoints ===");
  for (const url of openaiEndpoints) {
    console.log(`\n--- ${url}`);
    for (const [name, token] of authCandidates) {
      const { status, body } = await post(
        url,
        { authorization: `Bearer ${token}` },
        { model: MODELS[0], max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      );
      console.log(`  ${name} -> ${status}${status === 200 ? " ✅" : ""} ${status !== 200 ? redact(body).replaceAll("\n", " ").slice(0, 160) : ""}`);
      if (status === 200) console.log(`      body: ${redact(body).replaceAll("\n", " ")}`);
    }
  }

  console.log("\n=== model-name variants on bigmodel anthropic endpoint (indiv-key, bearer) ===");
  for (const model of MODELS) {
    const { status, body } = await post(
      anthropicEndpoints[1]!,
      { authorization: `Bearer ${INDIVIDUAL_KEY}` },
      { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    );
    console.log(`  ${model} -> ${status} ${redact(body).replaceAll("\n", " ").slice(0, 200)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
