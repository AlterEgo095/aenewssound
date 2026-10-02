import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { cacheStats } from "@/lib/external/cache";
import { ensureProviderConfigs } from "@/lib/external/registry";

export const dynamic = "force-dynamic";

// GET /api/external/providers — fournisseurs externes disponibles (public).
// Expose uniquement des informations non sensibles (nom, actif, sandbox).
export async function GET() {
  return handle(async () => {
    await ensureProviderConfigs(); // provisionnement idempotent (upsert)
    const configs = await db.externalProviderConfig.findMany({
      orderBy: { provider: "asc" },
      select: { provider: true, displayName: true, enabled: true, sandbox: true },
    });
    return ok({
      providers: configs,
      cache: cacheStats(), // observabilité (v1.1 §18)
    });
  });
}
