// ============================================================================
// SpotifyApiClient — couche HTTP isolée (v1.1 §5). AUCUN controller ne fait
// d'appel direct : tout passe par ici (auth, expiration de token, erreurs,
// retry contrôlé, rate limiting, timeout, logs, validation des réponses).
//
// Secrets EXCLUSIVEMENT via variables d'environnement :
//   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (Authorization Code côté serveur)
//   — jamais en dur dans le code ni dans Git.
// ============================================================================

import { ExternalProviderError } from "@/lib/external/types";
import { TokenBucketLimiter } from "@/lib/external/rate-limit";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2; // au-delà : on échoue proprement (le worker reprendra)

type TokenResponse = { access_token: string; token_type: string; expires_in: number };

export class SpotifyCredentials {
  constructor(
    public readonly clientId: string,
    public readonly clientSecret: string
  ) {}
}

export function spotifyCredentialsFromEnv(): SpotifyCredentials | null {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null; // pas de secret en dur — jamais
  return new SpotifyCredentials(id, secret);
}

export class SpotifyApiClient {
  private token: { value: string; expiresAt: number } | null = null;
  private limiter = new TokenBucketLimiter(8, 6); // ~6 req/s soutenues, bursts 8

  constructor(private readonly creds: SpotifyCredentials) {}

  // -- Authentification serveur (Client Credentials) -------------------------

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value; // marge 60 s avant expiration
    }
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString(
      "base64"
    );
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ExternalProviderError(
        `Spotify token endpoint ${res.status} — vérifier SPOTIFY_CLIENT_ID/SECRET`,
        "SPOTIFY",
        res.status,
        res.status >= 500
      );
    }
    const data = (await res.json()) as TokenResponse;
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
      throw new ExternalProviderError("Réponse token Spotify invalide", "SPOTIFY");
    }
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    console.info("[spotify] token serveur renouvelé (expire dans", data.expires_in, "s)");
    return this.token.value;
  }

  // -- Requête générique : rate limit → timeout → retry 429/5xx → 401 une fois ----

  async request<T>(method: string, path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(API_BASE + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }

    let refreshed = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.limiter.acquire();
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          console.warn("[spotify] réseau/timeout, retry", attempt + 1);
          continue;
        }
        throw new ExternalProviderError(
          `Spotify injoignable : ${e instanceof Error ? e.message : "erreur réseau"}`,
          "SPOTIFY",
          undefined,
          true
        );
      }

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.token = null; // force le renouvellement puis retente immédiatement
        attempt--; // ne consomme pas un essai de retry pour un 401
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get("retry-after") ?? "1");
          const waitMs = Math.min(30_000, Math.max(500, retryAfter * 1000));
          console.warn(`[spotify] ${res.status} — attente ${waitMs} ms puis retry`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        const message = body?.error?.message ?? `Spotify HTTP ${res.status}`;
        if (res.status === 404) {
          throw new ExternalProviderError(message, "SPOTIFY", 404, false);
        }
        throw new ExternalProviderError(message, "SPOTIFY", res.status, res.status >= 500 || res.status === 429);
      }

      return (await res.json()) as T;
    }
    throw new ExternalProviderError("Spotify : nombre maximum de tentatives atteint", "SPOTIFY", undefined, true);
  }

  get limiterStats() {
    return this.limiter.stats;
  }
}
