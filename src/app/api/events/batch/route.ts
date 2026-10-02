import crypto from "crypto";
import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { tryValidateListening } from "@/lib/fraud";
import { EVENTS_BATCH_MAX } from "@/lib/config";

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
export async function POST(req: Request) {
  return handle(async () => {
    const { user, payload } = await requireAuth(req);
    const body = await parseBody<{ events?: IncomingEvent[]; clientBatchId?: string }>(req);
    const events = body.events ?? [];
    if (events.length === 0) throw new ApiError(400, "Batch vide");
    if (events.length > EVENTS_BATCH_MAX) {
      throw new ApiError(413, `Batch limité à ${EVENTS_BATCH_MAX} événements`);
    }

    // Vérifie la propriété des sessions en une requête.
    const sessionIds = [...new Set(events.map((e) => e.sessionId).filter((s): s is string => !!s))];
    const ownedSessions = sessionIds.length
      ? await db.playbackSession.findMany({
          where: { id: { in: sessionIds }, userId: user.id },
          select: { id: true, deviceId: true, context: true },
        })
      : [];
    const sessionById = new Map(ownedSessions.map((s) => [s.id, s]));

    let accepted = 0;
    let validated = 0;
    let fraud = 0;
    const validationErrors: unknown[] = [];

    for (const event of events) {
      const kind = ALLOWED_KINDS.includes(event.kind ?? "") ? event.kind! : null;
      if (!kind) continue;
      const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
      const session = event.sessionId ? sessionById.get(event.sessionId) : undefined;
      const positionSeconds =
        typeof event.positionSeconds === "number" && Number.isFinite(event.positionSeconds)
          ? Math.max(0, Math.round(event.positionSeconds))
          : null;

      await db.playbackEvent.create({
        data: {
          id: crypto.randomUUID(),
          kind,
          occurredAt,
          sessionId: session?.id ?? null,
          userId: user.id,
          trackId: event.trackId ?? null,
          deviceId: session?.deviceId ?? payload.deviceId,
          positionSeconds,
          durationSeconds:
            typeof event.durationSeconds === "number" ? Math.round(event.durationSeconds) : null,
          bufferedMs:
            typeof event.bufferedMs === "number" ? Math.round(event.bufferedMs) : null,
          bitrateKbps:
            typeof event.bitrateKbps === "number" ? Math.round(event.bitrateKbps) : null,
          variant: event.variant ?? null,
          networkType: event.networkType ?? null,
          devicePlatform: req.headers.get("x-platform") ?? "WEB",
          isOffline: event.isOffline ?? false,
          clientBatchId: body.clientBatchId ?? null,
        },
      });
      accepted += 1;

      // Historique UX : une ligne par lecture démarrée.
      if (kind === "PLAY_START" && event.trackId) {
        await db.listeningHistory.create({
          data: {
            userId: user.id,
            trackId: event.trackId,
            context: session?.context ?? null,
            deviceId: session?.deviceId ?? payload.deviceId,
          },
        });
      }

      // Règle 2 : franchissement du seuil => passage antifraude => ValidatedListening.
      if (
        (kind === "PLAY_PROGRESS" || kind === "PLAY_END" || kind === "COMPLETE") &&
        positionSeconds !== null &&
        event.trackId &&
        session
      ) {
        try {
          const outcome = await tryValidateListening({
            sessionId: session.id,
            userId: user.id,
            trackId: event.trackId,
            deviceId: session.deviceId,
            positionSeconds,
            occurredAt,
            context: session.context,
          });
          if (outcome.validated) validated += 1;
          if (!outcome.validated && outcome.reason === "fraud") fraud += 1;
        } catch (e) {
          validationErrors.push(e);
        }
      }
    }

    return ok({
      accepted,
      validatedListenings: validated,
      fraudBlocked: fraud,
      clientBatchId: body.clientBatchId ?? null,
    });
  });
}
