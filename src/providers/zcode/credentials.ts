import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createZCodeCredentialCipher } from "./cipher.js";

export interface ZCodeCredentials {
  zcodeJwt?: string;
}

/**
 * Reads and decrypts ~/.zcode/v2/credentials.json (the file ZCode CLI maintains
 * after `zcode login`). Values are AES-256-GCM encrypted with a machine-derived
 * key, so decryption only works on the same machine/user that ran the login.
 *
 * Start Plan JWT 通道只用 zcodeJwt（coding-plan/bigmodel 按量通道已移除）。
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
