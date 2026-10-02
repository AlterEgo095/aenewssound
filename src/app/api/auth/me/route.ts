import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { publicUser, requireAuth } from "@/lib/auth";
import { getEntitlementState } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user, payload } = await requireAuth(req);
    const [entitlements, deviceCount, activeSessions] = await Promise.all([
      getEntitlementState(user.id),
      db.userDevice.count({ where: { userId: user.id } }),
      db.userSession.count({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    return ok({
      user: publicUser(user),
      deviceId: payload.deviceId,
      entitlements: {
        isPremium: entitlements.isPremium,
        premiumUntil: entitlements.premiumUntil?.toISOString() ?? null,
        packs: entitlements.active.map((e) => ({
          id: e.id,
          source: e.source,
          planCode: e.planCode,
          expiresAt: e.expiresAt.toISOString(),
        })),
      },
      deviceCount,
      activeSessions,
    });
  });
}
