import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const now = new Date();
    const [
      users,
      publishedTracks,
      pendingTracks,
      paymentsSucceeded,
      revenueAgg,
      openFraudFlags,
      pendingModerations,
      periods,
    ] = await Promise.all([
      db.user.count({ where: { deletedAt: null } }),
      db.track.count({ where: { status: "PUBLISHED" } }),
      db.track.count({ where: { status: { in: ["PENDING_REVIEW", "IN_REVIEW"] } } }),
      db.payment.count({ where: { status: "SUCCEEDED" } }),
      db.payment.aggregate({ where: { status: "SUCCEEDED" }, _sum: { amountMinor: true } }),
      db.fraudFlag.count({ where: { status: { in: ["OPEN", "AUTO_CONFIRMED"] } } }),
      db.moderationReport.count({ where: { status: "PENDING" } }),
      db.royaltyPeriod.findMany({ orderBy: { periodStart: "desc" }, take: 6 }),
    ]);

    return ok({
      users,
      publishedTracks,
      pendingTracks,
      paymentsSucceeded,
      grossRevenueMinor: Number(revenueAgg._sum.amountMinor ?? 0),
      openFraudFlags,
      pendingModerations,
      royaltyPeriods: periods.map((p) => ({
        id: p.id,
        periodStart: p.periodStart.toISOString(),
        periodEnd: p.periodEnd.toISOString(),
        status: p.status,
      })),
      generatedAt: now.toISOString(),
    });
  });
}
