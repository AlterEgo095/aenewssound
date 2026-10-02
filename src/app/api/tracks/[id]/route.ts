import { db } from "@/lib/db";
import { ApiError, handle, ok } from "@/lib/api";
import { trackDTO } from "@/lib/serialize";
import { getExternalLinks } from "@/lib/external/identity";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const track = await db.track.findFirst({
      where: { OR: [{ id }, { slug: id }], status: "PUBLISHED", deletedAt: null },
      include: {
        mainArtist: true,
        album: true,
        genres: { include: { genre: true } },
        credits: { include: { artist: true } },
      },
    });
    if (!track) throw new ApiError(404, "Titre introuvable");

    const externalLinks = await getExternalLinks("TRACK", track.id);

    const dto = trackDTO(track);
    return ok({
      track: dto,
      genres: track.genres.map((tg) => ({ id: tg.genre.id, name: tg.genre.name })),
      credits: track.credits.map((c) => ({
        artistId: c.artist.id,
        name: c.artist.name,
        role: c.role,
      })),
      externalLinks,
    });
  });
}
