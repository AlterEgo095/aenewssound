// ============================================================================
// Vérification opérationnelle des credentials Spotify (Client Credentials).
// Usage : bun run scripts/spotify-token-check.ts
// Lit SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET depuis l'environnement,
// interroge le vrai endpoint accounts.spotify.com, puis effectue une requête
// de recherche réelle pour valider la chaîne complète.
// Ne print JAMAIS le secret — uniquement des statuts.
// ============================================================================

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

async function main() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("❌ SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET absents de l'environnement");
    process.exit(1);
  }
  console.log(`✓ Credentials présents (ID ${clientId.slice(0, 6)}…${clientId.slice(-4)}, secret ${clientSecret.length} caractères)`);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let token: string;
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      console.error(
        `❌ Token refusé — HTTP ${res.status} : ${body.error ?? "?"} (${body.error_description ?? "sans détail"})`
      );
      console.error(
        "   Causes possibles : secret incorrect (copier avec le bouton du dashboard, pas à l'œil),"
      );
      console.error(
        "   app supprimée/pivotée, ou credentials d'une autre app. Corriger .env puis relancer."
      );
      process.exit(2);
    }
    token = body.access_token;
    console.log(`✓ Token Client Credentials obtenu (expire dans ${body.expires_in}s)`);
  } catch (e) {
    console.error(`❌ Endpoint token injoignable : ${e instanceof Error ? e.message : e}`);
    process.exit(3);
  }

  // Recherche réelle de bout en bout (artiste congolais emblématique)
  const searchUrl = new URL(`${API_BASE}/search`);
  searchUrl.searchParams.set("q", "Fally Ipupa");
  searchUrl.searchParams.set("type", "artist");
  searchUrl.searchParams.set("limit", "1");
  try {
    const res = await fetch(searchUrl, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`❌ Recherche réelle échouée — HTTP ${res.status} : ${text.slice(0, 200)}`);
      process.exit(4);
    }
    const data = (await res.json()) as {
      artists?: { items?: Array<{ name: string; id: string; followers?: { total: number } }> };
    };
    const artist = data.artists?.items?.[0];
    if (!artist) {
      console.error("❌ Recherche OK mais réponse inattendue (aucun artiste)");
      process.exit(5);
    }
    console.log(
      `✓ Recherche réelle OK — Spotify a répondu : "${artist.name}" (id ${artist.id}, ${artist.followers?.total ?? "?"} followers)`
    );
    console.log("🎉 Chaîne Spotify complète opérationnelle (auth + API catalogue).");
  } catch (e) {
    console.error(`❌ API catalogue injoignable : ${e instanceof Error ? e.message : e}`);
    process.exit(6);
  }
}

main();
