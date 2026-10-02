import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { artistDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const follows = await db.follow.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { artist: true },
    });
    return ok({ follows: follows.map((f) => artistDTO(f.artist)) });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const body = await parseBody<{ artistId?: string }>(req);
    const artistId = requireString(body.artistId, "artistId");
    const artist = await db.artist.findFirst({ where: { id: artistId, deletedAt: null } });
    if (!artist) throw new ApiError(404, "Artiste introuvable");
    await db.follow.upsert({
      where: { userId_artistId: { userId: user.id, artistId } },
      update: {},
      create: { userId: user.id, artistId },
    });
    return ok({ following: true }, 201);
  });
}

export async function DELETE(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const artistId = new URL(req.url).searchParams.get("artistId");
    if (!artistId) throw new ApiError(400, "artistId requis");
    await db.follow.deleteMany({ where: { userId: user.id, artistId } });
    return ok({ following: false });
  });
}
