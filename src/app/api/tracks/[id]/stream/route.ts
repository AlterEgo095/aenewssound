import { db } from "@/lib/db";
import { ApiError, handle, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { signStreamUrl } from "@/lib/signed-url";
import { STREAM_URL_TTL_SECONDS } from "@/lib/config";

export const dynamic = "force-dynamic";

// POST /api/tracks/:id/stream — délivre une URL signée à expiration courte.
// Contrôles : titre publié + droit streaming actif + variante READY (v1.1 §6/§18).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const { id } = await params;

    const track = await db.track.findFirst({
      where: { OR: [{ id }, { slug: id }], status: "PUBLISHED", deletedAt: null },
      include: { rights: { where: { kind: "OWNERSHIP", status: "ACTIVE" } } },
    });
    if (!track) throw new ApiError(404, "Titre introuvable");

    const right = track.rights[0];
    if (!right || !right.streamingAllowed) {
      throw new ApiError(451, "Streaming non autorisé pour ce titre (droits)", "RIGHTS_BLOCKED");
    }

    const asset = await db.audioAsset.findFirst({
      where: { trackId: track.id, kind: "MASTER", status: "READY" },
      include: {
        variants: { where: { kind: "PROGRESSIVE_128K", status: "READY" } },
      },
    });
    const variant = asset?.variants[0];
    if (!asset || !variant) {
      throw new ApiError(409, "Aucune variante audio prête pour ce titre", "MEDIA_NOT_READY");
    }

    return ok({
      signedUrl: signStreamUrl(variant.storageKey, STREAM_URL_TTL_SECONDS),
      expiresIn: STREAM_URL_TTL_SECONDS,
      variant: {
        kind: variant.kind,
        codec: variant.codec,
        deliveryFormat: variant.deliveryFormat,
      },
      track: {
        id: track.id,
        title: track.title,
        durationSeconds: track.durationSeconds,
        artistName: (await db.artist.findUnique({ where: { id: track.mainArtistId } }))?.name ?? "",
      },
      userId: user.id,
    });
  });
}
