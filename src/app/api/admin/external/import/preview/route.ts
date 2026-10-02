import { db } from "@/lib/db";
import { ApiError, handle, ok, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { assertProviderKind, getCatalogProvider } from "@/lib/external/registry";
import { isExternalEntityType } from "@/lib/external/types";
import { previewImport } from "@/lib/external/import";

export const dynamic = "force-dynamic";

// GET /api/admin/external/import/preview?provider=SPOTIFY&entityType=ARTIST&externalId=…
// Étape « Preview metadata » de l'import contrôlé : métadonnées normalisées,
// identité existante (déjà lié ?) et correspondances potentielles du catalogue.
export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const url = new URL(req.url);
    const providerKind = assertProviderKind(
      requireString(url.searchParams.get("provider"), "provider").toUpperCase()
    );
    const entityTypeParam = requireString(url.searchParams.get("entityType"), "entityType").toUpperCase();
    if (!isExternalEntityType(entityTypeParam)) {
      throw new ApiError(400, "entityType doit être ARTIST, ALBUM ou TRACK");
    }
    const externalId = requireString(url.searchParams.get("externalId"), "externalId");

    const { provider, sandbox, configId } = await getCatalogProvider(providerKind);
    const preview = await previewImport(provider, configId, sandbox, entityTypeParam, externalId);
    return ok(preview);
  });
}
