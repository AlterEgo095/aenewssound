// ============================================================================
// Registry multi-fournisseurs — point d'entrée UNIQUE du cœur métier vers les
// providers externes. Aucun module AENEWS n'importe une implémentation Spotify
// directement : tout passe par getCatalogProvider(kind).
//
// Choix d'implémentation transparent :
//   - credentials SPOTIFY_* présents  → SpotifyCatalogProvider (API réelle)
//   - credentials absents             → SandboxSpotifyProvider (identifié,
//     config.sandbox = true, badges visibles dans l'UI)
// ============================================================================

import { db } from "@/lib/db";
import { ExternalProviderError, isProviderKind, type ExternalCatalogProvider, type ProviderKind } from "@/lib/external/types";
import { spotifyCredentialsFromEnv, SpotifyApiClient } from "./spotify/api";
import { SpotifyCatalogProvider } from "./spotify/catalog";
import { SandboxSpotifyProvider } from "./spotify/sandbox";
import { youtubeApiKeyFromEnv } from "./youtube/api";

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  SPOTIFY: "Spotify",
  APPLE_MUSIC: "Apple Music",
  YOUTUBE_MUSIC: "YouTube Music",
  DEEZER: "Deezer",
  AUDIOMACK: "Audiomack",
};

// Les instances sont mises en cache par process — le client HTTP garde ses
// tokens/rate-limiter entre les requêtes.
const instances = new Map<ProviderKind, ExternalCatalogProvider>();

/**
 * Garantit la présence des lignes ExternalProviderConfig.
 * SPOTIFY : activé (sandbox si credentials absents). Les autres fournisseurs
 * sont enregistrés comme DÉSACTIVÉS — l'architecture est prête, sans
 * fonctionnalité simulée déguisée en production.
 */
export async function ensureProviderConfigs() {
  const hasCreds = spotifyCredentialsFromEnv() !== null;
  await db.externalProviderConfig.upsert({
    where: { provider: "SPOTIFY" },
    update: { sandbox: !hasCreds },
    create: {
      provider: "SPOTIFY",
      displayName: "Spotify",
      enabled: true,
      sandbox: !hasCreds,
      settings: JSON.stringify({ defaultSearchTypes: ["ARTIST", "ALBUM", "TRACK"] }),
    },
  });
  // YOUTUBE_MUSIC : PAS un fournisseur de catalogue — c'est le LECTEUR PRIVÉ
  // (décision produit « voie B », usage strictement personnel). Actif
  // uniquement si YOUTUBE_API_KEY est présente ; le statut reflète l'env à
  // chaque démarrage (idempotent).
  const hasYoutubeKey = youtubeApiKeyFromEnv() !== null;
  await db.externalProviderConfig.upsert({
    where: { provider: "YOUTUBE_MUSIC" },
    update: { enabled: hasYoutubeKey, sandbox: false },
    create: {
      provider: "YOUTUBE_MUSIC",
      displayName: "YouTube (lecteur privé)",
      enabled: hasYoutubeKey,
      sandbox: false,
      settings: JSON.stringify({
        role: "PRIVATE_PLAYBACK",
        note: "Lecteur officiel YouTube intégré — usage strictement privé, hors royalties",
      }),
    },
  });
  for (const kind of ["APPLE_MUSIC", "DEEZER", "AUDIOMACK"] as const) {
    await db.externalProviderConfig.upsert({
      where: { provider: kind },
      update: {},
      create: { provider: kind, displayName: PROVIDER_DISPLAY_NAMES[kind], enabled: false, sandbox: true },
    });
  }
}

export async function getProviderConfig(provider: ProviderKind) {
  const config = await db.externalProviderConfig.findUnique({ where: { provider } });
  if (!config) {
    // auto-provision à la première utilisation
    await ensureProviderConfigs();
    return db.externalProviderConfig.findUnique({ where: { provider } });
  }
  return config;
}

export async function requireEnabledProvider(provider: ProviderKind) {
  const config = await getProviderConfig(provider);
  if (!config || !config.enabled) {
    throw new ExternalProviderError(`Fournisseur ${provider} désactivé`, provider, 503);
  }
  return config;
}

/** Instance catalogue du fournisseur (réel ou sandbox identifié). */
export async function getCatalogProvider(provider: ProviderKind): Promise<{
  provider: ExternalCatalogProvider;
  sandbox: boolean;
  enabled: boolean;
  configId: string;
}> {
  const config = await requireEnabledProvider(provider);
  const cachedInstance = instances.get(provider);
  if (cachedInstance) {
    return { provider: cachedInstance, sandbox: config.sandbox, enabled: config.enabled, configId: config.id };
  }

  let instance: ExternalCatalogProvider;
  if (provider === "SPOTIFY") {
    const creds = spotifyCredentialsFromEnv();
    instance =
      creds !== null
        ? new SpotifyCatalogProvider(new SpotifyApiClient(creds))
        : new SandboxSpotifyProvider();
  } else if (provider === "YOUTUBE_MUSIC") {
    // Le lecteur privé YouTube n'est PAS un fournisseur de catalogue
    // (métadonnées artiste/album/titre) — voir src/lib/external/youtube/.
    throw new ExternalProviderError(
      "YouTube est configuré comme lecteur privé uniquement (pas un fournisseur de catalogue) — utilisez /api/external/youtube/*",
      provider,
      501
    );
  } else {
    // Fournisseurs futurs : brancher ici leur adaptateur (Apple Music…).
    // Aucun adaptateur simulé caché : on refuse explicitement.
    throw new ExternalProviderError(
      `Fournisseur ${provider} : adaptateur non encore implémenté`,
      provider,
      501
    );
  }

  instances.set(provider, instance);
  // sandbox effectif = adaptateur sandbox (recouvre la config DB si env changé)
  const effectiveSandbox = instance.sandbox;
  if (effectiveSandbox !== config.sandbox) {
    await db.externalProviderConfig.update({ where: { id: config.id }, data: { sandbox: effectiveSandbox } });
  }
  return { provider: instance, sandbox: effectiveSandbox, enabled: config.enabled, configId: config.id };
}

export function assertProviderKind(value: string): ProviderKind {
  if (!isProviderKind(value)) {
    throw new ExternalProviderError(`Fournisseur inconnu : ${value}`, "SPOTIFY", 400);
  }
  return value;
}
