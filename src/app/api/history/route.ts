import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { trackDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const history = await db.listeningHistory.findMany({
      where: { userId: user.id },
      orderBy: { playedAt: "desc" },
      take: 50,
      include: { track: { include: { mainArtist: true, album: true } } },
    });
    // Déduplique par titre en gardant la lecture la plus récente.
    const seen = new Set<string>();
    const items = history
      .filter((h) => {
        if (seen.has(h.trackId)) return false;
        seen.add(h.trackId);
        return true;
      })
      .map((h) => ({ playedAt: h.playedAt.toISOString(), track: trackDTO(h.track) }));
    return ok({ history: items });
  });
}
