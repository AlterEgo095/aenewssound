import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { getCatalogProvider } from "@/lib/external/registry";
import { syncIdentity } from "@/lib/external/identity";

export const dynamic = "force-dynamic";

type SyncBody = { identityId?: string };

// POST /api/admin/external/identities/sync — resynchronise UNE identité
// immédiatement (metadonnées provider → snapshot). Résultat observable.
export async function POST(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const body = await parseBody<SyncBody>(req);
    if (!body.identityId) throw new ApiError(400, "identityId requis");

    const identity = await db.externalCatalogIdentity.findUnique({
      where: { id: body.identityId },
    });
    if (!identity) throw new ApiError(404, "Identité externe introuvable");

    const config = await db.externalProviderConfig.findUnique({
      where: { id: identity.providerId },
    });
    if (!config) throw new ApiError(404, "Fournisseur inconnu");

    const { provider } = await getCatalogProvider(config.provider as "SPOTIFY");
    const result = await syncIdentity(identity, provider);
    if (result.status === "FAILED") {
      return ok({ status: result.status, error: result.error }); // diagnostic, pas d'exception : l'entité AENEWS reste intacte
    }
    return ok({ status: result.status });
  });
}
