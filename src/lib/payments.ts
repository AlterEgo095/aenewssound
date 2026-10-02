import crypto from "crypto";
import { db } from "@/lib/db";
import { ApiError, ApiError as ApiErr } from "@/lib/api";
import { sha256 } from "@/lib/auth";
import { grantEntitlement } from "@/lib/entitlements";
import { audit } from "@/lib/audit";
import { PAYMENT_USSD_TIMEOUT_MINUTES, SANDBOX_PROVIDER_SECRET } from "@/lib/config";

// Transitions autorisées vers SUCCEEDED : tout état "en attente" + EXPIRED/FAILED
// (l'opérateur peut confirmer avec retard — l'argent a été réellement pris).
// JAMAIS depuis REFUNDED (l'argent a été rendu) ni CANCELLED (annulé client).
const SUCCEEDED_ALLOWED_FROM = [
  "INITIATED",
  "AWAITING_USSD",
  "PENDING",
  "EXPIRED",
  "FAILED",
] as const;
const OPEN_STATUSES = ["INITIATED", "AWAITING_USSD", "PENDING"] as const;

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

  // Rejeu scoppé : une clé appartient à UN utilisateur et UNE route, et n'est
  // rejouable que dans sa fenêtre de validité — jamais la réponse d'autrui.
  const scopeMatches = (
    r: { userId: string | null; endpoint: string; expiresAt: Date } | null
  ): boolean =>
    r !== null &&
    r.userId === (opts.userId ?? null) &&
    r.endpoint === opts.endpoint &&
    r.expiresAt.getTime() > Date.now();

  let record = await db.idempotencyKey.findUnique({ where: { key } });
  if (record && !scopeMatches(record)) {
    throw new ApiError(409, "Clé d'idempotence déjà utilisée — générez une nouvelle clé");
  }
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
        // Course : une requête concurrente a créé la clé avant nous.
        const race = await db.idempotencyKey.findUnique({ where: { key } });
        if (!race || !scopeMatches(race)) {
          throw new ApiError(409, "Clé d'idempotence déjà utilisée — générez une nouvelle clé");
        }
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

  // Claim atomique : une seule exécution concurrente par clé (sinon double
  // push USSD = double débit possible). Le perdant reçoit 409 et rejeuera.
  const claim = await db.idempotencyKey.updateMany({
    where: { id: record.id, status: "OPEN" },
    data: { status: "PROCESSING" },
  });
  if (claim.count !== 1) {
    throw new ApiError(409, "Requête identique déjà en cours — réessayez plus tard");
  }
  try {
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
  } catch (e) {
    // Libère la clé : le client peut rejouer la MÊME clé après un échec serveur.
    await db.idempotencyKey
      .updateMany({
        where: { id: record.id, status: "PROCESSING" },
        data: { status: "OPEN" },
      })
      .catch(() => undefined);
    throw e;
  }
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

  // FAIL-CLOSED : secretFor() lève 503 si le secret du provider n'est pas
  // configuré — un webhook non configuré n'est JAMAIS vérifié contre un secret
  // de secours public (sinon n'importe qui forgerait des paiements réussis).
  const secret = secretFor(provider.code);

  let event: GatewayEvent;
  try {
    event = JSON.parse(opts.rawBody) as GatewayEvent;
  } catch {
    // Corps illisible : persistance placeholder (traçabilité) puis rejet.
    await db.webhookEvent.create({
      data: {
        providerId: provider.id,
        providerEventId: `unparseable-${sha256(opts.rawBody).slice(0, 24)}`,
        eventType: "unknown",
        signatureValid: false,
        payload: opts.rawBody.slice(0, 4000),
        status: "IGNORED",
        error: "Corps non JSON",
      },
    });
    throw new ApiError(400, "Corps webhook illisible");
  }

  const signatureValid = verifyGatewaySignature(opts.rawBody, opts.signature, secret);

  // La vérification de signature PRÉCÈDE toujours le dédoublonnage : un
  // attaquant sans le secret ne peut plus pré-enregistrer un eventId pour
  // faire ignorer le vrai callback de l'agrégateur (attaque par dédoublon).
  if (!signatureValid) {
    const existingInvalid = await db.webhookEvent.findUnique({
      where: { providerId_providerEventId: { providerId: provider.id, providerEventId: event.eventId ?? "none" } },
    });
    const webhookEvent = existingInvalid
      ? await db.webhookEvent.update({
          where: { id: existingInvalid.id },
          data: { status: "IGNORED", signatureValid: false },
        })
      : await db.webhookEvent.create({
          data: {
            providerId: provider.id,
            providerEventId: event.eventId ?? `invalid-${sha256(opts.rawBody).slice(0, 24)}`,
            eventType: event.event ?? "unknown",
            signatureValid: false,
            payload: opts.rawBody.slice(0, 4000),
            status: "IGNORED",
          },
        });
    await audit({
      action: "payment.webhook.invalid_signature",
      entityType: "WebhookEvent",
      entityId: webhookEvent.id,
      after: { provider: provider.code, eventId: event.eventId },
      ip: opts.ip ?? null,
    });
    throw new ApiError(401, "Signature webhook invalide");
  }

  // Signature valide : validation des champs obligatoires puis idempotence.
  if (!event.eventId || !event.event || !event.paymentRef || !event.occurredAt) {
    await db.webhookEvent.create({
      data: {
        providerId: provider.id,
        providerEventId: event.eventId || `malformed-${sha256(opts.rawBody).slice(0, 24)}`,
        eventType: event.event ?? "unknown",
        signatureValid: true,
        payload: opts.rawBody.slice(0, 4000),
        status: "FAILED",
        error: "Champs obligatoires manquants (eventId/event/paymentRef/occurredAt)",
      },
    });
    throw new ApiError(400, "Webhook malformé — champs obligatoires manquants");
  }

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
      signatureValid: true,
      payload: opts.rawBody,
      status: "PROCESSING",
    },
  });

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

  // Contrôle d'intégrité : un callback dont le montant diverge du paiement
  // n'est jamais appliqué (montant toujours piloté par le serveur).
  if (event.amountMinor != null && event.amountMinor !== payment.amountMinor.toString()) {
    await db.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { paymentId: payment.id, status: "FAILED", error: "Montant divergent" },
    });
    await audit({
      action: "payment.webhook.amount_mismatch",
      entityType: "Payment",
      entityId: payment.id,
      after: { event: event.event, expected: payment.amountMinor.toString(), received: event.amountMinor },
      ip: opts.ip ?? null,
    });
    throw new ApiError(409, "Montant du callback divergent — événement refusé");
  }

  await db.webhookEvent.update({ where: { id: webhookEvent.id }, data: { paymentId: payment.id } });

  let finalStatus = payment.status;

  if (event.event === "payment.succeeded") {
    // Transition conditionnelle ATOMIQUE (updateMany + count) puis création de
    // l'entitlement dans la MÊME transaction : deux webhooks concurrents ne
    // peuvent pas créer deux droits (garde count===1), et un échec ne laisse
    // jamais un paiement SUCCEEDED sans droit.
    const granted = await db.$transaction(async (tx) => {
      const upd = await tx.payment.updateMany({
        where: { id: payment.id, status: { in: [...SUCCEEDED_ALLOWED_FROM] } },
        data: { status: "SUCCEEDED", statusReason: null, completedAt: new Date() },
      });
      if (upd.count !== 1) return false;
      const plan = await tx.subscriptionPlan.findUnique({ where: { id: payment.planId } });
      await grantEntitlement({
        userId: payment.userId,
        planId: payment.planId,
        paymentId: payment.id,
        source: "PACK_PAYMENT",
        durationHours: plan?.durationHours ?? 24,
        tx,
      });
      return true;
    });
    finalStatus = granted ? "SUCCEEDED" : payment.status;
  } else if (event.event === "payment.failed") {
    const updated = await db.payment.updateMany({
      where: { id: payment.id, status: { in: [...OPEN_STATUSES] } },
      data: { status: "FAILED", statusReason: event.reason ?? "Échec opérateur", completedAt: new Date() },
    });
    if (updated.count === 1) finalStatus = "FAILED";
  } else if (event.event === "payment.expired") {
    const updated = await db.payment.updateMany({
      where: { id: payment.id, status: { in: [...OPEN_STATUSES] } },
      data: { status: "EXPIRED", statusReason: event.reason ?? "Expiré opérateur", completedAt: new Date() },
    });
    if (updated.count === 1) finalStatus = "EXPIRED";
  } else if (event.event === "payment.refunded") {
    finalStatus = (await refundPayment(payment.id, null, event.reason ?? "Remboursement opérateur")).status;
  } else {
    // Type d'événement inconnu : IGNORÉ (jamais PROCESSED) + traçable.
    await db.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "IGNORED", error: `Type d'événement inconnu : ${event.event}` },
    });
    await audit({
      action: "payment.webhook.ignored",
      entityType: "WebhookEvent",
      entityId: webhookEvent.id,
      after: { provider: provider.code, event: event.event },
      ip: opts.ip ?? null,
    });
    return { accepted: true, duplicate: false, status: payment.status };
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
  // FAIL-CLOSED : pas de secret configuré = pas de vérification possible =
  // webhook rejeté (503). JAMAIS de fallback vers un secret public.
  if (providerCode === "SANDBOX") {
    // Source unique : config.ts (fallback dev explicite, undefined en prod).
    if (!SANDBOX_PROVIDER_SECRET) {
      throw new ApiError(503, "Passerelle sandbox non configurée — webhook rejeté");
    }
    return SANDBOX_PROVIDER_SECRET;
  }
  const s = process.env[`${providerCode}_SECRET`];
  if (!s) {
    throw new ApiError(
      503,
      `Provider ${providerCode} non configuré — webhook rejeté (fail-closed)`
    );
  }
  return s;
}

export async function refundPayment(paymentId: string, actorId: string | null, reason: string) {
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new ApiErr(404, "Paiement introuvable");
  if (payment.status === "REFUNDED") return payment;

  // TRANSACTION : paiement, entitlements et licences de téléchargement changent
  // d'état ensemble — un crash intermédiaire ne peut plus laisser un paiement
  // remboursé avec un accès premium actif (perte sèche).
  const { updated, revokedCount } = await db.$transaction(async (tx) => {
    const u = await tx.payment.update({
      where: { id: paymentId },
      data: { status: "REFUNDED", statusReason: reason, completedAt: new Date() },
    });
    const active = await tx.entitlement.findMany({
      where: { paymentId, status: "ACTIVE" },
      select: { id: true },
    });
    await tx.entitlement.updateMany({
      where: { paymentId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date(), revokeReason: reason },
    });
    await tx.download.updateMany({
      where: {
        entitlementId: { in: active.map((e) => e.id) },
        status: { in: ["READY", "PREPARING", "REQUESTED"] },
      },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    return { updated: u, revokedCount: active.length };
  });

  await audit({
    actorId,
    action: "payment.refund",
    entityType: "Payment",
    entityId: paymentId,
    before: { status: payment.status },
    after: { status: "REFUNDED", revokedEntitlements: revokedCount },
  });
  return updated;
}
