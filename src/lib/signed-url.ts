import crypto from "crypto";
import { AUTH_SECRET } from "@/lib/config";

// URLs signées à expiration courte (v1.1 §19) — signed URLs + token validation.
// Format : /api/stream?p=<base64url({key, exp})>&sig=<hmac-sha256>

function hmac(value: string): string {
  return crypto.createHmac("sha256", AUTH_SECRET).update(value).digest("base64url");
}

export function signStreamUrl(key: string, ttlSeconds = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ key, exp })).toString("base64url");
  return `/api/stream?p=${payload}&sig=${hmac(payload)}`;
}

export function verifySignedUrl(
  payload: string,
  signature: string
): { key: string; exp: number } | null {
  const expected = hmac(payload);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      key?: string;
      exp?: number;
    };
    if (!data.key || !data.exp || data.exp * 1000 < Date.now()) return null;
    return { key: data.key, exp: data.exp };
  } catch {
    return null;
  }
}
