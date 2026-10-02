import { db } from "@/lib/db";
import { ApiError, handle, ok } from "@/lib/api";
import { albumDTO, artistDTO, trackDTO } from "@/lib/serialize";
import { getExternalLinks } from "@/lib/external/identity";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const artist = await db.artist.findFirst({
      where: { OR: [{ id }, { slug: id }], deletedAt: null },
      include: { profile: true },
    });
    if (!artist) throw new ApiError(404, "Artiste introuvable");

    const [albums, topTracks, followers, externalLinks] = await Promise.all([
      db.album.findMany({
        where: { artistId: artist.id, status: "PUBLISHED", deletedAt: null },
        orderBy: { releaseDate: "desc" },
        include: { artist: true },
      }),
      db.track.findMany({
        where: { mainArtistId: artist.id, status: "PUBLISHED", deletedAt: null },
        orderBy: { playCount: "desc" },
        take: 10,
        include: { mainArtist: true, album: true },
      }),
      db.follow.count({ where: { artistId: artist.id } }),
      getExternalLinks("ARTIST", artist.id),
    ]);

    return ok({
      artist: { ...artistDTO(artist), bio: artist.profile?.bio ?? null },
      albums: albums.map(albumDTO),
      topTracks: topTracks.map(trackDTO),
      followers,
      externalLinks,
    });
  });
}
