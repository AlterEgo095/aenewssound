import { db } from "@/lib/db";
import { ApiError, handle, ok } from "@/lib/api";
import { albumDTO, trackDTO } from "@/lib/serialize";
import { getExternalLinks } from "@/lib/external/identity";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const album = await db.album.findFirst({
      where: { OR: [{ id }, { slug: id }], status: "PUBLISHED", deletedAt: null },
      include: { artist: true },
    });
    if (!album) throw new ApiError(404, "Album introuvable");

    const [tracks, externalLinks] = await Promise.all([
      db.track.findMany({
        where: { albumId: album.id, status: "PUBLISHED", deletedAt: null },
        orderBy: { trackNumber: "asc" },
        include: { mainArtist: true, album: true },
      }),
      getExternalLinks("ALBUM", album.id),
    ]);

    return ok({ album: albumDTO(album), tracks: tracks.map(trackDTO), externalLinks });
  });
}
