// ============================================================================
// Connexion du compte SPOTIFY d'un UTILISATEUR (usage B, v1.1 §6B).
// Distinct de l'accès serveur au catalogue (usage A — Client Credentials).
//
// Production : Authorization Code — /start génère l'URL d'autorisation signée
// (state JWT court) ; /callback échange le code et chiffre les tokens.
// Sandbox : connexion simulée explicite (tokens factices CHIFFRÉS, jamais
// renvoyés au client). Les tokens, même chiffrés, ne sortent jamais du serveur.
// ============================================================================

import { db } from "@/lib/db";
import { AUTH_SECRET } from "@/lib/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { encryptToken } from "@/lib/external/crypto";
import { spotifyCredentialsFromEnv } from "./api";

export const SPOTIFY_SCOPES = "user-read-email user-read-private playlist-read-private";

const STATE_TTL_MS = 10 * 60 * 1000;

// Nom du cookie de liaison state↔session (anti account-linkage CSRF) : le
// nonce du state DOIT correspondre au cookie HttpOnly posé par /start. Sans
// cela, un state divulgué (logs, Referer, historique) pourrait compléter un
// OAuth au profit d'un tiers pendant sa fenêtre de validité.
export const SPOTIFY_STATE_COOKIE = "aenews_spotify_oauth_state";

export function spotifyStateSign(userId: string, nonce: string): string {
  const payload = `${userId}.${nonce}.${Date.now()}`;
  const sig = createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function spotifyStateVerify(state: string): { userId: string; nonce: string } | null {
  const [payloadB64, sig] = state.split(".");
  if (!payloadB64 || !sig) return null;
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString();
  } catch {
    return null;
  }
  const expected = Buffer.from(
    createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url")
  );
  const provided = Buffer.from(sig);
  // Comparaison constant-time (le `!==` direct fuit le préfixe commun par timing).
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  const [userId, nonce, issuedAt] = payload.split(".");
  if (!userId || !nonce || !issuedAt) return null;
  if (Date.now() - Number(issuedAt) > STATE_TTL_MS) return null; // expiré
  return { userId, nonce };
}

/** URL d'autorisation réelle (Authorization Code) vers accounts.spotify.com. */
export function buildSpotifyAuthorizeUrl(redirectUri: string, state: string): string {
  const creds = spotifyCredentialsFromEnv();
  if (!creds) throw new Error("Credentials Spotify absents");
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("scope", SPOTIFY_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Échange code → tokens (serveur uniquement). */
export async function exchangeSpotifyCode(
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  externalAccountId: string;
  displayName: string | null;
}> {
  const creds = spotifyCredentialsFromEnv();
  if (!creds) throw new Error("Credentials Spotify absents");
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Spotify token exchange ${res.status}`);
  const tokenData = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const meRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { authorization: `Bearer ${tokenData.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!meRes.ok) throw new Error(`Spotify /me ${meRes.status}`);
  const me = (await meRes.json()) as { id: string; display_name?: string };
  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? null,
    expiresInSeconds: tokenData.expires_in,
    externalAccountId: me.id,
    displayName: me.display_name ?? null,
  };
}

export async function upsertConnection(input: {
  userId: string;
  providerId: string;
  externalAccountId: string;
  externalDisplayName: string | null;
  accessToken: string;
  refreshToken: string | null;
  scopes: string;
  expiresAt: Date | null;
  sandbox: boolean;
}) {
  const data = {
    externalAccountId: input.externalAccountId,
    externalDisplayName: input.externalDisplayName,
    accessTokenEnc: encryptToken(input.accessToken),
    refreshTokenEnc: input.refreshToken ? encryptToken(input.refreshToken) : null,
    scopes: input.scopes,
    expiresAt: input.expiresAt,
    sandbox: input.sandbox,
  };
  return db.externalAccountConnection.upsert({
    where: { userId_providerId: { userId: input.userId, providerId: input.providerId } },
    update: data,
    create: { userId: input.userId, providerId: input.providerId, ...data },
  });
}
