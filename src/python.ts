/**
 * 统一的 python 解释器解析（qoder / codebuddy 共用）。
 *
 * 只做存在性判断，不做版本比较。两个候选都不存在时抛中文 Error，
 * 调用方需自行处理（例如转成 ENOENT 形的链路失败以继续降级）。
 */
import { spawnSync } from "node:child_process";

/** 候选解释器命令（按序探测，与 Linux 发行版现状一致：python 常为 python3 别名）。 */
export const PYTHON_BIN_CANDIDATES = ["python", "python3"] as const;

/** 单次 `--version` 探测超时（毫秒）。 */
export const PYTHON_PROBE_TIMEOUT_MS = 10_000;

type PythonBinState = { kind: "unprobed" } | { kind: "found"; bin: string } | { kind: "missing"; message: string };

const NO_PYTHON_MESSAGE = `未找到可用的 python 解释器（已尝试: ${PYTHON_BIN_CANDIDATES.join(", ")}）——请安装 Python 并加入 PATH`;

let state: PythonBinState = { kind: "unprobed" };

/**
 * 解析可用的 python 解释器：首次调用探测并缓存（命中与缺失都 memo），
 * 后续直接返回缓存值 / 抛缓存错误。两个候选都不存在时抛中文 Error。
 */
export function resolvePythonBin(): string {
  if (state.kind === "found") return state.bin;
  if (state.kind === "missing") throw new Error(state.message);
  for (const bin of PYTHON_BIN_CANDIDATES) {
    let probe: ReturnType<typeof spawnSync>;
    try {
      probe = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: PYTHON_PROBE_TIMEOUT_MS, windowsHide: true });
    } catch {
      continue;
    }
    if (!probe.error && probe.status === 0) {
      state = { kind: "found", bin };
      return bin;
    }
  }
  state = { kind: "missing", message: NO_PYTHON_MESSAGE };
  throw new Error(NO_PYTHON_MESSAGE);
}

/**
 * 测试注入：bin 为字符串时固定解释器名（不触发真实探测）；传 null 表示
 * 强制"无解释器"状态（resolvePythonBin 抛错，用于验证调用方的降级路径）。
 */
export function __setPythonBinForTests(bin: string | null): void {
  state = bin === null ? { kind: "missing", message: NO_PYTHON_MESSAGE } : { kind: "found", bin };
}

/** 清除缓存，恢复真实探测。 */
export function __resetPythonBinForTests(): void {
  state = { kind: "unprobed" };
}
