import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const playlists = await db.playlist.findMany({
      where: { ownerId: user.id, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { tracks: true } } },
    });
    return ok({
      playlists: playlists.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        isPublic: p.isPublic,
        trackCount: p._count.tracks,
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const body = await parseBody<{ title?: string; description?: string; isPublic?: boolean }>(req);
    const title = requireString(body.title, "title", 80);
    const playlist = await db.playlist.create({
      data: {
        ownerId: user.id,
        kind: "USER",
        title,
        description: body.description ?? null,
        isPublic: body.isPublic ?? true,
      },
    });
    return ok({ playlist: { id: playlist.id, title: playlist.title } }, 201);
  });
}
