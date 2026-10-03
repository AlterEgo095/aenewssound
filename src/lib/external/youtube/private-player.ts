// ============================================================================
// LECTEUR PRIVÉ YouTube (décision produit « voie B ») — usage STRICTEMENT
// personnel : trouver la version YouTube d'un titre du catalogue AENEWS et la
// jouer via le lecteur officiel intégré (Iframe API).
//
// RÈGLES DU MODE PRIVÉ (documentées dans README.md) :
//   1. Le titre AENEWS reste la source propriétaire ; YouTube est un
//      RACCOURCI D'ÉCOUTE personnel, clairement étiqueté « YouTube » dans l'UI.
//   2. L'écoute YouTube ne crée JAMAIS de PlaybackEvent / ValidatedListening /
//      RoyaltyLine : le contenu n'est pas détenu par AENEWS — le ledger de
//      royalties reste intègre (Écoute ≠ Royalty, v1.1 §15).
//   3. Le lien titre→vidéo est mémorisé comme identité externe
//      (ExternalCatalogIdentity, provider YOUTUBE_MUSIC) : anti-doublon DB,
//      audit EXTERNAL_IDENTITY_ATTACH, dissociation sans destruction.
//   4. Aucune donnée simulée : sans YOUTUBE_API_KEY, échec fermé 503.
// ============================================================================

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { attachIdentity, detachIdentity, requireEntity } from "@/lib/external/identity";
import { ExternalProviderError, type ProviderKind } from "@/lib/external/types";
import { youtubeApiKeyFromEnv, YoutubeApiClient, type YoutubeVideo } from "./api";

const PROVIDER: ProviderKind = "YOUTUBE_MUSIC";

export function privatePlaybackStatus(): { available: boolean; reason: string } {
  return youtubeApiKeyFromEnv() === null
    ? {
        available: false,
        reason:
          "Lecteur YouTube non configuré — ajoutez YOUTUBE_API_KEY dans .env (Google Cloud → YouTube Data API v3 → clé API)",
      }
    : { available: true, reason: "" };
}

function requireClient(): YoutubeApiClient {
  const key = youtubeApiKeyFromEnv();
  if (!key) {
    throw new ExternalProviderError(
      "Recherche YouTube non configurée — ajoutez YOUTUBE_API_KEY dans .env pour activer le lecteur privé",
      PROVIDER,
      503
    );
  }
  return new YoutubeApiClient(key);
}

async function requireProviderConfigId(): Promise<string> {
  const config = await db.externalProviderConfig.findUnique({ where: { provider: PROVIDER } });
  if (!config || !config.enabled) {
    throw new ExternalProviderError(
      "Lecteur YouTube désactivé (YOUTUBE_API_KEY absente au démarrage)",
      PROVIDER,
      503
    );
  }
  return config.id;
}

export type LinkedVideo = YoutubeVideo & { identityId: string };

/** Vidéo mémorisée pour un titre (identité YOUTUBE_MUSIC/TRACK), si elle existe. */
export async function getLinkedVideo(trackId: string): Promise<LinkedVideo | null> {
  const row = await db.externalCatalogIdentity.findFirst({
    where: {
      provider: { provider: PROVIDER },
      entityType: "TRACK",
      entityId: trackId,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!row) return null;
  let meta: Partial<YoutubeVideo> = {};
  if (row.metadata) {
    try {
      meta = JSON.parse(row.metadata) as Partial<YoutubeVideo>;
    } catch {
      meta = {};
    }
  }
  return {
    identityId: row.id,
    videoId: row.externalId,
    title: meta.title ?? row.externalId,
    channelTitle: meta.channelTitle ?? "",
    thumbnailUrl: meta.thumbnailUrl ?? null,
    durationText: meta.durationText ?? null,
    publishedAt: meta.publishedAt ?? null,
  };
}

export type ResolveResult =
  | { mode: "LINKED"; video: LinkedVideo }
  | { mode: "CANDIDATES"; candidates: YoutubeVideo[] };

/**
 * Résolution d'un titre : le lien mémorisé d'abord, sinon une recherche
 * automatique « {artiste} {titre} audio » propose des versions candidates.
 */
export async function resolveForTrack(trackId: string): Promise<ResolveResult> {
  await requireEntity("TRACK", trackId);
  const linked = await getLinkedVideo(trackId);
  if (linked) return { mode: "LINKED", video: linked };

  const track = await db.track.findUnique({
    where: { id: trackId },
    select: { title: true, mainArtist: { select: { name: true } } },
  });
  if (!track) throw new ApiError(404, "Titre introuvable");

  const client = requireClient();
  const candidates = await client.searchVideos(
    `${track.mainArtist.name} ${track.title} audio`,
    8
  );
  return { mode: "CANDIDATES", candidates };
}

/** Mémorise (ou remplace) la vidéo YouTube d'un titre. Audit + anti-doublon. */
export async function linkVideo(input: {
  trackId: string;
  video: YoutubeVideo;
  actorId: string;
}): Promise<LinkedVideo> {
  await requireEntity("TRACK", input.trackId);
  const providerId = await requireProviderConfigId();
  const identity = await attachIdentity({
    provider: PROVIDER,
    providerId,
    entityType: "TRACK",
    entityId: input.trackId,
    externalId: input.video.videoId,
    externalUrl: `https://www.youtube.com/watch?v=${input.video.videoId}`,
    metadata: {
      title: input.video.title,
      channelTitle: input.video.channelTitle,
      thumbnailUrl: input.video.thumbnailUrl,
      durationText: input.video.durationText,
      publishedAt: input.video.publishedAt,
      purpose: "PRIVATE_PLAYBACK", // marqueur explicite : lien de lecture privée
    },
    actorId: input.actorId,
  });
  return { ...input.video, identityId: identity.id };
}

/** Retire le lien YouTube d'un titre (le titre AENEWS n'est JAMAIS touché). */
export async function unlinkVideo(trackId: string, actorId: string): Promise<void> {
  const linked = await getLinkedVideo(trackId);
  if (!linked) throw new ApiError(404, "Aucune vidéo YouTube liée à ce titre");
  await detachIdentity(linked.identityId, actorId);
}

/** Recherche libre (changer de version, ou jouer un résultat Spotify externe). */
export async function searchByQuery(query: string, limit = 8): Promise<YoutubeVideo[]> {
  const client = requireClient();
  return client.searchVideos(query, limit);
}
