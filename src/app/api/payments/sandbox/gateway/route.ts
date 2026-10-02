import { db } from "@/lib/db";
import { ApiError, clientIp, handle, ok, parseBody, rateLimit } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { processWebhook, signGatewayPayload } from "@/lib/payments";
import { SANDBOX_PROVIDER_SECRET } from "@/lib/config";

export const dynamic = "force-dynamic";

type SandboxGatewayBody = {
  paymentRef?: string;
  outcome?: "SUCCESS" | "FAIL" | "EXPIRE";
};

/**
 * POST /api/payments/sandbox/gateway — PASSERELLE AGRÉGATEUR DE SIMULATION.
 *
 * Ce rôle N'EXISTE PAS en production : c'est l'agrégateur réel (FlexPay,
 * CinetPay…) qui appelle NOTRE webhook signé après le code USSD du client.
 * Ici, la passerelle sandbox joue exactement ce rôle en empruntant LE MÊME
 * chemin de code : construction du payload opérateur → signature HMAC-SHA256
 * → processWebhook() (vérification signature + idempotence + entitlement).
 * Aucun raccourci : Payment SUCCEEDED est créé par le webhook, jamais
 * directement par le client.
 */
export async function POST(req: Request) {
  return handle(async () => {
    // KILL-SWITCH production : ce rôle (agrégateur simulé) n'existe pas en
    // production — la route disparaît entièrement au lieu d'être simplement gardée.
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(404, "Passerelle sandbox désactivée en production");
    }
    const { user } = await requireAuth(req);
    rateLimit(`sandbox-gateway:${clientIp(req)}`, 30, 60_000);
    const body = await parseBody<SandboxGatewayBody>(req);
    if (!body.paymentRef) throw new ApiError(400, "paymentRef requis");
    const outcome = body.outcome ?? "SUCCESS";

    const payment = await db.payment.findFirst({
      where: { providerRef: body.paymentRef },
      include: { provider: true },
    });
    if (!payment || payment.provider.code !== "SANDBOX") {
      throw new ApiError(404, "Paiement sandbox introuvable");
    }
    // Seul le PROPRIÉTAIRE du paiement peut simuler la confirmation opérateur
    // (sinon n'importe qui finalise le providerRef d'autrui, connu via GET /api/payments).
    if (payment.userId !== user.id) {
      throw new ApiError(403, "Paiement sandbox d'un autre utilisateur");
    }
    if (["SUCCEEDED", "REFUNDED"].includes(payment.status)) {
      throw new ApiError(409, "Paiement déjà finalisé");
    }

    const eventMap = {
      SUCCESS: "payment.succeeded",
      FAIL: "payment.failed",
      EXPIRE: "payment.expired",
    } as const;

    const payload = JSON.stringify({
      event: eventMap[outcome],
      eventId: `sbx-evt-${payment.providerRef}-${outcome.toLowerCase()}-${Date.now()}`,
      paymentRef: payment.providerRef,
      amountMinor: payment.amountMinor.toString(),
      currency: payment.currency,
      reason:
        outcome === "FAIL" ? "PIN incorrect / solde insuffisant (simulation opérateur)" : undefined,
      occurredAt: new Date().toISOString(),
    });
    if (!SANDBOX_PROVIDER_SECRET) {
      throw new ApiError(503, "Passerelle sandbox non configurée (secret absent)");
    }
    const signature = signGatewayPayload(payload, SANDBOX_PROVIDER_SECRET);

    const result = await processWebhook({
      providerCode: "SANDBOX",
      rawBody: payload,
      signature,
      ip: clientIp(req),
    });
    return ok({ gateway: "SANDBOX", ...result });
  });
}
