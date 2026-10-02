import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { ROYALTY_RATE_MINOR_PER_STREAM } from "@/lib/config";
import { putJsonObject } from "@/lib/storage";

// Royalties — ledger append-only (v1.1 §10/§17/§27).
// Les RoyaltyLines sont alimentées UNIQUEMENT par les ValidatedListening
// post-filtrage fraude. Toute correction = REVERSAL + nouvelle ENTRY.
//
// Robustesse (audit v1.1) :
// - CALCULATE et CREATE_PAYOUTS posent leur verrou de façon ATOMIQUE
//   (updateMany conditionnel + count) : deux exécutions concurrentes ne
//   peuvent plus dupliquer des lignes ni des payouts.
// - La répartition des splits redistribue le résidu de division entière
//   (méthode du plus fort reste) : Σ netAmountMinor === grossAmountMinor.
// - Un payout FAILED peut être RETRY (FAILED → PENDING) : plus d'argent bloqué.
// - Les payouts/statements sont agrégés par BÉNÉFICIAIRE (payeeUserId) :
//   un membre de plusieurs artistes reçoit UN payout + UN statement.

export async function calculatePeriod(periodId: string, actorId: string) {
  const period = await db.royaltyPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(404, "Période introuvable");
  if (period.status !== "OPEN") {
    throw new ApiError(409, `Période déjà traitée (${period.status}) — passer par un REVERSAL`);
  }

  // Verrou ATOMIQUE : seul le premier CALCULATE passe OPEN → CALCULATING.
  // Les concurrents (double-clic, double admin) reçoivent 409 au lieu de
  // créer un second jeu de lignes (corruption du ledger).
  const claimed = await db.royaltyPeriod.updateMany({
    where: { id: periodId, status: "OPEN" },
    data: { status: "CALCULATING" },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, "Calcul déjà en cours pour cette période");
  }

  const listenings = await db.validatedListening.findMany({
    where: { listenedAt: { gte: period.periodStart, lt: period.periodEnd } },
    select: { trackId: true },
  });

  const countsByTrack = new Map<string, number>();
  for (const listening of listenings) {
    countsByTrack.set(listening.trackId, (countsByTrack.get(listening.trackId) ?? 0) + 1);
  }

  let linesCreated = 0;
  for (const [trackId, count] of countsByTrack) {
    const track = await db.track.findUnique({
      where: { id: trackId },
      include: {
        rights: { where: { kind: "OWNERSHIP", status: "ACTIVE" }, take: 1 },
        credits: { include: { artist: true } },
      },
    });
    if (!track || track.rights.length === 0) continue; // pas de droit actif => pas de ligne

    const holderArtistId = track.rights[0].holderArtistId;
    const grossMinor = BigInt(count) * BigInt(Math.round(ROYALTY_RATE_MINOR_PER_STREAM));

    // Split : ArtistMember.shareBps si la somme vaut 10000, sinon holder 100 %.
    const members = await db.artistMember.findMany({
      where: { artistId: holderArtistId, leftAt: null, shareBps: { gt: 0 } },
    });
    const membersSum = members.reduce((acc, m) => acc + m.shareBps, 0);
    const splits =
      membersSum === 10000
        ? members.map((m) => ({ artistId: m.artistId, shareBps: m.shareBps }))
        : [{ artistId: holderArtistId, shareBps: 10000 }];

    // Répartition SANS PERTE DE CENTIME (méthode du plus fort reste) :
    // plancher par split, puis le résidu (< nombre de splits) est distribué
    // aux splits au reste le plus élevé. Σ net === gross, toujours.
    const floors = splits.map((s) => ({
      ...s,
      floor: (grossMinor * BigInt(s.shareBps)) / BigInt(10000),
      remainder: (grossMinor * BigInt(s.shareBps)) % BigInt(10000),
    }));
    const distributed = floors.reduce((acc, f) => acc + f.floor, BigInt(0));
    let residual = grossMinor - distributed;
    const byLargestRemainder = [...floors].sort((a, b) =>
      b.remainder === a.remainder
        ? b.shareBps - a.shareBps
        : b.remainder > a.remainder
          ? 1
          : -1
    );
    for (const part of byLargestRemainder) {
      if (residual <= BigInt(0)) break;
      part.floor += BigInt(1);
      residual -= BigInt(1);
    }
    const allocated = floors.reduce((acc, f) => acc + f.floor, BigInt(0));
    if (allocated !== grossMinor) {
      // Invariant de réconciliation : jamais de centime créé ni perdu.
      throw new ApiError(500, `Réconciliation du split impossible pour le titre ${trackId}`);
    }

    for (const part of floors) {
      await db.royaltyLine.create({
        data: {
          periodId,
          type: "ENTRY",
          trackId,
          artistId: part.artistId,
          validatedListeningCount: count,
          grossAmountMinor: grossMinor,
          shareBps: part.shareBps,
          netAmountMinor: part.floor,
          currency: "CDF",
          sourceDigest: JSON.stringify({
            rateMinorPerStream: ROYALTY_RATE_MINOR_PER_STREAM,
            validatedListenings: count,
            window: { start: period.periodStart.toISOString(), end: period.periodEnd.toISOString() },
            splitOrigin: membersSum === 10000 ? "artist_members" : "rights_holder",
          }),
        },
      });
      linesCreated += 1;
    }
  }

  const closed = await db.royaltyPeriod.update({
    where: { id: periodId },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  await audit({
    actorId,
    action: "royalty.calculate",
    entityType: "RoyaltyPeriod",
    entityId: periodId,
    after: { validatedListenings: listenings.length, linesCreated },
  });

  return { period: closed, linesCreated, validatedListenings: listenings.length };
}

export async function createPayouts(periodId: string, actorId: string) {
  const period = await db.royaltyPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(404, "Période introuvable");
  if (period.status !== "CLOSED" && period.status !== "PARTIALLY_PAID") {
    throw new ApiError(409, "La période doit être CLOSED pour générer les payouts");
  }

  // Verrou ATOMIQUE avant la boucle de création : deux exécutions concurrentes
  // ne peuvent plus créer deux séries de payouts + statements.
  const previousStatus = period.status;
  const claimed = await db.royaltyPeriod.updateMany({
    where: { id: periodId, status: { in: ["CLOSED", "PARTIALLY_PAID"] } },
    data: { status: "PAYOUT_IN_PROGRESS" },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, "Génération de payouts déjà en cours pour cette période");
  }

  try {
    const lines = await db.royaltyLine.findMany({ where: { periodId, type: "ENTRY" } });
    if (lines.length === 0) throw new ApiError(409, "Aucune ligne de royaltie à payer");
    const skipped: string[] = [];

    // Agrégation par ARTISTE puis par BÉNÉFICIAIRE : un même payeeUserId
    // (membre de plusieurs artistes) reçoit UN payout et UN statement
    // (@@unique(periodId, payeeUserId) respectée — plus de crash mid-boucle).
    const byArtist = new Map<string, { netMinor: bigint; lines: typeof lines }>();
    for (const line of lines) {
      const entry = byArtist.get(line.artistId) ?? { netMinor: BigInt(0), lines: [] };
      entry.netMinor += line.netAmountMinor;
      entry.lines.push(line);
      byArtist.set(line.artistId, entry);
    }

    const byPayee = new Map<
      string,
      { netMinor: bigint; lines: typeof lines; primaryArtistId: string }
    >();
    for (const [artistId, agg] of byArtist) {
      const member = await db.artistMember.findFirst({
        where: { artistId, userId: { not: null }, leftAt: null },
        orderBy: { joinedAt: "asc" },
      });
      const payeeUserId = member?.userId;
      if (!payeeUserId) {
        // Traçable : l'admin voit POURQUOI aucun payout n'a été généré.
        skipped.push(artistId);
        continue;
      }
      const entry = byPayee.get(payeeUserId) ?? {
        netMinor: BigInt(0),
        lines: [],
        primaryArtistId: artistId,
      };
      entry.netMinor += agg.netMinor;
      entry.lines.push(...agg.lines);
      byPayee.set(payeeUserId, entry);
    }

    // Payouts existants : un bénéficiaire déjà payé pour la période n'est
    // jamais re-payé (reprise après PARTIALLY_PAID sans doublon).
    const existingPayees = new Set(
      (await db.payout.findMany({ where: { periodId }, select: { payeeUserId: true } })).map(
        (p) => p.payeeUserId
      )
    );

    let created = 0;

    for (const [payeeUserId, agg] of byPayee) {
      if (agg.netMinor <= BigInt(0)) continue;
      if (existingPayees.has(payeeUserId)) continue;
      const method = await db.payoutMethod.findFirst({
        where: { userId: payeeUserId, isActive: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
      if (!method) {
        skipped.push(agg.primaryArtistId);
        continue;
      }

      const payout = await db.payout.create({
        data: {
          periodId,
          payeeUserId,
          artistId: agg.primaryArtistId,
          payoutMethodId: method.id,
          amountMinor: agg.netMinor,
          currency: "CDF",
          status: "PENDING",
        },
      });

      const statement = {
        periodId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        payeeUserId,
        payoutId: payout.id,
        currency: "CDF",
        totalDueMinor: agg.netMinor.toString(),
        rateMinorPerStream: ROYALTY_RATE_MINOR_PER_STREAM,
        lines: agg.lines.map((l) => ({
          artistId: l.artistId,
          trackId: l.trackId,
          validatedListeningCount: l.validatedListeningCount,
          grossAmountMinor: l.grossAmountMinor.toString(),
          shareBps: l.shareBps,
          netAmountMinor: l.netAmountMinor.toString(),
        })),
        generatedAt: new Date().toISOString(),
      };
      const file = putJsonObject(`statements/${periodId}/${payout.id}.json`, statement);

      await db.statement.create({
        data: {
          periodId,
          payeeUserId,
          fileKey: file.key,
          totalDueMinor: agg.netMinor,
          currency: "CDF",
        },
      });
      created += 1;
    }

    await db.royaltyPeriod.update({
      where: { id: periodId },
      data: {
        status: "PAYOUT_IN_PROGRESS",
        payoutDeadline: new Date(Date.now() + 15 * 24 * 3600 * 1000),
      },
    });

    await audit({
      actorId,
      action: "royalty.payouts.create",
      entityType: "RoyaltyPeriod",
      entityId: periodId,
      after: { payoutsCreated: created, skippedArtists: skipped },
    });

    return { created, skipped };
  } catch (e) {
    // Libère le verrou : la période retrouve son statut précédent pour permettre
    // une nouvelle tentative (sinon verrou mort après tout crash mid-boucle).
    await db.royaltyPeriod
      .updateMany({
        where: { id: periodId, status: "PAYOUT_IN_PROGRESS" },
        data: { status: previousStatus },
      })
      .catch(() => undefined);
    throw e;
  }
}

export async function transitionPayout(
  payoutId: string,
  action: "APPROVE" | "SEND" | "CONFIRM" | "FAIL" | "RETRY",
  actorId: string,
  reason?: string
) {
  const payout = await db.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new ApiError(404, "Payout introuvable");

  const transitions: Record<
    string,
    { next: string; at?: "sentAt" | "confirmedAt" | null; from: string[] }
  > = {
    APPROVE: { next: "APPROVED", at: null, from: ["PENDING"] },
    SEND: { next: "SENT", at: "sentAt", from: ["APPROVED"] },
    CONFIRM: { next: "CONFIRMED", at: "confirmedAt", from: ["SENT"] },
    FAIL: { next: "FAILED", at: null, from: ["PENDING", "APPROVED", "SENT"] },
    // RETRY : un payout FAILED repart en PENDING — l'argent n'est plus bloqué
    // à vie, la période peut retrouver PAID après correction de la cause.
    RETRY: { next: "PENDING", at: null, from: ["FAILED"] },
  };
  const transition = transitions[action];
  if (!transition) throw new ApiError(400, `Action inconnue : ${action}`);
  if (!transition.from.includes(payout.status)) {
    throw new ApiError(409, `Transition ${action} impossible depuis ${payout.status}`);
  }

  // Verrou optimiste : la transition n'aboutit que si le statut est encore
  // celui lu (deux admins simultanés ne peuvent pas doubler une transition).
  const updated = await db.payout.updateMany({
    where: { id: payoutId, status: { in: transition.from } },
    data: {
      status: transition.next,
      failureReason: action === "FAIL" ? reason ?? "Échec opérateur" : null,
      providerRef:
        action === "SEND"
          ? `MM-${payout.id.slice(-8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`
          : payout.providerRef,
      ...(transition.at ? { [transition.at]: new Date() } : {}),
    },
  });
  if (updated.count !== 1) {
    throw new ApiError(409, `Transition ${action} impossible depuis ${payout.status}`);
  }

  // Clôture de période quand tous les payouts sont terminés.
  const remaining = await db.payout.count({
    where: { periodId: payout.periodId, status: { in: ["PENDING", "APPROVED", "PROCESSING", "SENT"] } },
  });
  if (remaining === 0) {
    const failed = await db.payout.count({
      where: { periodId: payout.periodId, status: "FAILED" },
    });
    await db.royaltyPeriod.updateMany({
      where: { id: payout.periodId },
      data: { status: failed > 0 ? "PARTIALLY_PAID" : "PAID" },
    });
  }

  await audit({
    actorId,
    action: `payout.${action.toLowerCase()}`,
    entityType: "Payout",
    entityId: payoutId,
    before: { status: payout.status },
    after: { status: transition.next },
  });

  return db.payout.findUnique({ where: { id: payoutId } });
}
