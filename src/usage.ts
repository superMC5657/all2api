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
    // never let logging break a request
  });
}

function joinUsage(): string {
  return process.cwd() + "/usage.jsonl";
}
