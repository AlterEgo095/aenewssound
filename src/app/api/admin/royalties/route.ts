import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { calculatePeriod, createPayouts, transitionPayout } from "@/lib/royalties";
import { signStreamUrl } from "@/lib/signed-url";

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
    if (action === "PAYOUT_TRANSITION") {
      const transition = body.transition;
      if (!transition || !["APPROVE", "SEND", "CONFIRM", "FAIL"].includes(transition)) {
        throw new ApiError(400, "transition invalide (APPROVE|SEND|CONFIRM|FAIL)");
      }
      const payout = await transitionPayout(
        requireString(body.payoutId, "payoutId"),
        transition as "APPROVE" | "SEND" | "CONFIRM" | "FAIL",
        user.id,
        body.reason
      );
      return ok({ payoutId: payout.id, status: payout.status });
    }
    if (action === "STATEMENT_URL") {
      const period = await db.royaltyPeriod.findUnique({
        where: { id: requireString(body.periodId, "periodId") },
        include: { statements: { where: { payeeUserId: body.payoutId ?? undefined } } },
      });
      void period;
      const statement = await db.statement.findFirst({
        where: { periodId: body.periodId },
        orderBy: { generatedAt: "desc" },
      });
      if (!statement) throw new ApiError(404, "Aucun relevé pour cette période");
      return ok({ statementUrl: signStreamUrl(statement.fileKey, 3600), fileKey: statement.fileKey });
    }
    throw new ApiError(400, "action inconnue (CALCULATE|CREATE_PAYOUTS|PAYOUT_TRANSITION|STATEMENT_URL)");
  });
}
