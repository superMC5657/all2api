/**
 * 3012 风控轻量计数（strikes + 冷却 + 衰减）。
 *
 * 合入 dengyie/zcode2api 2.6.5～2.6.8 防封思路的本仓适配：
 * 单 JWT 直透、无账号池——仅进程内按 JWT sub 计数（内存 Map），不做换号/
 * 轮询/claim。阈值走 constants.ts（RISK_* + ZCODE_RISK_* 环境变量覆盖）。
 *
 * 语义：
 * - recordRiskStrike：命中 3012 时 strikes+1（距上次命中超 decay 窗口先清零），
 *   返回 { strikes, coolingS }（coolingS = min(base*2^(strikes-1), cap)）。
 * - clearRisk：messages 成功一次即清零（参考上游 gateway 成功分支）。
 * - strikes >= BAN_STRIKES 才判 DISABLED，否则判 COOLING（调用方抛 429 附带
 *   Retry-After=coolingS 秒数；ProviderError 类型无 cooling 语义）。
 */

import {
  resolveRiskCooldownBaseS,
  resolveRiskCooldownMaxS,
  resolveRiskDecayS,
  riskCooldownForStrikes,
} from "./constants.js";

interface RiskEntry {
  strikes: number;
  lastAt: number;
}

const ANONYMOUS_KEY = "__anonymous__";
const risks = new Map<string, RiskEntry>();

/** 归一计数 key：空 sub 落匿名槽。 */
export function riskKey(sub: string | null | undefined): string {
  const s = (sub ?? "").trim();
  return s ? s : ANONYMOUS_KEY;
}

/**
 * 记录一次 3012 命中：超 decay 窗口（距上次命中）先清零再 +1。
 * 返回最新 strikes 与对应冷却秒数。
 */
export function recordRiskStrike(key: string, now = Date.now()): { strikes: number; coolingS: number } {
  const decayMs = resolveRiskDecayS() * 1000;
  const prev = risks.get(key);
  let strikes = 1;
  if (prev && now - prev.lastAt <= decayMs) {
    strikes = prev.strikes + 1;
  }
  risks.set(key, { strikes, lastAt: now });
  return { strikes, coolingS: riskCooldownForStrikes(strikes) };
}

/** messages 成功一次即清零该 key 的 strikes。 */
export function clearRisk(key: string): void {
  risks.delete(key);
}

/** 仅供测试/诊断：读当前 strikes（无记录返回 0）。 */
export function getRiskStrikes(key: string): number {
  return risks.get(key)?.strikes ?? 0;
}

/** 仅供测试：清空全表。 */
export function resetAllRisks(): void {
  risks.clear();
}
