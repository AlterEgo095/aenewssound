import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { expireStalePayments, refundPayment } from "@/lib/payments";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    await expireStalePayments();
    const payments = await db.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
      include: { user: true, plan: true, provider: true },
    });
    return ok({
      payments: payments.map((p) => ({
        id: p.id,
        user: { id: p.user.id, displayName: p.user.displayName, phone: p.user.phone },
        status: p.status,
        statusReason: p.statusReason,
        amountMinor: Number(p.amountMinor),
        currency: p.currency,
        provider: p.provider.code,
        plan: { code: p.plan.code, name: p.plan.name },
        phoneNumber: p.phoneNumber,
        createdAt: p.createdAt.toISOString(),
        completedAt: p.completedAt?.toISOString() ?? null,
        providerRef: p.providerRef,
      })),
    });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const body = await parseBody<{ paymentId?: string; action?: string; reason?: string }>(req);
    const paymentId = requireString(body.paymentId, "paymentId");
    if (body.action !== "REFUND") throw new ApiError(400, "action doit valoir REFUND");

    const updated = await refundPayment(
      paymentId,
      user.id,
      body.reason ?? "Remboursement back-office"
    );
    return ok({ paymentId, status: updated.status });
  });
}
