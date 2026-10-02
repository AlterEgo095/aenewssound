import { ApiError, handle } from "@/lib/api";
import { db } from "@/lib/db";
import { contentTypeForKey, objectBuffer } from "@/lib/storage";

export const dynamic = "force-dynamic";

// Artwork public (contenu non sensible) — cache CDN possible en production.
// Standardisé (audit v1.1) : passage par handle() (erreurs JSON uniformes),
// content-type dérivé du storageKey réel (plus de SVG codé en dur), et CSP
// stricte sur les images (un SVG non sanitisé reste un vecteur XSS latent).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ownerType: string; ownerId: string }> }
) {
  return handle(async () => {
    const { ownerType, ownerId } = await params;
    if (!["ALBUM", "TRACK", "PLAYLIST", "ARTIST", "USER"].includes(ownerType)) {
      throw new ApiError(404, "Artwork introuvable", "NOT_FOUND");
    }
    const artwork = await db.artwork.findFirst({
      where: { ownerType, ownerId, isPrimary: true },
    });
    if (!artwork) throw new ApiError(404, "Artwork introuvable", "NOT_FOUND");
    const file = objectBuffer(artwork.storageKey);
    if (!file) throw new ApiError(404, "Artwork introuvable", "NOT_FOUND");

    // Les artworks actuels sont des SVG générés par le seed ; le jour d'un
    // upload utilisateur, cette CSP empêche tout script inline d'un SVG.
    return new Response(new Uint8Array(file), {
      status: 200,
      headers: {
        "content-type": contentTypeForKey(artwork.storageKey),
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });
}
