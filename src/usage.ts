import { appendFile } from "node:fs/promises";

export interface UsageEntry {
  ts: string;
  provider: string;
  model: string;
  api: "openai" | "anthropic";
  stream: boolean;
  status: number;
  ms: number;
}

export function logUsage(entry: UsageEntry): void {
  appendFile(joinUsage(), JSON.stringify(entry) + "\n").catch(() => {
    // 日志绝不能影响正常请求
  });
}

function joinUsage(): string {
  return process.cwd() + "/usage.jsonl";
}
