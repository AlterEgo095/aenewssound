import { db } from "@/lib/db";
import { ApiError, clientIp, handle, ok, parseBody, rateLimit } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getDeviceHeaders, issueTokens, publicUser, sha256 } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Rotation des refresh tokens (v1.1 §19) :
//   1. le refresh présenté est consommé (revokedAt) et chaîné au suivant ;
//   2. toute réutilisation d'un refresh déjà consommé = compromission =>
//      reuseDetectedAt + révocation de TOUTES les sessions de l'utilisateur.
export async function POST(req: Request) {
  return handle(async () => {
    // Rate limit (10/min/IP) : chaque tentative = lookup DB — sans limite,
    // l'endpoint devient un amplificateur de DoS.
    rateLimit(`refresh:${clientIp(req)}`, 10, 60_000);
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
      // Signal fort de compromission : tracé dans l'audit (exploitable SOC).
      await audit({
        action: "auth.refresh_reuse_detected",
        entityType: "UserSession",
        entityId: session.id,
        after: { userId: session.userId, deviceId: session.deviceId },
        ip: clientIp(req),
      });
      throw new ApiError(401, "Session compromise détectée — reconnectez-vous");
    }

    if (session.expiresAt < new Date()) {
      await db.userSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      throw new ApiError(401, "Session expirée");
    }
    if (session.user.status !== "ACTIVE" || session.user.deletedAt) {
      throw new ApiError(403, "Compte désactivé");
    }

    // Consommation conditionnelle : deux refresh simultanés du même token —
    // seul le premier consomme (count===1) ; le second échoue proprement en 409
    // (au lieu d'un 500 par violation de rotatedFromId @unique).
    const consumed = await db.userSession.updateMany({
      where: { id: session.id, revokedAt: null, reuseDetectedAt: null },
      data: { revokedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new ApiError(409, "Session déjà en cours de rotation — réessayez");
    }
    const tokens = await issueTokens({
      user: session.user,
      deviceUid,
      platform,
      req,
      rotatedFromId: session.id,
    });
    await audit({
      actorId: session.userId,
      action: "auth.refresh",
      entityType: "UserSession",
      entityId: tokens.sessionId,
      after: { rotatedFrom: session.id, platform },
      ip: clientIp(req),
    });
    return ok({ user: publicUser(session.user), ...tokens });
  });
}
