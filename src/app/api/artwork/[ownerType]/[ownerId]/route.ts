import { db } from "@/lib/db";
import { objectBuffer } from "@/lib/storage";

export const dynamic = "force-dynamic";

// Artwork public (contenu non sensible) — cache CDN possible en production.
export async function GET(_req: Request, { params }: { params: Promise<{ ownerType: string; ownerId: string }> }) {
  const { ownerType, ownerId } = await params;
  if (!["ALBUM", "TRACK", "PLAYLIST", "ARTIST", "USER"].includes(ownerType)) {
    return new Response("Not found", { status: 404 });
  }
  const artwork = await db.artwork.findFirst({
    where: { ownerType, ownerId, isPrimary: true },
  });
  if (!artwork) return new Response("Not found", { status: 404 });
  const file = objectBuffer(artwork.storageKey);
  if (!file) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(file), {
    status: 200,
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
