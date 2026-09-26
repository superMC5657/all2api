/**
 * 在本地校验 CodeBuddy/WorkBuddy 桌面端凭据解密。
 * 只打印脱敏摘要——从不打印完整 token 与密钥材料。
 */
import { CodeBuddyCredentials } from "../src/providers/codebuddy/credentials.js";
import { loadConfig } from "../src/config.js";

function mask(value: string | undefined): string {
  if (!value) return "(missing)";
  return `${value.slice(0, 5)}...${value.slice(-4)} (len=${value.length})`;
}

const cfg = loadConfig();
const cb = cfg.providers.codebuddy;
const creds = new CodeBuddyCredentials(undefined, undefined, cb.userAgent);

const file = creds.authFile();
console.log("auth file:", file);

const auth = await creds.get();
console.log("CodeBuddy/WorkBuddy credentials decrypted successfully:");
console.log("  uid            : ", mask(auth.uid || "(none)"));
console.log("  domain         : ", auth.domain);
console.log("  access token   : ", mask(auth.accessToken));
console.log("  refresh token  : ", mask(auth.refreshToken));
console.log("  expiresAt      : ", auth.expiresAt ? new Date(auth.expiresAt).toISOString() : "(none)", auth.expiresAt && Date.now() >= auth.expiresAt ? "(EXPIRED — will auto-refresh)" : "(fresh)");
