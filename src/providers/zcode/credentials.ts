import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createZCodeCredentialCipher } from "./cipher.js";

export interface ZCodeUserInfo {
  id?: string;
  [key: string]: unknown;
}

export interface ZCodeCredentials {
  oauthAccessToken?: string;
  zcodeJwt?: string;
  activeProvider?: string;
  userInfo?: ZCodeUserInfo;
}

/**
 * Reads and decrypts ~/.zcode/v2/credentials.json (the file ZCode CLI maintains
 * after `zcode login`). Values are AES-256-GCM encrypted with a machine-derived
 * key, so decryption only works on the same machine/user that ran the login.
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

  let userInfo: ZCodeUserInfo | undefined;
  const rawUserInfo = dec("oauth:bigmodel:user_info");
  if (rawUserInfo) {
    try {
      userInfo = JSON.parse(rawUserInfo) as ZCodeUserInfo;
    } catch {
      userInfo = undefined;
    }
  }

  const creds: ZCodeCredentials = {
    oauthAccessToken: dec("oauth:bigmodel:access_token"),
    zcodeJwt: dec("zcodejwttoken"),
    activeProvider: dec("oauth:active_provider"),
    userInfo,
  };
  return creds;
}
