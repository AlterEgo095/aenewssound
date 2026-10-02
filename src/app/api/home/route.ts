import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { albumDTO, artistDTO, trackDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

// GET /api/home — sections de l'accueil (v1.1 §9 : /api/v1/home).
export async function GET() {
  return handle(async () => {
    const [newReleases, trending, artists, genres] = await Promise.all([
      db.track.findMany({
        where: { status: "PUBLISHED", deletedAt: null },
        orderBy: { publishedAt: "desc" },
        take: 10,
        include: { mainArtist: true, album: true },
      }),
      db.track.findMany({
        where: { status: "PUBLISHED", deletedAt: null },
        orderBy: { playCount: "desc" },
        take: 10,
        include: { mainArtist: true, album: true },
      }),
      db.artist.findMany({
        where: { status: "ACTIVE", deletedAt: null },
        orderBy: { createdAt: "asc" },
        take: 8,
      }),
      db.genre.findMany({
        orderBy: { name: "asc" },
        include: { _count: { select: { tracks: true } } },
      }),
    ]);

    return ok({
      newReleases: newReleases.map(trackDTO),
      trending: trending.map(trackDTO),
      artists: artists.map(artistDTO),
      genres: genres.map((g) => ({ id: g.id, name: g.name, slug: g.slug, trackCount: g._count.tracks })),
    });
  });
}
