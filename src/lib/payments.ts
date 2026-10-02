import crypto from "crypto";
import { db } from "@/lib/db";
import { ApiError, ApiError as ApiErr } from "@/lib/api";
import { sha256 } from "@/lib/auth";
import { grantEntitlement, revokeEntitlement } from "@/lib/entitlements";
import { audit } from "@/lib/audit";
import { PAYMENT_USSD_TIMEOUT_MINUTES } from "@/lib/config";

// ---------------------------------------------------------------------------
// Idempotence (v1.1 §27) : toute mutation de paiement exige Idempotency-Key.
// 1 clé = 1 requête + 1 réponse persistée ; rejeu = réponse rejouée à l'identique.
// ---------------------------------------------------------------------------

export async function withIdempotency<T>(opts: {
  req: Request;
  userId?: string | null;
  endpoint: string;
  requestBody: unknown;
  run: () => Promise<{ status: number; body: T }>;
}): Promise<{ status: number; body: T; replayed: boolean }> {
  const key = opts.req.headers.get("idempotency-key");
  if (!key || key.length < 8 || key.length > 200) {
    throw new ApiError(400, "En-tête Idempotency-Key requis (chaîne unique par intention)");
  }
  const requestHash = sha256(JSON.stringify(opts.requestBody ?? null));
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);

  let record = await db.idempotencyKey.findUnique({ where: { key } });
  if (!record) {
    record = await db.idempotencyKey
      .create({
        data: {
          key,
          userId: opts.userId ?? null,
          endpoint: opts.endpoint,
          requestHash,
          expiresAt,
        },
      })
      .catch(async () => {
        const race = await db.idempotencyKey.findUnique({ where: { key } });
        if (!race) throw new ApiError(409, "Conflit d'idempotence");
        return race;
      });
  }

  if (record.requestHash !== requestHash) {
    throw new ApiError(409, "Clé d'idempotence réutilisée avec un corps différent");
  }
  if (record.status === "COMPLETED") {
    return {
      status: record.responseStatus ?? 200,
      body: JSON.parse(record.responseBody ?? "null") as T,
      replayed: true,
    };
  }

  const result = await opts.run();
  await db.idempotencyKey.update({
    where: { id: record.id },
    data: {
      status: "COMPLETED",
      responseStatus: result.status,
      responseBody: JSON.stringify(result.body),
    },
  });
  return { ...result, replayed: false };
}

// ---------------------------------------------------------------------------
// Cycle de vie des paiements : INITIATED → AWAITING_USSD → PENDING → SUCCEEDED
// (webhook signé) | FAILED | EXPIRED | CANCELLED | REFUNDED
// ---------------------------------------------------------------------------

export async function expireStalePayments() {
  const stale = await db.payment.updateMany({
    where: {
      status: { in: ["INITIATED", "AWAITING_USSD", "PENDING"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED", statusReason: "Timeout confirmation USSD" },
  });
  return stale.count;
}

export async function initiatePayment(opts: {
  userId: string;
  planCode: string;
  phoneNumber: string;
  providerCode?: string;
}) {
  const plan = await db.subscriptionPlan.findUnique({ where: { code: opts.planCode } });
  if (!plan || !plan.isActive) throw new ApiError(404, "Pack introuvable ou inactif");

  const provider = await db.paymentProvider.findUnique({
    where: { code: opts.providerCode ?? "SANDBOX" },
  });
  if (!provider || !provider.isActive) throw new ApiError(503, "Moyen de paiement indisponible");

  const payment = await db.payment.create({
    data: {
      userId: opts.userId,
      planId: plan.id,
      providerId: provider.id,
      providerRef: `${provider.code}-${crypto.randomBytes(8).toString("hex")}`,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      phoneNumber: opts.phoneNumber,
      status: "AWAITING_USSD",
      statusReason: `Push USSD envoyé au ${opts.phoneNumber} — en attente du code PIN`,
      expiresAt: new Date(Date.now() + PAYMENT_USSD_TIMEOUT_MINUTES * 60 * 1000),
    },
    include: { plan: true, provider: true },
  });
  return payment;
}

// ---------------------------------------------------------------------------
// Webhook agrégateur : HMAC-SHA256 du corps brut, comparaison timing-safe.
// Tous les callbacks sont persistés (rejouables), idempotents par eventId.
// ---------------------------------------------------------------------------

export type GatewayEvent = {
  event: "payment.succeeded" | "payment.failed" | "payment.expired" | "payment.refunded";
  eventId: string;
  paymentRef: string;
  providerRef?: string;
  amountMinor?: string;
  currency?: string;
  reason?: string;
  occurredAt: string;
};

export function signGatewayPayload(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64url");
}

export function verifyGatewaySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signGatewayPayload(rawBody, secret));
  const provided = Buffer.from(signature ?? "");
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

export async function processWebhook(opts: {
  providerCode: string;
  rawBody: string;
  signature: string;
  ip?: string | null;
}): Promise<{ accepted: boolean; duplicate: boolean; status?: string }> {
  const provider = await db.paymentProvider.findUnique({ where: { code: opts.providerCode } });
  if (!provider) throw new ApiError(404, "Provider inconnu");

  const signatureValid = verifyGatewaySignature(opts.rawBody, opts.signature, secretFor(provider.code));
  const event = JSON.parse(opts.rawBody) as GatewayEvent;

  // Persistance systématique du callback (même signature invalide : traçabilité).
  const existing = await db.webhookEvent.findUnique({
    where: { providerId_providerEventId: { providerId: provider.id, providerEventId: event.eventId } },
  });
  if (existing) {
    await db.webhookEvent.update({
      where: { id: existing.id },
      data: { status: "DUPLICATE" },
    });
    return { accepted: true, duplicate: true, status: existing.status };
  }

  const webhookEvent = await db.webhookEvent.create({
    data: {
      providerId: provider.id,
      providerEventId: event.eventId,
      eventType: event.event,
      signatureValid,
      payload: opts.rawBody,
      status: signatureValid ? "PROCESSING" : "IGNORED",
    },
  });

  if (!signatureValid) {
    await audit({
      action: "payment.webhook.invalid_signature",
      entityType: "WebhookEvent",
      entityId: webhookEvent.id,
      after: { provider: provider.code, eventId: event.eventId },
      ip: opts.ip ?? null,
    });
    throw new ApiError(401, "Signature webhook invalide");
  }

  const payment = await db.payment.findUnique({
    where: { providerId_providerRef: { providerId: provider.id, providerRef: event.paymentRef } },
  });
  if (!payment) {
    await db.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "FAILED", error: "Paiement introuvable pour cette référence" },
    });
    throw new ApiError(404, "Paiement introuvable");
  }

  await db.webhookEvent.update({ where: { id: webhookEvent.id }, data: { paymentId: payment.id } });

  let finalStatus = payment.status;

  if (event.event === "payment.succeeded") {
    // Transition idempotente : un paiement déjà SUCCEEDED ne re-crée pas de droit.
    if (payment.status !== "SUCCEEDED") {
      const updated = await db.payment.update({
        where: { id: payment.id },
        data: { status: "SUCCEEDED", statusReason: null, completedAt: new Date() },
      });
      finalStatus = updated.status;
      await grantEntitlement({
        userId: payment.userId,
        planId: payment.planId,
        paymentId: payment.id,
        source: "PACK_PAYMENT",
        durationHours: (await db.subscriptionPlan.findUnique({ where: { id: payment.planId } }))
          ?.durationHours ?? 24,
      });
    }
  } else if (event.event === "payment.failed") {
    if (["INITIATED", "AWAITING_USSD", "PENDING"].includes(payment.status)) {
      const updated = await db.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED", statusReason: event.reason ?? "Échec opérateur", completedAt: new Date() },
      });
      finalStatus = updated.status;
    }
  } else if (event.event === "payment.expired") {
    if (["INITIATED", "AWAITING_USSD", "PENDING"].includes(payment.status)) {
      const updated = await db.payment.update({
        where: { id: payment.id },
        data: { status: "EXPIRED", statusReason: event.reason ?? "Expiré opérateur", completedAt: new Date() },
      });
      finalStatus = updated.status;
    }
  } else if (event.event === "payment.refunded") {
    finalStatus = (await refundPayment(payment.id, null, event.reason ?? "Remboursement opérateur")).status;
  }

  await db.webhookEvent.update({
    where: { id: webhookEvent.id },
    data: { status: "PROCESSED", processedAt: new Date() },
  });

  await audit({
    action: "payment.webhook.processed",
    entityType: "Payment",
    entityId: payment.id,
    after: { event: event.event, finalStatus },
    ip: opts.ip ?? null,
  });

  return { accepted: true, duplicate: false, status: finalStatus };
}

function secretFor(providerCode: string): string {
  // En production : SANDBOX_PROVIDER_SECRET / FLEXPAY_SECRET / CINETPAY_SECRET…
  if (providerCode === "SANDBOX") {
    return process.env.SANDBOX_PROVIDER_SECRET || "aenews-sandbox-gateway-secret-0002";
  }
  return process.env[`${providerCode}_SECRET`] || SANDBOX_FALLBACK;
}

const SANDBOX_FALLBACK = "aenews-sandbox-gateway-secret-0002";

export async function refundPayment(paymentId: string, actorId: string | null, reason: string) {
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new ApiErr(404, "Paiement introuvable");
  if (payment.status === "REFUNDED") return payment;

  const updated = await db.payment.update({
    where: { id: paymentId },
    data: { status: "REFUNDED", statusReason: reason, completedAt: new Date() },
  });

  const entitlements = await db.entitlement.findMany({
    where: { paymentId, status: "ACTIVE" },
  });
  for (const entitlement of entitlements) {
    await revokeEntitlement(entitlement.id, reason, actorId ?? "system");
  }

  await audit({
    actorId,
    action: "payment.refund",
    entityType: "Payment",
    entityId: paymentId,
    before: { status: payment.status },
    after: { status: "REFUNDED", revokedEntitlements: entitlements.length },
  });
  return updated;
}
