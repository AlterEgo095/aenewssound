import { db } from "@/lib/db";
import { ApiError } from "@/lib/api";
import { audit } from "@/lib/audit";

// Entitlements — SOURCE UNIQUE DE VÉRITÉ (v1.1, règle 1).
// Aucun module de streaming/download ne doit consulter Payment directement.

export type EntitlementState = {
  isPremium: boolean;
  premiumUntil: Date | null;
  active: {
    id: string;
    source: string;
    expiresAt: Date;
    planCode: string | null;
  }[];
};

export async function getEntitlementState(userId: string): Promise<EntitlementState> {
  // Expiration paresseuse : les packs dépassés passent EXPIRED à la consultation.
  await db.entitlement.updateMany({
    where: { userId, status: "ACTIVE", expiresAt: { lte: new Date() } },
    data: { status: "EXPIRED" },
  });

  const active = await db.entitlement.findMany({
    where: { userId, status: "ACTIVE", expiresAt: { gt: new Date() } },
    include: { plan: true },
    orderBy: { expiresAt: "desc" },
  });

  return {
    isPremium: active.length > 0,
    // Cumul des packs : l'accès effectif = expiration maximale (v1.1 §27).
    premiumUntil: active[0]?.expiresAt ?? null,
    active: active.map((e) => ({
      id: e.id,
      source: e.source,
      expiresAt: e.expiresAt,
      planCode: e.plan?.code ?? null,
    })),
  };
}

export async function requireEntitlement(userId: string): Promise<EntitlementState> {
  const state = await getEntitlementState(userId);
  if (!state.isPremium) {
    throw new ApiError(402, "Abonnement actif requis — choisissez un pack", "PREMIUM_REQUIRED");
  }
  return state;
}

export async function grantEntitlement(opts: {
  userId: string;
  planId?: string | null;
  paymentId?: string | null;
  source: "PACK_PAYMENT" | "GIFT" | "ADMIN_GRANT" | "TRIAL" | "REFERRAL";
  durationHours: number;
  grantedById?: string | null;
}) {
  const entitlement = await db.entitlement.create({
    data: {
      userId: opts.userId,
      planId: opts.planId ?? null,
      paymentId: opts.paymentId ?? null,
      grantedById: opts.grantedById ?? null,
      source: opts.source,
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + opts.durationHours * 3600 * 1000),
    },
  });
  await audit({
    actorId: opts.grantedById ?? null,
    action: "entitlement.grant",
    entityType: "Entitlement",
    entityId: entitlement.id,
    after: { userId: opts.userId, source: opts.source, durationHours: opts.durationHours },
  });
  return entitlement;
}

export async function revokeEntitlement(
  entitlementId: string,
  reason: string,
  actorId: string
) {
  const existing = await db.entitlement.findUnique({ where: { id: entitlementId } });
  if (!existing) throw new ApiError(404, "Entitlement introuvable");
  if (existing.status === "REVOKED") return existing;

  const updated = await db.entitlement.update({
    where: { id: entitlementId },
    data: { status: "REVOKED", revokedAt: new Date(), revokeReason: reason },
  });

  // Les downloads licenciés par ce droit perdent leur validité (v1.1 §7).
  await db.download.updateMany({
    where: { entitlementId, status: { in: ["READY", "PREPARING", "REQUESTED"] } },
    data: { status: "REVOKED", revokedAt: new Date() },
  });

  await audit({
    actorId,
    action: "entitlement.revoke",
    entityType: "Entitlement",
    entityId: entitlementId,
    before: { status: existing.status },
    after: { status: "REVOKED", reason },
  });
  return updated;
}
