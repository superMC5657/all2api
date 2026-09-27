import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createZCodeCredentialCipher } from "./cipher.js";

export interface ZCodeCredentials {
  zcodeJwt?: string;
}

/**
 * 读取并解密 ~/.zcode/v2/credentials.json（ZCode CLI 在 `zcode login` 后维护的文件）。
 * 各值经 AES-256-GCM（GCM 分组加密模式）加密，密钥由本机派生，
 * 因此仅在执行登录的同一台机器/同一用户下才能解密。
 *
 * Start Plan JWT 通道只用 zcodeJwt。
 */
export function readZCodeCredentials(credentialsPath?: string): ZCodeCredentials | null {
  const path = credentialsPath ?? join(homedir(), ".zcode", "v2", "credentials.json");
  if (!existsSync(path)) return null;

  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const cipher = createZCodeCredentialCipher();
  const dec = (key: string): string | undefined => {
    const value = raw[key];
    return typeof value === "string" && value.startsWith("enc:v1:") ? cipher.decrypt(value) : undefined;
  };

  const creds: ZCodeCredentials = {
    zcodeJwt: dec("zcodejwttoken"),
  };
  return creds;
}
