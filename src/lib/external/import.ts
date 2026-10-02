// ============================================================================
// IMPORT CONTRÔLÉ (v1.1 §8) — JAMAIS d'import aveugle.
//   Recherche → sélection → PREVIEW (doublons + correspondances) → confirmation
//   → création (DRAFT) ou association → provenance conservée (identity).
//
// Règle absolue : seules les MÉTADONNÉES sont importées. AUCUN fichier audio
// externe n'entre dans AENEWS — l'audio publié provient du pipeline AENEWS.
// Les titres/albums importés naissent en DRAFT : ils passeront par la
// modération comme tout le catalogue (workflow Studio, v1.1 §12).
// ============================================================================

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { slugify } from "@/lib/serialize";
import type { ExternalCatalogProvider, ExternalEntityType } from "./types";
import { requireEntity } from "./identity";

// ---------------------------------------------------------------------------
// PREVIEW — métadonnées normalisées + détection de doublons + candidats
// ---------------------------------------------------------------------------

export type ImportPreview = {
  provider: string;
  sandbox: boolean;
  entityType: ExternalEntityType;
  externalId: string;
  externalUrl: string | null;
  metadata: Record<string, unknown>;
  existingIdentity: { identityId: string; entityId: string } | null;
  catalogCandidates: { id: string; label: string; sublabel: string | null }[];
};

export async function previewImport(
  provider: ExternalCatalogProvider,
  providerId: string,
  sandbox: boolean,
  entityType: ExternalEntityType,
  externalId: string
): Promise<ImportPreview> {
  let metadata: Record<string, unknown>;
  let nameQuery: string;
  let externalUrl: string | null;

  switch (entityType) {
    case "ARTIST": {
      const a = await provider.getArtist(externalId);
      metadata = { name: a.name, genres: a.genres, followers: a.followers, imageUrl: a.imageUrl, popularity: a.popularity };
      nameQuery = a.name;
      externalUrl = a.externalUrl;
      break;
    }
    case "ALBUM": {
      const al = await provider.getAlbum(externalId);
      metadata = {
        title: al.title,
        artistName: al.artistName,
        artistExternalId: al.artistExternalId,
        releaseDate: al.releaseDate,
        typeHint: al.typeHint,
        upc: al.upc,
        trackCount: al.trackCount,
        imageUrl: al.imageUrl,
        popularity: al.popularity,
      };
      nameQuery = al.title;
      externalUrl = al.externalUrl;
      break;
    }
    case "TRACK": {
      const t = await provider.getTrack(externalId);
      metadata = {
        title: t.title,
        artistName: t.artistName,
        artistExternalId: t.artistExternalId,
        albumTitle: t.albumTitle,
        albumExternalId: t.albumExternalId,
        durationSeconds: t.durationSeconds,
        isrc: t.isrc,
        explicit: t.explicit,
        releaseDate: t.releaseDate,
        popularity: t.popularity,
      };
      nameQuery = t.title;
      externalUrl = t.externalUrl;
      break;
    }
  }

  const existing = await db.externalCatalogIdentity.findUnique({
    where: {
      providerId_entityType_externalId: { providerId, entityType, externalId },
    },
  });

  // Correspondances potentielles dans le catalogue AENEWS (association manuelle)
  const catalogCandidates: ImportPreview["catalogCandidates"] = [];
  if (entityType === "ARTIST") {
    const artists = await db.artist.findMany({
      where: { deletedAt: null, name: { contains: nameQuery } },
      take: 5,
      select: { id: true, name: true, slug: true, status: true },
    });
    for (const a of artists) catalogCandidates.push({ id: a.id, label: a.name, sublabel: a.slug });
  } else if (entityType === "ALBUM") {
    const albums = await db.album.findMany({
      where: { deletedAt: null, title: { contains: nameQuery } },
      take: 5,
      include: { artist: { select: { name: true } } },
    });
    for (const al of albums) catalogCandidates.push({ id: al.id, label: al.title, sublabel: al.artist.name });
  } else {
    const tracks = await db.track.findMany({
      where: { deletedAt: null, title: { contains: nameQuery } },
      take: 5,
      include: { mainArtist: { select: { name: true } } },
    });
    for (const t of tracks) catalogCandidates.push({ id: t.id, label: t.title, sublabel: t.mainArtist.name });
  }

  return {
    provider: provider.kind,
    sandbox,
    entityType,
    externalId,
    externalUrl,
    metadata,
    existingIdentity: existing ? { identityId: existing.id, entityId: existing.entityId } : null,
    catalogCandidates,
  };
}

// ---------------------------------------------------------------------------
// EXECUTE — mode LINK (association) ou CREATE (création de brouillon)
// ---------------------------------------------------------------------------

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "import";
  let candidate = root;
  for (let i = 2; i < 50; i++) {
    const clash =
      (await db.artist.findUnique({ where: { slug: candidate } })) ||
      (await db.album.findUnique({ where: { slug: candidate } })) ||
      (await db.track.findUnique({ where: { slug: candidate } }));
    if (!clash) return candidate;
    candidate = `${root}-${i}`;
  }
  return `${root}-${Date.now()}`;
}

export async function executeImport(input: {
  provider: ExternalCatalogProvider;
  providerId: string;
  sandbox: boolean;
  entityType: ExternalEntityType;
  externalId: string;
  mode: "LINK" | "CREATE";
  targetEntityId?: string;
  mainArtistId?: string; // requis pour CREATE ALBUM/TRACK
  albumId?: string; // optionnel pour CREATE TRACK
  actorId: string;
}): Promise<{ action: "LINKED" | "CREATED"; entityId: string; identityId: string }> {
  const preview = await previewImport(
    input.provider,
    input.providerId,
    input.sandbox,
    input.entityType,
    input.externalId
  );

  if (input.mode === "LINK") {
    if (!input.targetEntityId) throw new ApiError(400, "targetEntityId requis pour une association");
    await requireEntity(input.entityType, input.targetEntityId);
    const identity = await db.externalCatalogIdentity.upsert({
      where: {
        providerId_entityType_entityId: {
          providerId: input.providerId,
          entityType: input.entityType,
          entityId: input.targetEntityId,
        },
      },
      update: {
        externalId: input.externalId,
        externalUrl: preview.externalUrl,
        metadata: JSON.stringify(preview.metadata),
        lastSyncedAt: new Date(),
        lastSyncStatus: "OK",
        lastSyncError: null,
      },
      create: {
        providerId: input.providerId,
        entityType: input.entityType,
        entityId: input.targetEntityId,
        externalId: input.externalId,
        externalUrl: preview.externalUrl,
        metadata: JSON.stringify(preview.metadata),
        lastSyncedAt: new Date(),
        lastSyncStatus: "OK",
        createdById: input.actorId,
      },
    });
    await audit({
      actorId: input.actorId,
      action: "EXTERNAL_IMPORT_LINK",
      entityType: input.entityType,
      entityId: input.targetEntityId,
      after: { provider: input.provider.kind, externalId: input.externalId },
    });
    return { action: "LINKED", entityId: input.targetEntityId, identityId: identity.id };
  }

  // --- CREATE : création contrôlée de métadonnées (jamais d'audio externe) ---
  // Garde ANTI-DOUBLON enforcement : le preview informe l'UI, mais l'exécution
  // re-vérifie — un objet externe déjà lié à une entité AENEWS ne peut pas
  // créer une seconde entité (sinon entité orpheline + P2002 en milieu de route).
  if (preview.existingIdentity) {
    throw new ApiError(
      409,
      `EXTERNAL_ALREADY_LINKED : ce ${input.entityType} externe est déjà associé à une entité AENEWS`,
      "EXTERNAL_ALREADY_LINKED"
    );
  }
  const meta = preview.metadata;

  if (input.entityType === "ARTIST") {
    const name = String(meta.name ?? "").trim();
    if (!name) throw new ApiError(400, "Nom d'artiste manquant dans les métadonnées");
    const slug = await uniqueSlug(name);
    // TRANSACTION : entité + identité naissent ensemble — aucun état partiel
    // (artiste orphelin sans identité) en cas d'échec ou de course concurrente.
    const { entity, identity } = await db.$transaction(async (tx) => {
      const a = await tx.artist.create({
        data: {
          name,
          slug,
          status: "ACTIVE",
          verifiedAt: null,
          profile: { create: { bio: null } },
        },
      });
      const id = await tx.externalCatalogIdentity.create({
        data: {
          providerId: input.providerId,
          entityType: "ARTIST",
          entityId: a.id,
          externalId: input.externalId,
          externalUrl: preview.externalUrl,
          metadata: JSON.stringify(meta),
          lastSyncedAt: new Date(),
          lastSyncStatus: "OK",
          createdById: input.actorId,
        },
      });
      return { entity: a, identity: id };
    });
    await audit({
      actorId: input.actorId,
      action: "EXTERNAL_IMPORT_CREATE",
      entityType: "ARTIST",
      entityId: entity.id,
      after: { provider: input.provider.kind, externalId: input.externalId, slug },
    });
    return { action: "CREATED", entityId: entity.id, identityId: identity.id };
  }

  if (!input.mainArtistId) {
    throw new ApiError(400, "mainArtistId requis : rattachez l'import à un artiste AENEWS");
  }
  await requireEntity("ARTIST", input.mainArtistId);

  if (input.entityType === "ALBUM") {
    const title = String(meta.title ?? "").trim();
    if (!title) throw new ApiError(400, "Titre d'album manquant dans les métadonnées");
    const slug = await uniqueSlug(title);
    const { entity, identity } = await db.$transaction(async (tx) => {
      const al = await tx.album.create({
        data: {
          artistId: input.mainArtistId!,
          title,
          slug,
          type: (["ALBUM", "EP", "SINGLE", "MIXTAPE"] as const).includes(meta.typeHint as "ALBUM")
            ? ((meta.typeHint as "ALBUM" | "EP" | "SINGLE") ?? "ALBUM")
            : "ALBUM",
          releaseDate: typeof meta.releaseDate === "string" ? new Date(meta.releaseDate) : null,
          upc: typeof meta.upc === "string" && meta.upc ? meta.upc : undefined,
          status: "DRAFT", // publiera uniquement via modération AENEWS
        },
      });
      const id = await tx.externalCatalogIdentity.create({
        data: {
          providerId: input.providerId,
          entityType: "ALBUM",
          entityId: al.id,
          externalId: input.externalId,
          externalUrl: preview.externalUrl,
          metadata: JSON.stringify(meta),
          lastSyncedAt: new Date(),
          lastSyncStatus: "OK",
          createdById: input.actorId,
        },
      });
      return { entity: al, identity: id };
    });
    await audit({
      actorId: input.actorId,
      action: "EXTERNAL_IMPORT_CREATE",
      entityType: "ALBUM",
      entityId: entity.id,
      after: { provider: input.provider.kind, externalId: input.externalId, mainArtistId: input.mainArtistId },
    });
    return { action: "CREATED", entityId: entity.id, identityId: identity.id };
  }

  // TRACK
  const title = String(meta.title ?? "").trim();
  if (!title) throw new ApiError(400, "Titre manquant dans les métadonnées");
  const durationSeconds = Number(meta.durationSeconds ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ApiError(400, "Durée invalide dans les métadonnées du titre");
  }
  const slug = await uniqueSlug(title);
  const { entity, identity } = await db.$transaction(async (tx) => {
    const t = await tx.track.create({
      data: {
        mainArtistId: input.mainArtistId!,
        albumId: input.albumId ?? null,
        title,
        slug,
        trackNumber: typeof meta.trackNumber === "number" ? meta.trackNumber : undefined,
        durationSeconds: Math.round(durationSeconds),
        isrc: typeof meta.isrc === "string" && meta.isrc ? meta.isrc : undefined,
        explicit: meta.explicit === true,
        status: "DRAFT", // audio à uploader via pipeline AENEWS + modération
      },
    });
    const id = await tx.externalCatalogIdentity.create({
      data: {
        providerId: input.providerId,
        entityType: "TRACK",
        entityId: t.id,
        externalId: input.externalId,
        externalUrl: preview.externalUrl,
        metadata: JSON.stringify(meta),
        lastSyncedAt: new Date(),
        lastSyncStatus: "OK",
        createdById: input.actorId,
      },
    });
    return { entity: t, identity: id };
  });
  await audit({
    actorId: input.actorId,
    action: "EXTERNAL_IMPORT_CREATE",
    entityType: "TRACK",
    entityId: entity.id,
    after: { provider: input.provider.kind, externalId: input.externalId, mainArtistId: input.mainArtistId },
  });
  return { action: "CREATED", entityId: entity.id, identityId: identity.id };
}
