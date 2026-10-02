import { db } from "@/lib/db";
import { ApiError, clientIp, handle, ok, rateLimit } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { assertProviderKind, getCatalogProvider } from "@/lib/external/registry";
import { isExternalEntityType, type ExternalSearchType } from "@/lib/external/types";
import { mapExternalToEntities } from "@/lib/external/identity";

export const dynamic = "force-dynamic";

// GET /api/external/search?provider=SPOTIFY&q=…&types=artist,album,track
// Recherche chez un fournisseur externe (auth requise, rate limitée).
// Chaque résultat est enrichi de son éventuel lien AENEWS existant.
export async function GET(req: Request) {
  return handle(async () => {
    const ctx = await requireAuth(req);
    rateLimit(`external-search:${ctx.user.id}:${clientIp(req)}`, 30, 60_000);

    const url = new URL(req.url);
    const providerKind = assertProviderKind(
      (url.searchParams.get("provider") ?? "SPOTIFY").toUpperCase()
    );
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 2) throw new ApiError(400, "Requête trop courte (2 caractères minimum)");
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));
    const typesParam = url.searchParams.get("types");
    const types: ExternalSearchType[] = typesParam
      ? typesParam
          .split(",")
          .map((t) => t.trim().toUpperCase())
          .filter((t): t is ExternalSearchType => t.length > 0)
      : ["ARTIST", "ALBUM", "TRACK"];
    for (const t of types) {
      if (!isExternalEntityType(t) && t !== "PLAYLIST") {
        throw new ApiError(400, `Type de recherche invalide : ${t}`);
      }
    }

    const { provider, sandbox, configId } = await getCatalogProvider(providerKind);
    const page = await provider.search(q, types, limit);

    // Enrichissement : l'objet externe est-il déjà lié au catalogue AENEWS ?
    const [artistLinks, albumLinks, trackLinks] = await Promise.all([
      mapExternalToEntities(
        configId,
        "ARTIST",
        page.artists.map((a) => a.externalId)
      ),
      mapExternalToEntities(
        configId,
        "ALBUM",
        page.albums.map((a) => a.externalId)
      ),
      mapExternalToEntities(
        configId,
        "TRACK",
        page.tracks.map((t) => t.externalId)
      ),
    ]);

    const enrich = <T extends { externalId: string }>(
      entityType: ExternalSearchType,
      items: T[],
      map: Map<string, { entityId: string; identityId: string }>,
      labelOf: (item: T) => string
    ) =>
      items.map((item) => ({
        ...item,
        linkedAenews: map.get(item.externalId)
          ? {
              entityType,
              ...map.get(item.externalId)!,
              label: labelOf(item),
            }
          : null,
      }));

    return ok({
      provider: providerKind,
      sandbox, // identifié jusqu'au client : jamais présenté comme production
      query: q,
      artists: enrich("ARTIST", page.artists, artistLinks, (a) => a.name),
      albums: enrich("ALBUM", page.albums, albumLinks, (a) => a.title),
      tracks: enrich("TRACK", page.tracks, trackLinks, (t) => t.title),
      total: page.total,
    });
  });
}
