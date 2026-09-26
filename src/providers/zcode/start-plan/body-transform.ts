/**
 * 请求体变换 —— 镜像官方客户端在 anthropic 通道上的变换集。
 *
 * Python 对照：app/body_transform.py（apply_start_plan_system /
 * apply_cache_control / apply_user_id / jwt_user_id / transform_body）。
 *
 * 1. system 身份块：前置 ZCode 官方 system 块（zcode_system.json，3 块）+
 *    动态 currentModel 块。幂等（已前置则跳过）。
 * 2. cache_control：最后一条非 system 消息的最后一个 content block 追加
 *    `cache_control: {"type": "ephemeral"}`。幂等。
 * 3. metadata.user_id：从 JWT payload（sub / user_id）实时解出后注入。
 *
 * 所有变换对畸形输入保持 no-op：坏 body 永远不会被这里放大。
 */

import { readFileSync } from "node:fs";

export type AnthropicBody = Record<string, any>;

// ── ZCode 官方 system 身份块（zcode_system.json，原样复制自官方客户端 bundle）──
// 不用 JSON import（避免改 tsconfig），运行时按相对路径读取并缓存。
let cachedBlocks: Array<Record<string, any>> | null = null;

function officialBlocks(): Array<Record<string, any>> {
  if (cachedBlocks) return cachedBlocks;
  try {
    const raw = readFileSync(new URL("./zcode_system.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    cachedBlocks = Array.isArray(parsed) ? (parsed as Array<Record<string, any>>) : [];
  } catch {
    cachedBlocks = [];
  }
  return cachedBlocks;
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeUserSystem(system: unknown): Array<Record<string, any>> {
  if (system == null) return [];
  if (typeof system === "string") {
    return system.trim() ? [{ type: "text", text: system }] : [];
  }
  if (!Array.isArray(system)) return [];
  const out: Array<Record<string, any>> = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ type: "text", text: item });
    } else if (item != null && typeof item === "object") {
      const block = item as Record<string, any>;
      if (block["type"] === "text" && typeof block["text"] === "string" && (block["text"] as string).trim()) {
        const kept: Record<string, any> = { type: "text", text: block["text"] };
        if (block["cache_control"] != null && typeof block["cache_control"] === "object") {
          kept["cache_control"] = block["cache_control"];
        }
        out.push(kept);
      }
    }
  }
  return out;
}

/** 前置 ZCode 官方 system 身份块 + 动态 currentModel 块。幂等（已前置则跳过）。 */
export function applyStartPlanSystem(body: AnthropicBody, model?: string | null): boolean {
  const official = officialBlocks();
  if (official.length === 0) return false;
  const existing = body["system"];
  if (Array.isArray(existing) && existing.length > 0) {
    const first = existing[0] as Record<string, any> | undefined;
    if (first != null && typeof first === "object" && first["text"] === official[0]?.["text"]) {
      return false;
    }
  }
  const blocks = deepCopy(official);
  if (typeof model === "string" && model.trim()) {
    blocks.push({
      type: "text",
      text: `- You are powered by the model named ${model}.`,
      cache_control: { type: "ephemeral" },
    });
  }
  body["system"] = [...blocks, ...normalizeUserSystem(existing)];
  return true;
}

/** 最后一条非 system 消息的最后一个 block 加 ephemeral 缓存标记。幂等。 */
export function applyCacheControl(body: AnthropicBody): boolean {
  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, any> | undefined;
    if (msg == null || typeof msg !== "object") continue;
    if (msg["role"] === "system") continue;
    const content = msg["content"];
    if (typeof content === "string") {
      msg["content"] = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(content) && content.length > 0) {
      const last = content[content.length - 1] as Record<string, any> | undefined;
      if (last != null && typeof last === "object" && !last["cache_control"]) {
        last["cache_control"] = { type: "ephemeral" };
        return true;
      }
    }
    return false;
  }
  return false;
}

/** 注入 metadata.user_id（保留已有 metadata 其它字段）。幂等。 */
export function applyUserId(body: AnthropicBody, userId: string): boolean {
  const existing = body["metadata"];
  if (existing != null && typeof existing === "object" && !Array.isArray(existing)) {
    if ((existing as Record<string, any>)["user_id"] === userId) return false;
    body["metadata"] = { ...(existing as Record<string, any>), user_id: userId };
    return true;
  }
  body["metadata"] = { user_id: userId };
  return true;
}

/** 从 JWT payload 解 user_id（sub / user_id 字段），失败返回 null。 */
export function jwtUserId(jwt: string | null | undefined): string | null {
  if (!jwt || jwt.split(".").length !== 3) return null;
  try {
    const segment = jwt.split(".")[1] as string;
    const payload: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf-8"));
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    const userId = record["user_id"] ?? record["sub"];
    if (typeof userId === "string" && userId) return userId;
    if (typeof userId === "number") return String(userId);
    return null;
  } catch {
    return null;
  }
}

/** 按 anthropic 通道变换 body（原地修改并返回）。变换失败静默保持原样。 */
export function transformBody(
  body: AnthropicBody,
  userId?: string | null,
  model?: string | null,
): AnthropicBody {
  try {
    applyStartPlanSystem(body, model);
    applyCacheControl(body);
    if (userId) applyUserId(body, userId);
  } catch {
    // 变换永不放大请求失败
  }
  return body;
}
