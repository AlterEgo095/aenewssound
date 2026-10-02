import { db } from "@/lib/db";
import {
  FRAUD_VELOCITY_SESSIONS,
  FRAUD_VELOCITY_WINDOW_MS,
  VALIDATION_THRESHOLD_SECONDS,
} from "@/lib/config";

// Règle 2 (v1.1) : une écoute n'entre dans les royalties qu'après
// filtrage antifraude ET franchissement du seuil de 30 secondes.
// Chaîne : PlaybackEvent (batch) → Fraud Engine → ValidatedListening.

export type ValidationOutcome =
  | { validated: true; dedupeKey: string }
  | { validated: false; reason: "below_threshold" | "duplicate" }
  | { validated: false; reason: "fraud"; rule: string; flagId: string };

export async function tryValidateListening(opts: {
  sessionId: string;
  userId: string;
  trackId: string;
  deviceId: string;
  positionSeconds: number;
  occurredAt?: Date;
  context?: string | null;
  country?: string | null;
}): Promise<ValidationOutcome> {
  const occurredAt = opts.occurredAt ?? new Date();

  if (opts.positionSeconds < VALIDATION_THRESHOLD_SECONDS) {
    return { validated: false, reason: "below_threshold" };
  }

  const dedupeKey = `${opts.sessionId}:${opts.trackId}`;
  const existing = await db.validatedListening.findUnique({ where: { dedupeKey } });
  if (existing) return { validated: false, reason: "duplicate" };

  // Règle IMPOSSIBLE_PLAYBACK : une autre session OUVERTE du même utilisateur
  // sur un autre device, démarrée avant le dernier seuil — lecture physiquement
  // impossible sur deux appareils en même temps.
  const overlapWindowStart = new Date(occurredAt.getTime() - 2 * 3600 * 1000);
  const overlapping = await db.playbackSession.findFirst({
    where: {
      userId: opts.userId,
      deviceId: { not: opts.deviceId },
      id: { not: opts.sessionId },
      endedAt: null,
      startedAt: { gte: overlapWindowStart, lte: occurredAt },
    },
  });

  if (overlapping) {
    const flag = await db.fraudFlag.create({
      data: {
        subjectType: "SESSION",
        subjectId: opts.sessionId,
        rule: "IMPOSSIBLE_PLAYBACK",
        severity: "HIGH",
        score: 85,
        evidence: JSON.stringify({
          overlappingSessionId: overlapping.id,
          overlappingDeviceId: overlapping.deviceId,
          checkedAt: occurredAt.toISOString(),
        }),
        status: "AUTO_CONFIRMED",
        relatedUserId: opts.userId,
        relatedSessionId: opts.sessionId,
      },
    });
    await db.playbackSession.update({
      where: { id: opts.sessionId },
      data: { endedAt: occurredAt },
    });
    return { validated: false, reason: "fraud", rule: "IMPOSSIBLE_PLAYBACK", flagId: flag.id };
  }

  // Règle VELOCITY_ANOMALY : volume de sessions anormal sur 10 minutes.
  const velocityCount = await db.playbackSession.count({
    where: {
      userId: opts.userId,
      startedAt: { gte: new Date(occurredAt.getTime() - FRAUD_VELOCITY_WINDOW_MS) },
    },
  });
  if (velocityCount > FRAUD_VELOCITY_SESSIONS) {
    const flag = await db.fraudFlag.create({
      data: {
        subjectType: "USER",
        subjectId: opts.userId,
        rule: "VELOCITY_ANOMALY",
        severity: "MEDIUM",
        score: 65,
        evidence: JSON.stringify({
          sessionsInWindow: velocityCount,
          windowMs: FRAUD_VELOCITY_WINDOW_MS,
        }),
        status: "OPEN",
        relatedUserId: opts.userId,
        relatedSessionId: opts.sessionId,
      },
    });
    return { validated: false, reason: "fraud", rule: "VELOCITY_ANOMALY", flagId: flag.id };
  }

  const listening = await db.validatedListening
    .create({
      data: {
        dedupeKey,
        trackId: opts.trackId,
        userId: opts.userId,
        sessionId: opts.sessionId,
        deviceId: opts.deviceId,
        playedSeconds: Math.round(opts.positionSeconds),
        thresholdSeconds: VALIDATION_THRESHOLD_SECONDS,
        listenedAt: occurredAt,
        context: opts.context ?? null,
        country: opts.country ?? null,
      },
    })
    // Course entre deux batchs simultanés : la clé unique protège le ledger.
    .catch(() => null);

  if (!listening) return { validated: false, reason: "duplicate" };

  // playCount = écoutes VALIDÉES uniquement (définition v1.1 §10).
  await db.track.update({
    where: { id: opts.trackId },
    data: { playCount: { increment: 1 } },
  });

  return { validated: true, dedupeKey };
}
