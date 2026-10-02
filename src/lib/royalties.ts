import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";
import { ROYALTY_RATE_MINOR_PER_STREAM } from "@/lib/config";
import { putJsonObject } from "@/lib/storage";

// Royalties — ledger append-only (v1.1 §10/§17/§27).
// Les RoyaltyLines sont alimentées UNIQUEMENT par les ValidatedListening
// post-filtrage fraude. Toute correction = REVERSAL + nouvelle ENTRY.

export async function calculatePeriod(periodId: string, actorId: string) {
  const period = await db.royaltyPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new ApiError(404, "Période introuvable");
  if (period.status !== "OPEN") {
    throw new ApiError(409, `Période déjà traitée (${period.status}) — passer par un REVERSAL`);
  }
  const existingLines = await db.royaltyLine.count({ where: { periodId, type: "ENTRY" } });
  if (existingLines > 0) throw new ApiError(409, "Des lignes existent déjà pour cette période");

  await db.royaltyPeriod.update({ where: { id: periodId }, data: { status: "CALCULATING" } });

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

    for (const split of splits) {
      const netMinor = (grossMinor * BigInt(split.shareBps)) / BigInt(10000);
      await db.royaltyLine.create({
        data: {
          periodId,
          type: "ENTRY",
          trackId,
          artistId: split.artistId,
          validatedListeningCount: count,
          grossAmountMinor: grossMinor,
          shareBps: split.shareBps,
          netAmountMinor: netMinor,
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
    throw new ApiError(409, "La période doit être CLOSE pour générer les payouts");
  }
  const existingPayouts = await db.payout.count({ where: { periodId } });
  if (existingPayouts > 0) throw new ApiError(409, "Des payouts existent déjà pour cette période");

  const lines = await db.royaltyLine.findMany({ where: { periodId, type: "ENTRY" } });
  if (lines.length === 0) throw new ApiError(409, "Aucune ligne de royaltie à payer");

  const byArtist = new Map<string, { netMinor: bigint; trackIds: Set<string> }>();
  for (const line of lines) {
    const entry = byArtist.get(line.artistId) ?? { netMinor: BigInt(0), trackIds: new Set<string>() };
    entry.netMinor += line.netAmountMinor;
    entry.trackIds.add(line.trackId);
    byArtist.set(line.artistId, entry);
  }

  let created = 0;
  let skipped: string[] = [];

  for (const [artistId, agg] of byArtist) {
    if (agg.netMinor <= BigInt(0)) continue;
    const member = await db.artistMember.findFirst({
      where: { artistId, userId: { not: null }, leftAt: null },
      orderBy: { joinedAt: "asc" },
    });
    const payeeUserId = member?.userId;
    if (!payeeUserId) {
      skipped.push(artistId);
      continue;
    }
    const method = await db.payoutMethod.findFirst({
      where: { userId: payeeUserId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    if (!method) {
      skipped.push(artistId);
      continue;
    }

    const payout = await db.payout.create({
      data: {
        periodId,
        payeeUserId,
        artistId,
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
      artistId,
      payeeUserId,
      payoutId: payout.id,
      currency: "CDF",
      totalDueMinor: agg.netMinor.toString(),
      rateMinorPerStream: ROYALTY_RATE_MINOR_PER_STREAM,
      lines: lines
        .filter((l) => l.artistId === artistId)
        .map((l) => ({
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
    data: { status: "PAYOUT_IN_PROGRESS", payoutDeadline: new Date(Date.now() + 15 * 24 * 3600 * 1000) },
  });

  await audit({
    actorId,
    action: "royalty.payouts.create",
    entityType: "RoyaltyPeriod",
    entityId: periodId,
    after: { payoutsCreated: created, skippedArtists: skipped },
  });

  return { created, skipped };
}

export async function transitionPayout(
  payoutId: string,
  action: "APPROVE" | "SEND" | "CONFIRM" | "FAIL",
  actorId: string,
  reason?: string
) {
  const payout = await db.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new ApiError(404, "Payout introuvable");

  const transitions: Record<string, { next: string; at?: "sentAt" | "confirmedAt" | null; from: string[] }> = {
    APPROVE: { next: "APPROVED", at: null, from: ["PENDING"] },
    SEND: { next: "SENT", at: "sentAt", from: ["APPROVED"] },
    CONFIRM: { next: "CONFIRMED", at: "confirmedAt", from: ["SENT"] },
    FAIL: { next: "FAILED", at: null, from: ["PENDING", "APPROVED", "SENT"] },
  };
  const transition = transitions[action];
  if (!transition.from.includes(payout.status)) {
    throw new ApiError(409, `Transition ${action} impossible depuis ${payout.status}`);
  }

  const updated = await db.payout.update({
    where: { id: payoutId },
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

  // Clôture de période quand tous les payouts sont terminés.
  const remaining = await db.payout.count({
    where: { periodId: payout.periodId, status: { in: ["PENDING", "APPROVED", "PROCESSING", "SENT"] } },
  });
  if (remaining === 0) {
    const failed = await db.payout.count({
      where: { periodId: payout.periodId, status: "FAILED" },
    });
    await db.royaltyPeriod.update({
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

  return updated;
}
