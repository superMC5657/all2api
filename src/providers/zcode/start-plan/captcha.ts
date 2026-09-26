/**
 * 验证码配置拉取 + Node 求解器 Runner + 预解池。
 *
 * Python 对照：app/captcha.py（fetch_config 取 CLIENT_CONFIGS 的 captcha
 * scene/region/prefix + 取参）与 captcha_node/solver.js（Node + happy-dom
 * 无浏览器求解器，一进程一解，stdout 打印 VERIFY_PARAM=<param>）。
 *
 * 语义：
 * - 求解器：默认 Node Runner（spawn solver.js，argv 传 scene/region/prefix，
 *   解析 stdout 的 VERIFY_PARAM= 行，超时杀进程）。setCaptchaSolver 可注入
 *   自定义 solver（测试/二期替换）；传 null 恢复默认 Node Runner。
 * - 预解池：FIFO + TTL 95s + MIN 3 / MAX 10 + 命中即后台补货
 *  （fire-and-forget）+ invalidateCaptchaPool() 清池。
 * - 首请求池空时同步求解一次（等一次求解完成，超时/失败则返回 null，
 *   调用方按空值继续走现有重试路径）。本模块永不抛错。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CAPTCHA_DEFAULTS, clientConfigsUrl } from "./constants.js";

export interface CaptchaConfig {
  enabled: boolean;
  prefix: string;
  region: string;
  sceneId: string;
}

export interface VerifyToken {
  param: string;
  region: string | null;
}

/** 验证码 solver 接口：(scene, region, prefix) → verify param（解不出返回 null）。 */
export type CaptchaSolver = (scene: string, region: string, prefix: string) => Promise<string | null>;

let customSolver: CaptchaSolver | null = null;

/**
 * 注入真正的 solver（测试/替换求解器在此接入）。
 * 传 null 恢复默认 Node Runner。
 */
export function setCaptchaSolver(solver: CaptchaSolver | null): void {
  customSolver = solver;
}

// ── 预解池参数（对齐 Python app/captcha.py + settings.py）─────────────────────
// POOL_MIN 3 / POOL_MAX 10 / TOKEN_TTL 95s（上游实际 ~2min，提前淘汰）。
const POOL_MIN = 3;
const POOL_MAX = 10;
const TOKEN_TTL_MS = 95_000;
// 单次求解超时（对齐 Python ZCODE_CAPTCHA_TIMEOUT 默认 40s；solver 内部
// 30s 超时先行退出，这里 40s 是外层兜底杀进程）。
const SOLVE_TIMEOUT_MS = 40_000;

interface PooledToken {
  param: string;
  region: string | null;
  bornAt: number;
}

const pool: PooledToken[] = [];
let refilling = false;

function defaults(): CaptchaConfig {
  return {
    enabled: CAPTCHA_DEFAULTS.enabled,
    prefix: CAPTCHA_DEFAULTS.prefix,
    region: CAPTCHA_DEFAULTS.region,
    sceneId: CAPTCHA_DEFAULTS.sceneId,
  };
}

// client/configs 缓存 10 分钟（上游拉取失败用 CAPTCHA_DEFAULTS 兜底）
let configCache: { at: number; value: CaptchaConfig } | null = null;
const CONFIG_CACHE_TTL_MS = 600_000;

function asCaptchaConfig(value: unknown): CaptchaConfig | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const v = record[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  const enabled = record["enabled"];
  return {
    enabled: enabled === undefined ? true : enabled !== false,
    prefix: pick("prefix") ?? CAPTCHA_DEFAULTS.prefix,
    region: pick("region") ?? CAPTCHA_DEFAULTS.region,
    sceneId: pick("sceneId", "scene_id", "scene") ?? CAPTCHA_DEFAULTS.sceneId,
  };
}

/** 拉取 CLIENT_CONFIGS 的 captcha 配置（scene/region/prefix），失败返回默认并 warn。 */
export async function fetchCaptchaConfig(appVersion: string): Promise<CaptchaConfig> {
  const now = Date.now();
  if (configCache && now - configCache.at < CONFIG_CACHE_TTL_MS) return configCache.value;
  try {
    const res = await fetch(clientConfigsUrl(appVersion), {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    const captcha =
      data != null && typeof data === "object"
        ? ((data as Record<string, any>)["data"]?.["configs"]?.["captcha"] as unknown)
        : null;
    const parsed = asCaptchaConfig(captcha);
    if (parsed) {
      configCache = { at: now, value: parsed };
      return parsed;
    }
    throw new Error("响应缺 captcha 配置");
  } catch (err) {
    console.warn(`[zcode] 获取 client/configs 失败，使用默认验证码配置: ${(err as Error).message}`);
    return defaults();
  }
}

// ── Node 求解器 Runner（一进程一解）───────────────────────────────────────────

function solverPaths(): { js: string; dir: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, "captcha-node", "solver.js");
  return { js, dir: path.dirname(js) };
}

function exitCodeLabel(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `被信号终止(${signal})`;
  switch (code) {
    case 2:
      return "求解超时(exit 2)";
    case 3:
      return "初始化失败(exit 3)";
    case 4:
      return "fail 回调(exit 4)";
    case 5:
      return "onError(exit 5)";
    case 6:
      return "参数无效/降级结果(exit 6)";
    default:
      return `退出码 ${code ?? "未知"}`;
  }
}

/**
 * 默认 Node Runner：spawn `node solver.js <scene> <region> <prefix>`，
 * 解析 stdout 的 VERIFY_PARAM= 行，超时杀进程。永不抛错，失败返回 null。
 */
async function runNodeSolver(scene: string, region: string, prefix: string): Promise<string | null> {
  const { js: solverJs, dir: solverDir } = solverPaths();
  if (!existsSync(solverJs)) {
    console.warn(`[zcode] 验证码求解器缺失: ${solverJs}（应在 captcha-node 下）`);
    return null;
  }
  const nodeBin = process.env["ZCODE_NODE_PATH"]?.trim() || process.execPath || "node";
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(nodeBin, [solverJs, scene, region, prefix], {
        cwd: solverDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      console.warn(`[zcode] 验证码求解器启动失败: ${(err as Error).message}`);
      resolve(null);
      return;
    }

    let stdout = "";
    let stderrTail = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString("utf8");
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
    });
    child.on("error", (err) => {
      console.warn(`[zcode] 验证码求解器无法启动(${nodeBin}): ${(err as Error).message}`);
      finish(null);
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程已退出，无需处理
      }
      console.warn(`[zcode] 验证码求解超时(${SOLVE_TIMEOUT_MS / 1000}s)，已杀进程`);
      finish(null);
    }, SOLVE_TIMEOUT_MS);

    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      let param: string | null = null;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("VERIFY_PARAM=")) param = line.slice("VERIFY_PARAM=".length).trim();
      }
      if (param && param.length < 20) {
        console.warn("[zcode] 验证码求解返回过短 param，已丢弃");
        resolve(null);
        settled = true;
        return;
      }
      if (code === 0 && param) {
        settled = true;
        resolve(param);
        return;
      }
      const detail = stderrTail.trim().split("\n").pop()?.slice(0, 200) ?? "";
      console.warn(
        `[zcode] 验证码求解未果：${exitCodeLabel(code, signal)}${detail ? `（${detail}）` : ""}`,
      );
      settled = true;
      resolve(null);
    });
  });
}

async function runSolver(scene: string, region: string, prefix: string): Promise<string | null> {
  const solver = customSolver ?? runNodeSolver;
  try {
    return await solver(scene, region, prefix);
  } catch (err) {
    console.warn(`[zcode] 验证码求解异常: ${(err as Error).message}`);
    return null;
  }
}

// ── 预解池（FIFO + TTL + 后台补货）────────────────────────────────────────────

function evictExpired(): void {
  if (pool.length === 0) return;
  const now = Date.now();
  let kept = 0;
  for (let i = 0; i < pool.length; i += 1) {
    const token = pool[i];
    if (token && now - token.bornAt < TOKEN_TTL_MS) {
      pool[kept] = token;
      kept += 1;
    }
  }
  pool.length = kept;
}

/** 后台补货到 POOL_MIN（串行一枚一枚解；永不抛错；重入直接返回）。 */
async function refillPool(config: CaptchaConfig): Promise<void> {
  if (refilling) return;
  refilling = true;
  try {
    while (pool.length < POOL_MIN) {
      if (pool.length >= POOL_MAX) break;
      const param = await runSolver(config.sceneId, config.region, config.prefix);
      if (!param) break;
      evictExpired();
      if (pool.length < POOL_MAX) pool.push({ param, region: config.region, bornAt: Date.now() });
      else break;
    }
  } finally {
    refilling = false;
  }
}

/**
 * 上游返回验证码挑战时清空整池（该批 token/指纹已不可信，继续复用只会连环 3007）。
 * 对齐 Python CaptchaManager.invalidate()。
 */
export function invalidateCaptchaPool(): void {
  const drained = pool.length;
  pool.length = 0;
  if (drained > 0) console.warn(`[zcode] 验证码失效，清空预解池 ${drained} 枚`);
}

/** invalidateCaptchaPool 的别名（兼容 Python 侧 invalidate() 命名）。 */
export const invalidateCaptcha: () => void = invalidateCaptchaPool;

/**
 * 取一枚 verify param：池内 FIFO 命中即返回并后台补货；池空则同步求解一次。
 * 永不抛错：解不出返回 null（调用方按空值继续走现有重试路径）。
 */
export async function getVerifyParam(appVersion: string): Promise<VerifyToken | null> {
  const config = await fetchCaptchaConfig(appVersion);
  if (!config.enabled) return null;
  evictExpired();
  const hit = pool.shift();
  if (hit) {
    // 命中即补充（fire-and-forget；refillPool 防重入，永不抛错）
    void refillPool(config);
    return { param: hit.param, region: hit.region };
  }
  // 池空：同步现解一次（首启兜底；超时/失败则无参放行走现有重试路径）
  const param = await runSolver(config.sceneId, config.region, config.prefix);
  if (!param) {
    console.warn("[zcode] 验证码求解未果，verify param 为空");
    return null;
  }
  // 同步命中后同样后台补货预热（fire-and-forget）
  void refillPool(config);
  return { param, region: config.region };
}
