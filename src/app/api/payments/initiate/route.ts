import { handle, ok, parseBody, requirePhone, requireString } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { expireStalePayments, initiatePayment, withIdempotency } from "@/lib/payments";

export const dynamic = "force-dynamic";

// POST /api/payments/initiate — Idempotency-Key OBLIGATOIRE (v1.1 §27).
export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    await expireStalePayments();

    const body = await parseBody<{ planCode?: string; phoneNumber?: string; providerCode?: string }>(req);
    const planCode = requireString(body.planCode, "planCode", 40);
    const phoneNumber = requirePhone(body.phoneNumber);

    const result = await withIdempotency({
      req,
      userId: user.id,
      endpoint: "POST /api/payments/initiate",
      requestBody: body,
      run: async () => {
        const payment = await initiatePayment({
          userId: user.id,
          planCode,
          phoneNumber,
          providerCode: body.providerCode,
        });
        return {
          status: 201,
          body: {
            paymentId: payment.id,
            status: payment.status,
            providerRef: payment.providerRef,
            amountMinor: Number(payment.amountMinor),
            currency: payment.currency,
            phoneNumber: payment.phoneNumber,
            expiresAt: payment.expiresAt?.toISOString() ?? null,
            plan: { code: payment.plan.code, name: payment.plan.name, durationHours: payment.plan.durationHours },
            statusReason: payment.statusReason,
          },
        };
      },
    });

    return ok({ ...result.body, replayed: result.replayed }, result.status);
  });
}
