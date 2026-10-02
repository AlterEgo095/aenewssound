import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { calculatePeriod, createPayouts, transitionPayout } from "@/lib/royalties";
import { signStreamUrl } from "@/lib/signed-url";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const periods = await db.royaltyPeriod.findMany({
      orderBy: { periodStart: "desc" },
      take: 12,
      include: {
        lines: { include: { artist: true, track: true } },
        payouts: { include: { method: true, payee: true } },
        statements: true,
      },
    });
    return ok({
      periods: periods.map((p) => ({
        id: p.id,
        periodStart: p.periodStart.toISOString(),
        periodEnd: p.periodEnd.toISOString(),
        status: p.status,
        closedAt: p.closedAt?.toISOString() ?? null,
        lines: p.lines.map((l) => ({
          id: l.id,
          type: l.type,
          artist: { id: l.artist.id, name: l.artist.name },
          track: { id: l.track.id, title: l.track.title },
          validatedListeningCount: l.validatedListeningCount,
          grossAmountMinor: Number(l.grossAmountMinor),
          shareBps: l.shareBps,
          netAmountMinor: Number(l.netAmountMinor),
          currency: l.currency,
        })),
        payouts: p.payouts.map((pay) => ({
          id: pay.id,
          artist: pay.artistId,
          payee: { id: pay.payee.id, displayName: pay.payee.displayName },
          method: pay.method ? `${pay.method.mmProvider ?? pay.method.type} ${pay.method.phoneNumber}` : null,
          amountMinor: Number(pay.amountMinor),
          currency: pay.currency,
          status: pay.status,
          providerRef: pay.providerRef,
        })),
        statementCount: p.statements.length,
      })),
    });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const body = await parseBody<{
      action?: string;
      periodId?: string;
      payoutId?: string;
      transition?: string;
      reason?: string;
      periodStart?: string;
      periodEnd?: string;
    }>(req);
    const action = requireString(body.action, "action", 40);

    if (action === "CALCULATE") {
      const result = await calculatePeriod(requireString(body.periodId, "periodId"), user.id);
      return ok(result);
    }
    if (action === "CREATE_PAYOUTS") {
      const result = await createPayouts(requireString(body.periodId, "periodId"), user.id);
      return ok(result);
    }
    if (action === "CREATE_PERIOD") {
      // Opérationnel : ouverture de la période suivante sans toucher à la DB.
      const start = new Date(requireString(body.periodStart ?? "", "periodStart"));
      const end = new Date(requireString(body.periodEnd ?? "", "periodEnd"));
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
        throw new ApiError(400, "Dates de période invalides (ISO attendu)");
      }
      if (end.getTime() <= start.getTime()) {
        throw new ApiError(400, "periodEnd doit être postérieure à periodStart");
      }
      const overlap = await db.royaltyPeriod.findFirst({
        where: { periodStart: { lt: end }, periodEnd: { gt: start } },
        select: { id: true },
      });
      if (overlap) {
        throw new ApiError(409, "Chevauchement avec une période existante");
      }
      const created = await db.royaltyPeriod.create({
        data: { periodStart: start, periodEnd: end, status: "OPEN" },
      });
      await audit({
        actorId: user.id,
        action: "royalty.period.create",
        entityType: "RoyaltyPeriod",
        entityId: created.id,
        after: { periodStart: start.toISOString(), periodEnd: end.toISOString() },
      });
      return ok({ id: created.id, status: created.status });
    }
    if (action === "PAYOUT_TRANSITION") {
      const transition = body.transition;
      if (!transition || !["APPROVE", "SEND", "CONFIRM", "FAIL", "RETRY"].includes(transition)) {
        throw new ApiError(400, "transition invalide (APPROVE|SEND|CONFIRM|FAIL|RETRY)");
      }
      const payout = await transitionPayout(
        requireString(body.payoutId, "payoutId"),
        transition as "APPROVE" | "SEND" | "CONFIRM" | "FAIL" | "RETRY",
        user.id,
        body.reason
      );
      if (!payout) throw new ApiError(500, "Payout introuvable après transition");
      return ok({ payoutId: payout.id, status: payout.status });
    }
    if (action === "STATEMENT_URL") {
      // Le statement est retrouvé par le payout : (periodId, payeeUserId du
      // payout) — plus de filtre incohérent payeeUserId=payoutId.
      const payout = await db.payout.findUnique({
        where: { id: requireString(body.payoutId, "payoutId") },
        select: { periodId: true, payeeUserId: true },
      });
      if (!payout) throw new ApiError(404, "Payout introuvable");
      const statement = await db.statement.findUnique({
        where: { periodId_payeeUserId: { periodId: payout.periodId, payeeUserId: payout.payeeUserId } },
      });
      if (!statement) throw new ApiError(404, "Aucun relevé pour ce payout");
      return ok({ statementUrl: signStreamUrl(statement.fileKey, 3600), fileKey: statement.fileKey });
    }
    throw new ApiError(400, "action inconnue (CREATE_PERIOD|CALCULATE|CREATE_PAYOUTS|PAYOUT_TRANSITION|STATEMENT_URL)");
  });
}
