import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";

// ZCode CLI 凭据加密器（credential cipher，zcode.cjs: createZCodeCredentialCipher）的移植。
// 格式："enc:v1:" + base64url(iv) "." base64url(gcm-tag) "." base64url(ciphertext)
const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const SECRET_ENV = "ZCODE_CREDENTIAL_SECRET";

export function resolveCredentialSecret(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[SECRET_ENV]?.trim();
  if (fromEnv) return fromEnv;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 沿用 "unknown" 继续执行
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

export function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export interface ZCodeCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export function createZCodeCredentialCipher(opts: { env?: NodeJS.ProcessEnv } = {}): ZCodeCipher {
  const key = deriveCipherKey(resolveCredentialSecret(opts.env ?? process.env));

  return {
    decrypt(value: string): string {
      if (!value.startsWith(PREFIX)) return value;
      const parts = value.slice(PREFIX.length).split(".");
      const [ivB64, tagB64, ctB64] = parts;
      if (!ivB64 || !tagB64 || !ctB64 || parts.length !== 3) {
        throw new Error("Credential decrypt failed: invalid ciphertext format");
      }
      const iv = Buffer.from(ivB64, "base64url");
      const tag = Buffer.from(tagB64, "base64url");
      const ct = Buffer.from(ctB64, "base64url");
      if (iv.length !== IV_LEN) throw new Error("Credential decrypt failed: invalid IV length");
      if (tag.length !== TAG_LEN) throw new Error("Credential decrypt failed: invalid auth tag length");
      try {
        const decipher = createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
      } catch (cause) {
        throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", { cause });
      }
    },

    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LEN);
      const cipher = createCipheriv(ALGO, key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [PREFIX, iv.toString("base64url"), ".", tag.toString("base64url"), ".", ct.toString("base64url")].join("");
    },
  };
}
