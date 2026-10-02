import { handle, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getEntitlementState } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

// GET /api/entitlements — ce que l'utilisateur peut consommer (v1.1 §9).
export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const state = await getEntitlementState(user.id);
    return ok({
      isPremium: state.isPremium,
      premiumUntil: state.premiumUntil?.toISOString() ?? null,
      packs: state.active.map((e) => ({
        id: e.id,
        source: e.source,
        planCode: e.planCode,
        expiresAt: e.expiresAt.toISOString(),
      })),
    });
  });
}
