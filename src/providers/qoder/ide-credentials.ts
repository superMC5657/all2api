import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Extracts the international Qoder IDE's own login identity from its local
 * store, so all2api can reuse the desktop login without any interactive
 * token creation.
 *
 * The IDE (a VS Code fork) keeps its auth document in
 * %APPDATA%/Qoder/User/globalStorage/state.vscdb under
 * `secret://aicoding.auth.userInfo`, encrypted with the Electron safeStorage
 * (Chromium OSCrypt) scheme: "v10" prefix + AES-256-GCM, where the AES key
 * itself sits DPAPI-protected in `Local State` → os_crypt.encrypted_key.
 * Everything only opens for the same Windows user that ran the IDE.
 */

export interface QoderIdeIdentity {
  /** dt-… access token — used as a plain Bearer against the intl gateway. */
  token: string;
  refreshToken: string;
  uid: string;
  nickname: string;
  /** Epoch ms; 0 when unknown. */
  expireTime: number;
}

export function readQoderIdeIdentity(ideDataDir?: string): QoderIdeIdentity | null {
  if (process.platform !== "win32") return null; // DPAPI-based; other platforms need different key stores
  try {
    const dir = ideDataDir ?? join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Qoder");
    const db = new DatabaseSync(join(dir, "User", "globalStorage", "state.vscdb"), { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("secret://aicoding.auth.userInfo") as
      | { value: string | Buffer }
      | undefined;
    db.close();
    if (!row) return null;

    const blob = Buffer.from(JSON.parse(String(row.value)).data as number[]);
    if (blob.slice(0, 3).toString() !== "v10") return null;
    const key = osCryptKey(dir);
    const plain = aesGcmDecrypt(blob.slice(3), key);
    const ui = JSON.parse(plain) as Record<string, unknown>;
    const token = typeof ui["token"] === "string" ? ui["token"] : "";
    if (!token) return null;
    return {
      token,
      refreshToken: typeof ui["refreshToken"] === "string" ? ui["refreshToken"] : "",
      uid: typeof ui["id"] === "string" ? ui["id"] : "",
      nickname: typeof ui["name"] === "string" ? ui["name"] : "",
      expireTime: Number(ui["expireTime"] ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

function osCryptKey(userDataDir: string): Buffer {
  const ls = JSON.parse(readFileSync(join(userDataDir, "Local State"), "utf8")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const wrapped = Buffer.from(ls.os_crypt?.encrypted_key ?? "", "base64");
  if (wrapped.slice(0, 5).toString() !== "DPAPI") throw new Error("unexpected os_crypt key format");

  const tmpBlob = join(process.env["TEMP"] ?? ".", "all2api-qkey.bin");
  const tmpKey = join(process.env["TEMP"] ?? ".", "all2api-qkey.key");
  writeFileSync(tmpBlob, wrapped.slice(5));
  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Security; ` +
          `$b=[IO.File]::ReadAllBytes('${tmpBlob}'); ` +
          `$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
          `[IO.File]::WriteAllBytes('${tmpKey}',$k)`,
      ],
      { timeout: 20_000, windowsHide: true },
    );
    if (ps.status !== 0) throw new Error("DPAPI unlock failed: " + String(ps.stderr).slice(0, 200));
    return readFileSync(tmpKey);
  } finally {
    // transient key material never outlives this call
    for (const f of [tmpBlob, tmpKey]) {
      try {
        unlinkSync(f);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function aesGcmDecrypt(data: Buffer, key: Buffer): string {
  const nonce = data.slice(0, 12);
  const tag = data.slice(data.length - 16);
  const ct = data.slice(12, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
