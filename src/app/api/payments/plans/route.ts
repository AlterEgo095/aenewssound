import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const plans = await db.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
    return ok({
      plans: plans.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        durationHours: p.durationHours,
        priceMinor: Number(p.priceMinor),
        currency: p.currency,
        maxDevices: p.maxDevices,
        features: p.features ? (JSON.parse(p.features) as Record<string, unknown>) : null,
      })),
    });
  });
}
