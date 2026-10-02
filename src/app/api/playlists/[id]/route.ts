import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { trackDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

async function getOwnedPlaylist(id: string, userId: string) {
  const playlist = await db.playlist.findFirst({
    where: { id, deletedAt: null, ownerId: userId },
  });
  if (!playlist) throw new ApiError(404, "Playlist introuvable");
  return playlist;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const { id } = await params;
    await getOwnedPlaylist(id, user.id);
    const items = await db.playlistTrack.findMany({
      where: { playlistId: id },
      orderBy: { position: "asc" },
      include: { track: { include: { mainArtist: true, album: true } } },
    });
    return ok({
      tracks: items.map((item) => ({ addedAt: item.addedAt.toISOString(), track: trackDTO(item.track) })),
    });
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const { id } = await params;
    await getOwnedPlaylist(id, user.id);
    const body = await parseBody<{ trackId?: string }>(req);
    const trackId = requireString(body.trackId, "trackId");
    const track = await db.track.findFirst({ where: { id: trackId, deletedAt: null } });
    if (!track) throw new ApiError(404, "Titre introuvable");

    const last = await db.playlistTrack.findFirst({
      where: { playlistId: id },
      orderBy: { position: "desc" },
    });
    await db.playlistTrack.upsert({
      where: { playlistId_trackId: { playlistId: id, trackId } },
      update: {},
      create: { playlistId: id, trackId, position: (last?.position ?? -1) + 1 },
    });
    return ok({ added: true }, 201);
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const { id } = await params;
    const playlist = await getOwnedPlaylist(id, user.id);
    const trackId = new URL(req.url).searchParams.get("trackId");

    if (trackId) {
      await db.playlistTrack.deleteMany({ where: { playlistId: id, trackId } });
      return ok({ removed: true });
    }
    await db.playlist.update({ where: { id: playlist.id }, data: { deletedAt: new Date() } });
    return ok({ deleted: true });
  });
}
