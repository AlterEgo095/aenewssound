import { ApiError, handle, ok, rateLimit, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { linkVideo, unlinkVideo } from "@/lib/external/youtube/private-player";
import type { YoutubeVideo } from "@/lib/external/youtube/api";

export const dynamic = "force-dynamic";

// POST /api/external/youtube/link  { trackId, video }
// Mémorise la version YouTube d'un titre (identité externe YOUTUBE_MUSIC,
// anti-doublon + audit). Admin : le propriétaire de la plateforme en usage privé.
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = await requireAdmin(req);
    rateLimit(`youtube-link:${ctx.user.id}:${clientIp(req)}`, 20, 60_000);

    const body = (await req.json().catch(() => null)) as
      | { trackId?: string; video?: Partial<YoutubeVideo> }
      | null;
    const trackId = body?.trackId?.trim();
    const video = body?.video;
    if (!trackId || !video?.videoId || typeof video.videoId !== "string") {
      throw new ApiError(400, "trackId et video.videoId sont requis");
    }
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(video.videoId)) {
      throw new ApiError(400, "videoId YouTube invalide");
    }

    const linked = await linkVideo({
      trackId,
      actorId: ctx.user.id,
      video: {
        videoId: video.videoId,
        title: typeof video.title === "string" && video.title ? video.title : video.videoId,
        channelTitle: typeof video.channelTitle === "string" ? video.channelTitle : "",
        thumbnailUrl: typeof video.thumbnailUrl === "string" ? video.thumbnailUrl : null,
        durationText: typeof video.durationText === "string" ? video.durationText : null,
        publishedAt: typeof video.publishedAt === "string" ? video.publishedAt : null,
      },
    });
    return ok({ linked });
  });
}

// DELETE /api/external/youtube/link?trackId=…
// Dissocie la vidéo YouTube d'un titre (le titre AENEWS reste intact).
export async function DELETE(req: Request) {
  return handle(async () => {
    const ctx = await requireAdmin(req);
    rateLimit(`youtube-unlink:${ctx.user.id}:${clientIp(req)}`, 20, 60_000);

    const url = new URL(req.url);
    const trackId = (url.searchParams.get("trackId") ?? "").trim();
    if (!trackId) throw new ApiError(400, "trackId requis");

    await unlinkVideo(trackId, ctx.user.id);
    return ok({ unlinked: true });
  });
}
