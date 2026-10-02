// ============================================================================
// Service IDENTITÉS EXTERNES (v1.1 §4) — couche reliant les objets AENEWS aux
// objets des fournisseurs. Un objet AENEWS peut avoir PLUSIEURS fournisseurs ;
// un objet externe ne peut pointer vers QU'UN objet AENEWS (anti-doublon DB).
// Les IDs Spotify ne sont JAMAIS mélangés aux IDs internes.
//
// Règle de synchronisation (v1.1 §9) : la sync n'efface JAMAIS une donnée
// AENEWS — une disparition temporaire chez le fournisseur ne détruit rien.
// ============================================================================

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  ExternalProviderError,
  type ExternalEntityType,
  type ExternalCatalogProvider,
  type ProviderKind,
} from "./types";

export type IdentityDTO = {
  id: string;
  provider: string;
  sandbox: boolean;
  entityType: ExternalEntityType;
  entityId: string;
  entityLabel: string | null;
  entityStatus: string | null;
  externalId: string;
  externalUrl: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string;
  lastSyncError: string | null;
  updatedAt: string;
};

async function resolveEntity(entityType: ExternalEntityType, entityId: string) {
  switch (entityType) {
    case "ARTIST": {
      const a = await db.artist.findFirst({ where: { id: entityId, deletedAt: null } });
      return a ? { label: a.name, status: a.status } : null;
    }
    case "ALBUM": {
      const a = await db.album.findFirst({ where: { id: entityId, deletedAt: null } });
      return a ? { label: a.title, status: a.status } : null;
    }
    case "TRACK": {
      const t = await db.track.findFirst({ where: { id: entityId, deletedAt: null } });
      return t ? { label: t.title, status: t.status } : null;
    }
  }
}

export async function requireEntity(
  entityType: ExternalEntityType,
  entityId: string
): Promise<{ label: string; status: string }> {
  const entity = await resolveEntity(entityType, entityId);
  if (!entity) throw new ApiError(404, `Entité AENEWS introuvable (${entityType})`);
  return entity;
}

export async function listIdentities(filter: {
  provider?: ProviderKind;
  entityType?: ExternalEntityType;
  entityId?: string;
}): Promise<IdentityDTO[]> {
  const rows = await db.externalCatalogIdentity.findMany({
    where: {
      ...(filter.provider ? { provider: { provider: filter.provider } } : {}),
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
    },
    include: { provider: { select: { provider: true, sandbox: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const dto: IdentityDTO[] = [];
  for (const row of rows) {
    const entityType = row.entityType as ExternalEntityType;
    const entity = await resolveEntity(entityType, row.entityId);
    dto.push({
      id: row.id,
      provider: row.provider.provider,
      sandbox: row.provider.sandbox,
      entityType,
      entityId: row.entityId,
      entityLabel: entity?.label ?? null,
      entityStatus: entity?.status ?? null,
      externalId: row.externalId,
      externalUrl: row.externalUrl,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastSyncStatus: row.lastSyncStatus,
      lastSyncError: row.lastSyncError,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return dto;
}

export async function attachIdentity(input: {
  provider: ProviderKind;
  providerId: string;
  entityType: ExternalEntityType;
  entityId: string;
  externalId: string;
  externalUrl: string | null;
  metadata: unknown;
  actorId: string;
}) {
  await requireEntity(input.entityType, input.entityId);

  // L'objet externe est-il déjà rattaché ailleurs ?
  const externalOwner = await db.externalCatalogIdentity.findUnique({
    where: {
      providerId_entityType_externalId: {
        providerId: input.providerId,
        entityType: input.entityType,
        externalId: input.externalId,
      },
    },
  });
  if (externalOwner && externalOwner.entityId !== input.entityId) {
    throw new ApiError(
      409,
      `Cet objet externe est déjà associé à une autre entité AENEWS (${externalOwner.entityId})`,
      "EXTERNAL_ALREADY_LINKED"
    );
  }

  const identity = await db.externalCatalogIdentity.upsert({
    where: {
      providerId_entityType_entityId: {
        providerId: input.providerId,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    },
    update: {
      externalId: input.externalId,
      externalUrl: input.externalUrl,
      metadata: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
      lastSyncedAt: new Date(),
      lastSyncStatus: "OK",
      lastSyncError: null,
    },
    create: {
      providerId: input.providerId,
      entityType: input.entityType,
      entityId: input.entityId,
      externalId: input.externalId,
      externalUrl: input.externalUrl,
      metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      lastSyncedAt: new Date(),
      lastSyncStatus: "OK",
      createdById: input.actorId,
    },
  });

  await audit({
    actorId: input.actorId,
    action: "EXTERNAL_IDENTITY_ATTACH",
    entityType: input.entityType,
    entityId: input.entityId,
    after: { provider: input.provider, externalId: input.externalId, identityId: identity.id },
  });
  return identity;
}

export async function detachIdentity(identityId: string, actorId: string) {
  const identity = await db.externalCatalogIdentity.findUnique({
    where: { id: identityId },
    include: { provider: { select: { provider: true } } },
  });
  if (!identity) throw new ApiError(404, "Identité externe introuvable");

  // On supprime le LIEN, jamais l'entité AENEWS.
  await db.externalSyncJob.deleteMany({ where: { identityId } });
  await db.externalCatalogIdentity.delete({ where: { id: identityId } });

  await audit({
    actorId,
    action: "EXTERNAL_IDENTITY_DETACH",
    entityType: identity.entityType,
    entityId: identity.entityId,
    before: { provider: identity.provider.provider, externalId: identity.externalId },
  });
  return identity;
}

/**
 * Rafraîchit le snapshot métadonnées d'une identité. Si l'objet a disparu chez
 * le fournisseur (404) : statut FAILED + message — l'entité AENEWS reste
 * INTACTE (jamais de suppression cascade depuis l'extérieur).
 */
export async function syncIdentity(
  identity: { id: string; entityType: string; entityId: string; externalId: string },
  provider: ExternalCatalogProvider
): Promise<{ status: "OK" | "FAILED"; error?: string }> {
  try {
    let fresh: { name: string; externalUrl: string | null };
    switch (identity.entityType as ExternalEntityType) {
      case "ARTIST": {
        const a = await provider.getArtist(identity.externalId);
        fresh = { name: a.name, externalUrl: a.externalUrl };
        break;
      }
      case "ALBUM": {
        const al = await provider.getAlbum(identity.externalId);
        fresh = { name: al.title, externalUrl: al.externalUrl };
        break;
      }
      case "TRACK": {
        const t = await provider.getTrack(identity.externalId);
        fresh = { name: t.title, externalUrl: t.externalUrl };
        break;
      }
      default:
        throw new ExternalProviderError("Type d'entité inconnu", provider.kind);
    }
    const entity = await resolveEntity(identity.entityType as ExternalEntityType, identity.entityId);
    await db.externalCatalogIdentity.update({
      where: { id: identity.id },
      data: {
        metadata: JSON.stringify({ ...fresh, syncedAt: new Date().toISOString() }),
        externalUrl: fresh.externalUrl ?? undefined,
        lastSyncedAt: new Date(),
        lastSyncStatus: "OK",
        lastSyncError: null,
      },
    });
    return { status: "OK" };
  } catch (e) {
    const notFound = e instanceof ExternalProviderError && e.status === 404;
    const message = notFound
      ? "Objet introuvable chez le fournisseur — entité AENEWS conservée (aucune suppression)"
      : e instanceof Error
        ? e.message
        : "Erreur de synchronisation";
    await db.externalCatalogIdentity.update({
      where: { id: identity.id },
      data: { lastSyncedAt: new Date(), lastSyncStatus: "FAILED", lastSyncError: message },
    });
    return { status: "FAILED", error: message };
  }
}

/** Identities déjà liées pour une liste d'IDs externes (enrichissement recherche). */
export async function mapExternalToEntities(
  providerId: string,
  entityType: ExternalEntityType,
  externalIds: string[]
): Promise<Map<string, { entityId: string; identityId: string }>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db.externalCatalogIdentity.findMany({
    where: { providerId, entityType, externalId: { in: externalIds } },
    select: { externalId: true, entityId: true, id: true },
  });
  return new Map(rows.map((r) => [r.externalId, { entityId: r.entityId, identityId: r.id }]));
}

// ---------------------------------------------------------------------------
// Liens externes publics — pour les fiches (artiste/album/titre).
// N'expose QUE le fournisseur + l'URL publique : jamais de métadonnée interne
// ni d'ID interne fournisseur mélangé aux IDs AENEWS.
// ---------------------------------------------------------------------------

export type ExternalLinkDTO = {
  provider: string;
  externalUrl: string | null;
};

export async function getExternalLinks(
  entityType: ExternalEntityType,
  entityId: string
): Promise<ExternalLinkDTO[]> {
  const rows = await db.externalCatalogIdentity.findMany({
    where: { entityType, entityId },
    include: { provider: { select: { provider: true, enabled: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return rows
    .filter((r) => r.provider.enabled)
    .map((r) => ({ provider: r.provider.provider, externalUrl: r.externalUrl }));
}
