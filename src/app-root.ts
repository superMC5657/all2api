import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * exe 感知根目录：开发时（cwd 有 config/bridges）用 cwd，
 * SEA 单文件运行时（cwd 无 config，exe 在别处双击）回落到 exe 所在目录。
 */
export function appRoot(): string {
  const cwd = process.cwd();
  if (
    existsSync(join(cwd, "config.jsonc")) ||
    existsSync(join(cwd, "config.json")) ||
    existsSync(join(cwd, "bridges"))
  ) {
    return cwd;
  }
  try {
    const exeDir = dirname(process.execPath);
    if (exeDir && exeDir !== cwd) return exeDir;
  } catch {
    // ignore
  }
  return cwd;
}
