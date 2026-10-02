// ============================================================================
// Chiffrement AES-256-GCM des tokens de connexion utilisateur (Spotify etc.).
// La clé dérive de AUTH_SECRET (prod : secrets manager, v1.1 §19) — les tokens
// ne sont JAMAIS stockés en clair ni exposés au frontend.
// Format : v1:<iv-base64url>:<tag-base64url>:<ciphertext-base64url>
// ============================================================================

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AUTH_SECRET } from "@/lib/config";

const KEY = createHash("sha256").update(`${AUTH_SECRET}::external-connections`).digest();

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptToken(enc: string): string {
  const [version, ivB64, tagB64, dataB64] = enc.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Token chiffré invalide");
  }
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
