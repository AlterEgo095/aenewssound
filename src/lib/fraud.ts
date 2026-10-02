import { db } from "@/lib/db";
import {
  FRAUD_VELOCITY_SESSIONS,
  FRAUD_VELOCITY_WINDOW_MS,
  VALIDATION_THRESHOLD_SECONDS,
} from "@/lib/config";
import type { Prisma } from "@prisma/client";

// Règle 2 (v1.1) : une écoute n'entre dans les royalties qu'après
// filtrage antifraude ET franchissement du seuil de 30 secondes.
// Chaîne : PlaybackEvent (batch) → Fraud Engine → ValidatedListening.
//
// Durcissement (audit v1.1) :
// - IMPOSSIBLE_PLAYBACK couvre TOUTES les sessions chevauchantes du même
//   utilisateur (la spec dit « même user », pas « autre device » — deux
//   sessions parallèles sur un même device sont tout aussi impossibles).
// - Plausibilité temporelle serveur : impossible de valider 30 s d'écoute en
//   moins de 30 s d'horloge murale (anti « validation instantanée »).
// - Le catch de course ne classe `duplicate` que sur la contrainte P2002
//   (une panne DB ne doit jamais passer pour un doublon).

export type ValidationOutcome =
  | { validated: true; dedupeKey: string }
  | { validated: false; reason: "below_threshold" | "duplicate" }
  | { validated: false; reason: "fraud"; rule: string; flagId: string };

// Tolérance : un seek réseau/tampon peut décaler l'horloge perçue de quelques
// secondes — au-delà, l'écoute est physiquement impossible.
const WALL_CLOCK_TOLERANCE_SECONDS = 5;

export async function tryValidateListening(opts: {
  sessionId: string;
  userId: string;
  trackId: string;
  deviceId: string;
  positionSeconds: number;
  occurredAt?: Date;
  sessionStartedAt?: Date;
  context?: string | null;
  country?: string | null;
}): Promise<ValidationOutcome> {
  const occurredAt = opts.occurredAt ?? new Date();

  if (opts.positionSeconds < VALIDATION_THRESHOLD_SECONDS) {
    return { validated: false, reason: "below_threshold" };
  }

  // Plausibilité horloge murale : positionSeconds ≤ temps réel écoulé depuis
  // le démarrage de la session (+ tolérance). Sans ce garde, un client peut
  // envoyer positionSeconds=30 immédiatement après PLAY_START.
  if (opts.sessionStartedAt) {
    const elapsedSeconds = (occurredAt.getTime() - opts.sessionStartedAt.getTime()) / 1000;
    if (elapsedSeconds < VALIDATION_THRESHOLD_SECONDS - WALL_CLOCK_TOLERANCE_SECONDS) {
      return { validated: false, reason: "below_threshold" };
    }
  }

  const dedupeKey = `${opts.sessionId}:${opts.trackId}`;
  const existing = await db.validatedListening.findUnique({ where: { dedupeKey } });
  if (existing) return { validated: false, reason: "duplicate" };

  // Règle IMPOSSIBLE_PLAYBACK : TOUTE autre session OUVERTE du même utilisateur
  // (quel que soit le device), démarrée avant le dernier seuil — lecture
  // physiquement impossible en parallèle.
  const overlapWindowStart = new Date(occurredAt.getTime() - 2 * 3600 * 1000);
  const overlapping = await db.playbackSession.findFirst({
    where: {
      userId: opts.userId,
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
          currentDeviceId: opts.deviceId,
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
    // Course entre deux batchs simultanés : seule la violation de la contrainte
    // unique (P2002) classe `duplicate` — une panne DB reste une panne.
    .catch((e: unknown) => {
      const code = (e as { code?: string })?.code;
      return code === "P2002" ? null : Promise.reject(e);
    });

  if (!listening) return { validated: false, reason: "duplicate" };

  // playCount = écoutes VALIDÉES uniquement (définition v1.1 §10).
  await db.track.update({
    where: { id: opts.trackId },
    data: { playCount: { increment: 1 } },
  });

  return { validated: true, dedupeKey };
}

// Type réexporté pour les routes consommatrices (client transactionnel).
export type FraudTx = Prisma.TransactionClient;
