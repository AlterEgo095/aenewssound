import { db } from "@/lib/db";
import { ApiError, clientIp, handle, ok, parseBody, rateLimit, requirePhone, requireString } from "@/lib/api";
import { getDeviceHeaders, issueTokens, publicUser, verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    rateLimit(`login:${clientIp(req)}`, 10, 60_000);
    const body = await parseBody<{ phone?: string; password?: string }>(req);
    const phone = requirePhone(body.phone);
    const password = requireString(body.password, "password", 128);
    const { deviceUid, platform } = getDeviceHeaders(req);

    const user = await db.user.findUnique({ where: { phone } });
    // Message volontairement identique pour téléphone inconnu / mot de passe faux.
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new ApiError(401, "Téléphone ou mot de passe incorrect");
    }
    if (user.status !== "ACTIVE" || user.deletedAt) {
      throw new ApiError(403, "Compte désactivé — contactez le support");
    }

    const tokens = await issueTokens({ user, deviceUid, platform, req });
    return ok({ user: publicUser(user), ...tokens });
  });
}
