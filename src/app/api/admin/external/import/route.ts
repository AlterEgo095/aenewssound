import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { assertProviderKind, getCatalogProvider } from "@/lib/external/registry";
import { isExternalEntityType } from "@/lib/external/types";
import { executeImport } from "@/lib/external/import";

export const dynamic = "force-dynamic";

type ImportBody = {
  provider?: string;
  entityType?: string;
  externalId?: string;
  mode?: string; // LINK | CREATE
  targetEntityId?: string;
  mainArtistId?: string;
  albumId?: string;
};

// POST /api/admin/external/import — exécute l'import confirmé.
//   LINK   : associe l'objet externe à une entité AENEWS existante.
//   CREATE : crée l'entité AENEWS (ARTIST=ACTIVE, ALBUM/TRACK=DRAFT) depuis
//            les métadonnées SEULEMENT — l'audio reste 100 % pipeline AENEWS.
export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const body = await parseBody<ImportBody>(req);
    const providerKind = assertProviderKind(requireString(body.provider, "provider").toUpperCase());
    const entityTypeParam = requireString(body.entityType, "entityType").toUpperCase();
    if (!isExternalEntityType(entityTypeParam)) {
      throw new ApiError(400, "entityType doit être ARTIST, ALBUM ou TRACK");
    }
    const externalId = requireString(body.externalId, "externalId");
    const mode = body.mode === "CREATE" ? "CREATE" : body.mode === "LINK" ? "LINK" : null;
    if (!mode) throw new ApiError(400, "mode doit être LINK ou CREATE");

    const { provider, sandbox, configId } = await getCatalogProvider(providerKind);
    const result = await executeImport({
      provider,
      providerId: configId,
      sandbox,
      entityType: entityTypeParam,
      externalId,
      mode,
      targetEntityId: body.targetEntityId,
      mainArtistId: body.mainArtistId,
      albumId: body.albumId,
      actorId: user.id,
    });

    // Détail du statut de l'entité créée (DRAFT vs ACTIVE) pour la réponse UI.
    let entityStatus: string | null = null;
    if (result.action === "CREATED") {
      if (entityTypeParam === "ARTIST") {
        entityStatus = (await db.artist.findUnique({ where: { id: result.entityId } }))?.status ?? null;
      } else if (entityTypeParam === "ALBUM") {
        entityStatus = (await db.album.findUnique({ where: { id: result.entityId } }))?.status ?? null;
      } else {
        entityStatus = (await db.track.findUnique({ where: { id: result.entityId } }))?.status ?? null;
      }
    }

    return ok({ ...result, entityType: entityTypeParam, entityStatus });
  });
}
