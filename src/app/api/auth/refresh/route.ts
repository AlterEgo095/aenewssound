import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody } from "@/lib/api";
import { getDeviceHeaders, issueTokens, publicUser, sha256 } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Rotation des refresh tokens (v1.1 §19) :
//   1. le refresh présenté est consommé (revokedAt) et chaîné au suivant ;
//   2. toute réutilisation d'un refresh déjà consommé = compromission =>
//      reuseDetectedAt + révocation de TOUTES les sessions de l'utilisateur.
export async function POST(req: Request) {
  return handle(async () => {
    const body = await parseBody<{ refreshToken?: string }>(req);
    if (!body.refreshToken) throw new ApiError(400, "refreshToken requis");
    const { deviceUid, platform } = getDeviceHeaders(req);

    const session = await db.userSession.findUnique({
      where: { refreshHash: sha256(body.refreshToken) },
      include: { user: true },
    });
    if (!session) throw new ApiError(401, "Session invalide");

    if (session.reuseDetectedAt || session.revokedAt) {
      // Rejeu d'un token déjà consommé ou révoqué : on coupe la famille entière.
      await db.userSession.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!session.reuseDetectedAt) {
        await db.userSession.update({
          where: { id: session.id },
          data: { reuseDetectedAt: new Date() },
        });
      }
      throw new ApiError(401, "Session compromise détectée — reconnectez-vous");
    }

    if (session.expiresAt < new Date()) {
      await db.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      throw new ApiError(401, "Session expirée");
    }
    if (session.user.status !== "ACTIVE" || session.user.deletedAt) {
      throw new ApiError(403, "Compte désactivé");
    }

    await db.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    const tokens = await issueTokens({
      user: session.user,
      deviceUid,
      platform,
      req,
      rotatedFromId: session.id,
    });
    return ok({ user: publicUser(session.user), ...tokens });
  });
}
