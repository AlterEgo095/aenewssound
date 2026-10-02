import { db } from "@/lib/db";
import { ApiError, handle, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getProviderConfig } from "@/lib/external/registry";
import {
  buildSpotifyAuthorizeUrl,
  spotifyStateSign,
  upsertConnection,
  SPOTIFY_STATE_COOKIE,
} from "@/lib/external/spotify/connection";

export const dynamic = "force-dynamic";

/**
 * GET /api/external/connections/spotify/start
 * Démarre la connexion du compte Spotify de l'utilisateur (usage B).
 *  - Production (credentials présents) : renvoie l'URL d'autorisation
 *    accounts.spotify.com (state signé HMAC, TTL 10 min).
 *  - Sandbox (credentials absents) : crée une connexion simulée clairement
 *    identifiée (sandbox=true) — tokens factices chiffrés, jamais exposés.
 */
export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const config = await getProviderConfig("SPOTIFY");
    if (!config || !config.enabled) {
      throw new ApiError(503, "Spotify n'est pas activé sur cette plateforme");
    }

    const origin = new URL(req.url).origin;
    const redirectUri =
      process.env.SPOTIFY_REDIRECT_URI ?? `${origin}/api/external/connections/spotify/callback`;

    if (!config.sandbox) {
      // Liaison state↔session : le nonce est à la fois signé dans le state ET
      // posé en cookie HttpOnly (lisible uniquement par le callback serveur).
      // Le callback exigera la correspondance des deux — un state divulgué seul
      // ne vaut rien (anti account-linkage CSRF).
      const nonce = crypto.randomUUID();
      const state = spotifyStateSign(user.id, nonce);
      const response = ok({
        mode: "PRODUCTION_OAUTH",
        authorizeUrl: buildSpotifyAuthorizeUrl(redirectUri, state),
      });
      response.cookies.set({
        name: SPOTIFY_STATE_COOKIE,
        value: nonce,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/api/external/connections/spotify/callback",
        maxAge: 600,
      });
      return response;
    }

    // ---- SANDBOX : connexion simulée, identifiée comme telle ---------------
    const sandboxAccountId = `sbx-${user.id.slice(-8)}`;
    const connection = await upsertConnection({
      userId: user.id,
      providerId: config.id,
      externalAccountId: sandboxAccountId,
      externalDisplayName: `${user.displayName} (compte sandbox)`,
      accessToken: `sbx-access-${crypto.randomUUID()}`, // chiffré AES-GCM au repos
      refreshToken: `sbx-refresh-${crypto.randomUUID()}`,
      scopes: "user-read-email user-read-private",
      expiresAt: new Date(Date.now() + 3600_000),
      sandbox: true,
    });
    return ok({
      mode: "SANDBOX_SIMULATED",
      sandbox: true,
      connection: {
        id: connection.id,
        externalAccountId: connection.externalAccountId,
        connectedAt: connection.connectedAt.toISOString(),
      },
    });
  });
}
