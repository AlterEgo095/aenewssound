import { db } from "@/lib/db";
import { ApiError, handle, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    const track = await db.track.findFirst({
      where: { OR: [{ id }, { slug: id }], status: "PUBLISHED", deletedAt: null },
    });
    if (!track) throw new ApiError(404, "Titre introuvable");

    const asset = await db.audioAsset.findFirst({
      where: { trackId: track.id, kind: "MASTER", status: "READY" },
      include: { variants: { where: { kind: "WAVEFORM", status: "READY" } } },
    });
    const variant = asset?.variants[0];
    if (!variant) throw new ApiError(404, "Waveform indisponible");

    const file = await import("@/lib/storage").then((m) => m.objectBuffer(variant.storageKey));
    if (!file) throw new ApiError(404, "Fichier waveform introuvable");

    return new Response(new Uint8Array(file), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
    });
  });
}
