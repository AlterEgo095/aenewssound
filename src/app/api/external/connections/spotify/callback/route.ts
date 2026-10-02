import { getProviderConfig } from "@/lib/external/registry";
import {
  exchangeSpotifyCode,
  spotifyStateVerify,
  upsertConnection,
  SPOTIFY_STATE_COOKIE,
} from "@/lib/external/spotify/connection";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/external/connections/spotify/callback?code=…&state=…
 * Callback navigateur du flux Authorization Code (production uniquement).
 * Échange le code, chiffre les tokens, redirige vers le profil.
 *
 * Sécurité : le nonce du state (signé HMAC) DOIT correspondre au cookie
 * HttpOnly posé par /start (liaison state↔session, anti account-linkage CSRF),
 * et le cookie est consommé (usage unique) quelle que soit l'issue du flux.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const origin = url.origin;

  // Cookie de liaison posé par /start (lecture brute : handler non-NextRequest).
  const rawCookie = req.headers.get("cookie") ?? "";
  const cookieNonce = rawCookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SPOTIFY_STATE_COOKIE}=`))
    ?.slice(SPOTIFY_STATE_COOKIE.length + 1);

  const clearStateCookie = (response: NextResponse) => {
    response.cookies.set({
      name: SPOTIFY_STATE_COOKIE,
      value: "",
      httpOnly: true,
      path: "/api/external/connections/spotify/callback",
      maxAge: 0,
    });
    return response;
  };

  const fail = (reason: string) =>
    clearStateCookie(
      NextResponse.redirect(
        `${origin}/?external_connection=error&reason=${encodeURIComponent(reason)}`,
        302
      )
    );

  if (!code || !state) return fail("parametres_manquants");
  const verified = spotifyStateVerify(state);
  if (!verified) return fail("state_invalide");
  // Liaison session : le state seul ne suffit pas, le navigateur doit porter
  // le cookie du même nonce (posé lors du /start de CETTE tentative).
  if (!cookieNonce || cookieNonce !== verified.nonce) {
    return fail("state_session_invalide");
  }

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
    return clearStateCookie(
      NextResponse.redirect(`${origin}/?external_connection=ok&provider=spotify`, 302)
    );
  } catch (e) {
    console.error("[spotify][callback]", e);
    return fail("exchange_echoue");
  }
}
