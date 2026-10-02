import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { expireStalePayments } from "@/lib/payments";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    await expireStalePayments();
    const payments = await db.payment.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: { plan: true, provider: true },
    });
    return ok({
      payments: payments.map((p) => ({
        id: p.id,
        status: p.status,
        statusReason: p.statusReason,
        amountMinor: Number(p.amountMinor),
        currency: p.currency,
        phoneNumber: p.phoneNumber,
        provider: p.provider.displayName,
        plan: { code: p.plan.code, name: p.plan.name },
        createdAt: p.createdAt.toISOString(),
        completedAt: p.completedAt?.toISOString() ?? null,
      })),
    });
  });
}
