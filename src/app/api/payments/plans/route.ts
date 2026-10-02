import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

function safeParse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // donnée corrompue : jamais de 500 brut
  }
}

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
        features: safeParse(p.features),
      })),
    });
  });
}
