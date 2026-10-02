import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/admin/external/catalog-candidates?entityType=ARTIST|ALBUM|TRACK&q=&artistId=
// Candidats AENEWS pour l'association/import (y compris DRAFT — le back-office
// doit voir tout le catalogue, contrairement à la recherche publique).
export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const url = new URL(req.url);
    const entityType = (url.searchParams.get("entityType") ?? "ARTIST").toUpperCase();
    const q = (url.searchParams.get("q") ?? "").trim();
    const artistId = url.searchParams.get("artistId") ?? undefined;

    if (entityType === "ARTIST") {
      const artists = await db.artist.findMany({
        where: {
          deletedAt: null,
          ...(q ? { name: { contains: q } } : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { id: true, name: true, status: true },
      });
      return ok({ items: artists.map((a) => ({ id: a.id, label: a.name, status: a.status })) });
    }

    if (entityType === "ALBUM") {
      const albums = await db.album.findMany({
        where: { deletedAt: null, ...(q ? { title: { contains: q } } : {}) },
        include: { artist: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
        take: 20,
      });
      return ok({
        items: albums.map((a) => ({
          id: a.id,
          label: a.title,
          sublabel: a.artist.name,
          status: a.status,
          artistId: a.artistId,
        })),
      });
    }

    // TRACK
    const tracks = await db.track.findMany({
      where: {
        deletedAt: null,
        ...(q ? { title: { contains: q } } : {}),
        ...(artistId ? { mainArtistId: artistId } : {}),
      },
      include: { mainArtist: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    return ok({
      items: tracks.map((t) => ({
        id: t.id,
        label: t.title,
        sublabel: t.mainArtist.name,
        status: t.status,
        artistId: t.mainArtistId,
        albumId: t.albumId,
      })),
    });
  });
}
