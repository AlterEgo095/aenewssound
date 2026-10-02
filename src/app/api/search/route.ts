import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { albumDTO, artistDTO, trackDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

// GET /api/search?q=… — recherche classique (Meilisearch en production, v1.1 §14).
export async function GET(req: Request) {
  return handle(async () => {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (q.length < 2) {
      return ok({ query: q, tracks: [], artists: [], albums: [] });
    }

    const [tracks, artists, albums] = await Promise.all([
      db.track.findMany({
        where: { status: "PUBLISHED", deletedAt: null, title: { contains: q } },
        take: 8,
        include: { mainArtist: true, album: true },
        orderBy: { playCount: "desc" },
      }),
      db.artist.findMany({
        where: { status: "ACTIVE", deletedAt: null, name: { contains: q } },
        take: 6,
      }),
      db.album.findMany({
        where: { status: "PUBLISHED", deletedAt: null, title: { contains: q } },
        take: 6,
        include: { artist: true },
      }),
    ]);

    return ok({
      query: q,
      tracks: tracks.map(trackDTO),
      artists: artists.map(artistDTO),
      albums: albums.map(albumDTO),
    });
  });
}
