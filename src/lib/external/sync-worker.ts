// ============================================================================
// SPOTIFY SYNC WORKER (v1.1 §9) — file de synchronisation idempotente,
// reprenable et observable.
//
// Garanties :
//  - IDEMPOTENT : un job REFRESH_METADATA rafraîchit un snapshot — rejouable
//    sans effet de bord ; un seul job actif par identité (PENDING/RUNNING).
//  - REPRENABLE : un job RUNNING resté orphelin (crash) est réclamé après un
//    stale timeout ; FAILED reste dans la file, rejouable via enqueue.
//  - OBSERVABLE : status/attempts/lastError/startedAt/finishedAt persistés.
//  - NON DESTRUCTIF : jamais de suppression de données AENEWS déclenchée par
//    l'extérieur (cf. syncIdentity — une disparition provider = FAILED + note).
//
// Déclenchement : POST /api/admin/external/sync/tick (worker in-process).
// Production : même logique déplacée dans un worker BullMQ dédié.
// ============================================================================

import { db } from "@/lib/db";
import type { ExternalEntityType, ProviderKind } from "./types";
import { getCatalogProvider } from "./registry";
import { syncIdentity } from "./identity";

const STALE_RUNNING_MS = 5 * 60 * 1000; // RUNNING sans fin depuis 5 min → réclamé
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;

export type EnqueueResult = { queued: number; skipped: number };

/** Enfile des jobs REFRESH_METADATA pour les identités correspondantes. */
export async function enqueueSyncJobs(filter: {
  provider: ProviderKind;
  entityType?: ExternalEntityType;
  entityId?: string;
}): Promise<EnqueueResult> {
  const config = await db.externalProviderConfig.findUnique({ where: { provider: filter.provider } });
  if (!config) return { queued: 0, skipped: 0 };

  const identities = await db.externalCatalogIdentity.findMany({
    where: {
      providerId: config.id,
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
    },
    select: { id: true, entityType: true, entityId: true },
  });

  const active = await db.externalSyncJob.findMany({
    where: { providerId: config.id, status: { in: ["PENDING", "RUNNING"] } },
    select: { identityId: true },
  });
  const busy = new Set(active.map((j) => j.identityId));

  let queued = 0;
  let skipped = 0;
  for (const identity of identities) {
    if (busy.has(identity.id)) {
      skipped += 1;
      continue;
    }
    await db.externalSyncJob.create({
      data: {
        providerId: config.id,
        identityId: identity.id,
        entityType: identity.entityType,
        entityId: identity.entityId,
        operation: "REFRESH_METADATA",
        status: "PENDING",
      },
    });
    queued += 1;
  }
  return { queued, skipped };
}

export type TickResult = { processed: number; done: number; failed: number; retried: number };

/**
 * Traite un lot de jobs PENDING (et récupère les RUNNING périmés).
 * Retourne le détail — observable et testable.
 */
export async function processPendingJobs(max = BATCH_SIZE): Promise<TickResult> {
  // 1) Réclamation des RUNNING périmés (crash/restart) → repassent en PENDING
  const staleDeadline = new Date(Date.now() - STALE_RUNNING_MS);
  const reclaimed = await db.externalSyncJob.updateMany({
    where: { status: "RUNNING", startedAt: { lt: staleDeadline } },
    data: { status: "PENDING", lastError: "Job réclamé après interruption (stale)" },
  });

  // 2) Réactivation des FAILED rejouables sous MAX_ATTEMPTS ? Non automatique :
  //    le retry est piloté (enqueue recrée un job). On ne masque pas l'erreur.
  const pending = await db.externalSyncJob.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: max,
    select: {
      id: true,
      providerId: true,
      identityId: true,
      entityType: true,
      entityId: true,
      operation: true,
      attempts: true,
    },
  });

  let done = 0;
  let failed = 0;

  for (const job of pending) {
    // Claim atomique : PENDING → RUNNING
    const claimed = await db.externalSyncJob.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue; // déjà pris par un autre tick

    try {
      // Le job référence le fournisseur par son id de config — résoudre le kind.
      const config = await db.externalProviderConfig.findUnique({ where: { id: job.providerId } });
      if (!config) throw new Error("Configuration fournisseur introuvable");
      const { provider } = await getCatalogProvider(config.provider as ProviderKind);
      if (job.operation === "REFRESH_METADATA") {
        if (!job.identityId) throw new Error("identityId manquant pour REFRESH_METADATA");
        const identity = await db.externalCatalogIdentity.findUnique({
          where: { id: job.identityId },
        });
        if (!identity) {
          // identité supprimée entre-temps : le job n'a plus de raison d'être
          await db.externalSyncJob.update({
            where: { id: job.id },
            data: { status: "DONE", finishedAt: new Date(), lastError: "Identité supprimée — job sans objet" },
          });
          done += 1;
          continue;
        }
        const result = await syncIdentity(identity, provider);
        if (result.status === "OK") {
          await db.externalSyncJob.update({
            where: { id: job.id },
            data: { status: "DONE", finishedAt: new Date(), lastError: null },
          });
          done += 1;
        } else {
          // syncIdentity a déjà enregistré le diagnostic sur l'identité
          await db.externalSyncJob.update({
            where: { id: job.id },
            data: {
              status: "FAILED",
              finishedAt: new Date(),
              lastError: result.error ?? "Échec de synchronisation",
            },
          });
          failed += 1;
        }
      } else {
        throw new Error(`Opération inconnue : ${job.operation}`);
      }
    } catch (e) {
      const attempts = job.attempts + 1;
      const message = e instanceof Error ? e.message : "Erreur worker";
      await db.externalSyncJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          lastError: attempts >= MAX_ATTEMPTS ? `${message} (max tentatives atteint)` : message,
        },
      });
      failed += 1;
    }
  }

  return { processed: pending.length, done, failed, retried: reclaimed.count };
}
