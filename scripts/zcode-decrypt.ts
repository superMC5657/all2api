/**
 * Decrypts ~/.zcode/v2/credentials.json and prints a redacted summary.
 * Verifies the cipher port before wiring the proxy. Never prints full tokens.
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
console.log("  active provider : ", creds.activeProvider ?? "(none)");
console.log("  user id         : ", (creds.userInfo?.id as string | undefined) ?? "(none)");
console.log("  oauth token     : ", mask(creds.oauthAccessToken));
console.log("  zcode jwt       : ", mask(creds.zcodeJwt));
