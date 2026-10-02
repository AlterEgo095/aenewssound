import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const genres = await db.genre.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { tracks: true } } },
    });
    return ok({
      genres: genres.map((g) => ({ id: g.id, name: g.name, slug: g.slug, trackCount: g._count.tracks })),
    });
  });
}
