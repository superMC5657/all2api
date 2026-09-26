/**
 * 解密 ~/.zcode/v2/credentials.json 并打印脱敏摘要。
 * 在接入代理前校验 cipher 端口。从不打印完整 token。
 */
import { readZCodeCredentials } from "../src/providers/zcode/credentials.js";

function mask(value: string | undefined): string {
  if (!value) return "(missing)";
  if (value.length <= 10) return "***";
  return `${value.slice(0, 5)}...${value.slice(-4)} (len=${value.length})`;
}

const creds = readZCodeCredentials();
if (!creds) {
  console.error("No credentials.json found at ~/.zcode/v2/credentials.json — run `zcode login` first.");
  process.exit(1);
}

console.log("ZCode credentials decrypted successfully:");
console.log("  zcode jwt       : ", mask(creds.zcodeJwt));
