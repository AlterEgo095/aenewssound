import { ApiError, handle, ok, rateLimit, clientIp } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { resolveForTrack, privatePlaybackStatus } from "@/lib/external/youtube/private-player";

export const dynamic = "force-dynamic";

// GET /api/external/youtube/resolve?trackId=…
// Résolution d'un titre du catalogue AENEWS vers une version YouTube :
//   - LINKED     → le lien mémorisé (identité YOUTUBE_MUSIC) existe ;
//   - CANDIDATES → propositions de la recherche automatique (non liées).
// Répond aussi au statut du lecteur (UNAVAILABLE → l'UI affiche pourquoi).
export async function GET(req: Request) {
  return handle(async () => {
    const ctx = await requireAuth(req);
    rateLimit(`youtube-resolve:${ctx.user.id}:${clientIp(req)}`, 20, 60_000);

    const url = new URL(req.url);
    const trackId = (url.searchParams.get("trackId") ?? "").trim();
    if (!trackId) throw new ApiError(400, "trackId requis");

    const status = privatePlaybackStatus();
    if (!status.available) {
      return ok({ mode: "UNAVAILABLE", reason: status.reason, linked: null, candidates: [] });
    }

    const result = await resolveForTrack(trackId);
    return ok({
      mode: result.mode,
      linked: result.mode === "LINKED" ? result.video : null,
      candidates: result.mode === "CANDIDATES" ? result.candidates : [],
    });
  });
}
