import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { requireEntitlement } from "@/lib/entitlements";
import { signStreamUrl } from "@/lib/signed-url";
import { DOWNLOAD_URL_TTL_SECONDS } from "@/lib/config";
import { trackDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

// GET — bibliothèque offline de l'utilisateur.
// ?refreshTrackId=<id> : re-validation de licence + nouvelle URL signée.
export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const refreshTrackId = new URL(req.url).searchParams.get("refreshTrackId");

    const downloads = await db.download.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      include: {
        track: {
          include: {
            mainArtist: true,
            album: true,
            audioAssets: {
              where: { status: "READY" },
              include: { variants: { where: { kind: "PROGRESSIVE_128K", status: "READY" }, take: 1 } },
            },
          },
        },
      },
    });

    const now = new Date();
    const items: Array<{
      id: string;
      status: string;
      licenseExpiresAt: string | null;
      lastValidatedAt: string | null;
      freshUrl: string | null;
      track: ReturnType<typeof trackDTO>;
    }> = [];
    for (const d of downloads) {
      const expired = d.status === "EXPIRED" || (d.licenseExpiresAt && d.licenseExpiresAt < now);
      if (expired && d.status === "READY") {
        await db.download.update({ where: { id: d.id }, data: { status: "EXPIRED" } });
      }
      let freshUrl: string | null = null;
      if (!expired && d.status === "READY" && d.trackId === refreshTrackId) {
        // Clé RÉELLE en base (même source que le POST) : plus de reconstruction
        // de convention de chemin qui peut dévier du stockage réel.
        const variant = d.track.audioAssets.flatMap((a) => a.variants)[0];
        freshUrl = variant
          ? signStreamUrl(variant.storageKey, DOWNLOAD_URL_TTL_SECONDS)
          : null;
      }
      items.push({
        id: d.id,
        status: expired ? "EXPIRED" : d.status,
        licenseExpiresAt: d.licenseExpiresAt?.toISOString() ?? null,
        lastValidatedAt: d.lastValidatedAt?.toISOString() ?? null,
        freshUrl,
        track: trackDTO(d.track),
      });
    }
    return ok({ downloads: items });
  });
}

// POST — demande de téléchargement offline (réservée premium, v1.1 §7).
export async function POST(req: Request) {
  return handle(async () => {
    const { user, payload } = await requireAuth(req);
    const body = await parseBody<{ trackId?: string }>(req);
    const trackId = requireString(body.trackId, "trackId");

    const flag = await db.featureFlag.findUnique({ where: { key: "premium_downloads_enabled" } });
    if (flag && !flag.enabled) {
      throw new ApiError(403, "Les téléchargements sont temporairement désactivés");
    }

    // SOURCE UNIQUE DE VÉRITÉ : Entitlement (jamais Payment) — règle 1.
    const entitlementState = await requireEntitlement(user.id);
    const entitlement = await db.entitlement.findFirst({
      where: { userId: user.id, status: "ACTIVE", expiresAt: entitlementState.premiumUntil ?? undefined },
      orderBy: { expiresAt: "desc" },
    });

    const track = await db.track.findFirst({
      where: { id: trackId, status: "PUBLISHED", deletedAt: null },
      include: { rights: { where: { kind: "OWNERSHIP", status: "ACTIVE" } } },
    });
    if (!track) throw new ApiError(404, "Titre introuvable");
    const right = track.rights[0];
    if (!right || !right.downloadAllowed) {
      throw new ApiError(451, "Téléchargement non autorisé pour ce titre (droits)");
    }

    const asset = await db.audioAsset.findFirst({
      where: { trackId: track.id, kind: "MASTER", status: "READY" },
      include: { variants: { where: { kind: "PROGRESSIVE_128K", status: "READY" } } },
    });
    if (!asset || asset.variants.length === 0) {
      throw new ApiError(409, "Média non prêt au téléchargement");
    }

    const licenseExpiresAt = entitlementState.premiumUntil ?? new Date();
    const download = await db.download.upsert({
      where: { userId_deviceId_trackId: { userId: user.id, deviceId: payload.deviceId, trackId } },
      update: {
        status: "READY",
        licenseExpiresAt,
        lastValidatedAt: new Date(),
        revokedAt: null,
        entitlementId: entitlement?.id ?? null,
      },
      create: {
        userId: user.id,
        deviceId: payload.deviceId,
        trackId,
        entitlementId: entitlement?.id ?? null,
        status: "READY",
        licenseExpiresAt,
        lastValidatedAt: new Date(),
        sizeBytes: asset.sizeBytes,
      },
    });

    return ok(
      {
        downloadId: download.id,
        status: download.status,
        licenseExpiresAt: licenseExpiresAt.toISOString(),
        signedUrl: signStreamUrl(asset.variants[0].storageKey, DOWNLOAD_URL_TTL_SECONDS),
        expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      },
      201
    );
  });
}
