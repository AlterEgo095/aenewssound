import crypto from "crypto";
import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, rateLimit } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { tryValidateListening } from "@/lib/fraud";
import { EVENTS_BATCH_MAX, EVENT_CLOCK_SKEW_MS } from "@/lib/config";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

type IncomingEvent = {
  kind?: string;
  trackId?: string;
  sessionId?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  bufferedMs?: number;
  bitrateKbps?: number;
  variant?: string;
  occurredAt?: string;
  networkType?: string;
  isOffline?: boolean;
};

const ALLOWED_KINDS = [
  "PLAY_START",
  "PLAY_PROGRESS",
  "PLAY_END",
  "BUFFER_STALL",
  "SEEK",
  "QUALITY_CHANGE",
  "SKIP",
  "COMPLETE",
];

// POST /api/events/batch — ingestion batchée (v1.1 §16 : jamais un HTTP/seconde).
// Le batch déclenche le Fraud Engine → ValidatedListening (règle 2).
//
// Durcissement (audit v1.1) :
// - L'horodatage CLIENT n'est accepté qu'à ± EVENT_CLOCK_SKEW_MS de l'horloge
//   serveur ; au-delà, il est REMPLACÉ par l'horloge serveur. La période de
//   royaltie et les fenêtres antifraude ne dépendent donc plus du client.
// - Les inserts du store d'événements + historique sont ATOMIQUES ($transaction
//   + createMany) : plus d'écritures partielles sur payload invalide.
// - Le trackId est validé (PUBLISHED, non supprimé) avant historique/validation.
// - Idempotence par clientBatchId : un rejeu réseau ne duplique plus le batch.
// - Les validationErrors sont RETOURNÉS au client (plus d'échec silencieux).
export async function POST(req: Request) {
  return handle(async () => {
    const { user, payload } = await requireAuth(req);
    // Anti-abus : la validation instantanée en rafale coûterait des royalties.
    rateLimit(`events-batch:${user.id}`, 30, 60_000);
    const body = await parseBody<{ events?: IncomingEvent[]; clientBatchId?: string }>(req);
    const events = body.events ?? [];
    if (events.length === 0) throw new ApiError(400, "Batch vide");
    if (events.length > EVENTS_BATCH_MAX) {
      throw new ApiError(413, `Batch limité à ${EVENTS_BATCH_MAX} événements`);
    }

    // Idempotence : un clientBatchId déjà ingéré rejoue la réponse sans écrire.
    if (body.clientBatchId) {
      const already = await db.playbackEvent.count({
        where: { clientBatchId: body.clientBatchId, userId: user.id },
      });
      if (already > 0) {
        return ok({
          accepted: 0,
          validatedListenings: 0,
          fraudBlocked: 0,
          duplicateBatch: true,
          clientBatchId: body.clientBatchId,
        });
      }
    }

    // Vérifie la propriété des sessions en une requête (+ startedAt/endedAt
    // pour la plausibilité temporelle et l'anti re-flag sur session close).
    const sessionIds = [...new Set(events.map((e) => e.sessionId).filter((s): s is string => !!s))];
    const ownedSessions = sessionIds.length
      ? await db.playbackSession.findMany({
          where: { id: { in: sessionIds }, userId: user.id },
          select: { id: true, deviceId: true, context: true, startedAt: true, endedAt: true },
        })
      : [];
    const sessionById = new Map(ownedSessions.map((s) => [s.id, s]));

    // Horodatage : la valeur client n'est retenue que si elle est plausible
    // (± EVENT_CLOCK_SKEW_MS de l'horloge serveur) — sinon horloge serveur.
    const serverNow = Date.now();
    const clampOccurredAt = (raw?: string): Date => {
      if (!raw) return new Date(serverNow);
      const t = Date.parse(raw);
      if (!Number.isFinite(t)) return new Date(serverNow);
      if (Math.abs(t - serverNow) > EVENT_CLOCK_SKEW_MS) return new Date(serverNow);
      return new Date(t);
    };

    // Tracks valides (PUBLISHED, non supprimés) — une requête pour tout le batch.
    const trackIds = [...new Set(events.map((e) => e.trackId).filter((t): t is string => !!t))];
    const validTracks = trackIds.length
      ? new Set(
          (
            await db.track.findMany({
              where: { id: { in: trackIds }, status: "PUBLISHED", deletedAt: null },
              select: { id: true },
            })
          ).map((t) => t.id)
        )
      : new Set<string>();

    // PHASE 1 — Store d'événements + historique, ATOMIQUES (createMany).
    const rows: Prisma.PlaybackEventCreateManyInput[] = [];
    const historyRows: Prisma.ListeningHistoryCreateManyInput[] = [];

    for (const event of events) {
      const kind = ALLOWED_KINDS.includes(event.kind ?? "") ? event.kind! : null;
      if (!kind) continue;
      const occurredAt = clampOccurredAt(event.occurredAt);
      const session = event.sessionId ? sessionById.get(event.sessionId) : undefined;
      const positionSeconds =
        typeof event.positionSeconds === "number" && Number.isFinite(event.positionSeconds)
          ? Math.max(0, Math.round(event.positionSeconds))
          : null;
      const trackId = event.trackId && validTracks.has(event.trackId) ? event.trackId : null;

      rows.push({
        id: crypto.randomUUID(),
        kind,
        occurredAt,
        sessionId: session?.id ?? null,
        userId: user.id,
        trackId,
        deviceId: session?.deviceId ?? payload.deviceId,
        positionSeconds,
        durationSeconds:
          typeof event.durationSeconds === "number" ? Math.round(event.durationSeconds) : null,
        bufferedMs: typeof event.bufferedMs === "number" ? Math.round(event.bufferedMs) : null,
        bitrateKbps:
          typeof event.bitrateKbps === "number" ? Math.round(event.bitrateKbps) : null,
        variant: event.variant ?? null,
        networkType: event.networkType ?? null,
        devicePlatform: req.headers.get("x-platform") ?? "WEB",
        isOffline: event.isOffline ?? false,
        clientBatchId: body.clientBatchId ?? null,
      });

      // Historique UX : une ligne par lecture démarrée (titre valide uniquement).
      if (kind === "PLAY_START" && trackId) {
        historyRows.push({
          userId: user.id,
          trackId,
          context: session?.context ?? null,
          deviceId: session?.deviceId ?? payload.deviceId,
        });
      }
    }

    await db.$transaction(async (tx) => {
      if (rows.length > 0) await tx.playbackEvent.createMany({ data: rows });
      if (historyRows.length > 0) await tx.listeningHistory.createMany({ data: historyRows });
    });

    const accepted = rows.length;

    // PHASE 2 — Règle 2 : franchissement du seuil => antifraude => écoute
    // validée. Hors transaction : la dédup est garantie par la contrainte
    // unique dedupeKey (course entre batchs impossible à doubler).
    let validated = 0;
    let fraud = 0;
    const validationErrors: string[] = [];

    for (const event of events) {
      const kind = ALLOWED_KINDS.includes(event.kind ?? "") ? event.kind! : null;
      if (!kind) continue;
      if (kind !== "PLAY_PROGRESS" && kind !== "PLAY_END" && kind !== "COMPLETE") continue;
      const session = event.sessionId ? sessionById.get(event.sessionId) : undefined;
      if (!session) continue;
      // Une session déjà close ne re-valide rien (anti re-flag en série).
      if (session.endedAt) continue;
      const positionSeconds =
        typeof event.positionSeconds === "number" && Number.isFinite(event.positionSeconds)
          ? Math.max(0, Math.round(event.positionSeconds))
          : null;
      if (positionSeconds === null || !event.trackId || !validTracks.has(event.trackId)) continue;

      try {
        const outcome = await tryValidateListening({
          sessionId: session.id,
          userId: user.id,
          trackId: event.trackId,
          deviceId: session.deviceId,
          positionSeconds,
          occurredAt: clampOccurredAt(event.occurredAt),
          sessionStartedAt: session.startedAt,
          context: session.context,
        });
        if (outcome.validated) validated += 1;
        if (!outcome.validated && outcome.reason === "fraud") fraud += 1;
      } catch (e) {
        validationErrors.push(e instanceof Error ? e.message : "erreur de validation");
      }
    }

    return ok({
      accepted,
      validatedListenings: validated,
      fraudBlocked: fraud,
      validationErrors,
      clientBatchId: body.clientBatchId ?? null,
    });
  });
}
