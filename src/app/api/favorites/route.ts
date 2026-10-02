import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { trackDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const favorites = await db.favorite.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { track: { include: { mainArtist: true, album: true } } },
    });
    return ok({
      favorites: favorites.map((f) => ({
        addedAt: f.createdAt.toISOString(),
        track: trackDTO(f.track),
      })),
    });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const body = await parseBody<{ trackId?: string }>(req);
    const trackId = requireString(body.trackId, "trackId");
    const track = await db.track.findFirst({ where: { id: trackId, status: "PUBLISHED", deletedAt: null } });
    if (!track) throw new ApiError(404, "Titre introuvable");
    await db.favorite.upsert({
      where: { userId_trackId: { userId: user.id, trackId } },
      update: {},
      create: { userId: user.id, trackId },
    });
    return ok({ favorited: true }, 201);
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const trackId = new URL(req.url).searchParams.get("trackId");
    if (!trackId) throw new ApiError(400, "trackId requis");
    await db.favorite.deleteMany({ where: { userId: user.id, trackId } });
    return ok({ favorited: false });
  });
}
