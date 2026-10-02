import { getProviderConfig } from "@/lib/external/registry";
import {
  exchangeSpotifyCode,
  spotifyStateVerify,
  upsertConnection,
} from "@/lib/external/spotify/connection";

export const dynamic = "force-dynamic";

/**
 * GET /api/external/connections/spotify/callback?code=…&state=…
 * Callback navigateur du flux Authorization Code (production uniquement).
 * Échange le code, chiffre les tokens, redirige vers le profil.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const origin = url.origin;

  const fail = (reason: string) =>
    Response.redirect(`${origin}/?external_connection=error&reason=${encodeURIComponent(reason)}`, 302);

  if (!code || !state) return fail("parametres_manquants");
  const verified = spotifyStateVerify(state);
  if (!verified) return fail("state_invalide");

  try {
    const config = await getProviderConfig("SPOTIFY");
    if (!config || !config.enabled) return fail("provider_desactive");

    const redirectUri =
      process.env.SPOTIFY_REDIRECT_URI ?? `${origin}/api/external/connections/spotify/callback`;
    const tokens = await exchangeSpotifyCode(code, redirectUri);
    await upsertConnection({
      userId: verified.userId,
      providerId: config.id,
      externalAccountId: tokens.externalAccountId,
      externalDisplayName: tokens.displayName,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scopes: "user-read-email user-read-private playlist-read-private",
      expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      sandbox: false,
    });
    return Response.redirect(`${origin}/?external_connection=ok&provider=spotify`, 302);
  } catch (e) {
    console.error("[spotify][callback]", e);
    return fail("exchange_echoue");
  }
}
