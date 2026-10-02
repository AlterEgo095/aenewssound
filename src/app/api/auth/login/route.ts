import { db } from "@/lib/db";
import { ApiError, clientIp, handle, ok, parseBody, rateLimit, requirePhone, requireString } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getDeviceHeaders, hashPassword, issueTokens, publicUser, verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Hash factice : vérifié quand le téléphone est inconnu pour que le temps de
// réponse soit indistinguable d'un mauvais mot de passe (anti-énumération timing).
const DUMMY_HASH = hashPassword("aenews-timing-equalizer");

export async function POST(req: Request) {
  return handle(async () => {
    rateLimit(`login:${clientIp(req)}`, 10, 60_000);
    const body = await parseBody<{ phone?: string; password?: string }>(req);
    const phone = requirePhone(body.phone);
    const password = requireString(body.password, "password", 128);
    const { deviceUid, platform } = getDeviceHeaders(req);

    const user = await db.user.findUnique({ where: { phone } });
    if (!user) {
      // Coût de calcul identique à un vrai scrypt (anti-énumération par timing),
      // message identique à un mauvais mot de passe.
      verifyPassword(password, DUMMY_HASH);
      throw new ApiError(401, "Téléphone ou mot de passe incorrect");
    }
    if (!verifyPassword(password, user.passwordHash)) {
      throw new ApiError(401, "Téléphone ou mot de passe incorrect");
    }
    if (user.status !== "ACTIVE" || user.deletedAt) {
      throw new ApiError(403, "Compte désactivé — contactez le support");
    }

    const tokens = await issueTokens({ user, deviceUid, platform, req });
    await audit({
      actorId: user.id,
      action: "auth.login",
      entityType: "User",
      entityId: user.id,
      after: { platform, deviceId: tokens.deviceId },
      ip: clientIp(req),
    });
    return ok({ user: publicUser(user), ...tokens });
  });
}
