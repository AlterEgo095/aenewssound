import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { rateLimit } from "@/lib/api";

export const dynamic = "force-dynamic";

// POST — ouvre une session de lecture (base de la détection anti-fraude).
export async function POST(req: Request) {
  return handle(async () => {
    const { user, payload } = await requireAuth(req);
    rateLimit(`sessions:${user.id}`, 30, 60_000);
    const body = await parseBody<{ trackId?: string; context?: string }>(req);
    const trackId = requireString(body.trackId, "trackId");

    const track = await db.track.findFirst({
      where: { id: trackId, status: "PUBLISHED", deletedAt: null },
    });
    if (!track) throw new ApiError(404, "Titre introuvable");

    const session = await db.playbackSession.create({
      data: {
        userId: user.id,
        deviceId: payload.deviceId,
        trackId: track.id,
        context: body.context ?? null,
        appVersion: req.headers.get("x-app-version") ?? null,
        networkType: req.headers.get("x-network") ?? null,
      },
    });
    return ok({ sessionId: session.id, startedAt: session.startedAt.toISOString() }, 201);
  });
}

// PUT — ferme une session (fin de lecture, skip, erreur réseau…).
export async function PUT(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const body = await parseBody<{ sessionId?: string }>(req);
    const sessionId = requireString(body.sessionId, "sessionId");

    const session = await db.playbackSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== user.id) throw new ApiError(404, "Session introuvable");

    await db.playbackSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() },
    });
    return ok({ closed: true });
  });
}
