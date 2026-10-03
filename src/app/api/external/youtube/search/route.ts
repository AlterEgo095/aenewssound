import { ApiError, handle, ok, rateLimit, clientIp } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { searchByQuery } from "@/lib/external/youtube/private-player";

export const dynamic = "force-dynamic";

// GET /api/external/youtube/search?q=…&limit=8
// Recherche libre de versions YouTube (mode lecteur privé, usage personnel).
// Auth requise + rate limité (quota journalier Google côté serveur).
export async function GET(req: Request) {
  return handle(async () => {
    const ctx = await requireAuth(req);
    rateLimit(`youtube-search:${ctx.user.id}:${clientIp(req)}`, 10, 60_000);

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 2) throw new ApiError(400, "Requête trop courte (2 caractères minimum)");
    const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") ?? 8)));

    const candidates = await searchByQuery(q, limit);
    return ok({
      mode: "private-playback", // identifié jusqu'au client : jamais présenté comme catalogue AENEWS
      provider: "YOUTUBE_MUSIC",
      query: q,
      candidates,
    });
  });
}

