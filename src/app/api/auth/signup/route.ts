import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, rateLimit, clientIp, requirePhone, requireString } from "@/lib/api";
import { getDeviceHeaders, hashPassword, issueTokens, publicUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    rateLimit(`signup:${clientIp(req)}`, 10, 60_000);
    const body = await parseBody<{ phone?: string; password?: string; displayName?: string; country?: string }>(req);
    const phone = requirePhone(body.phone);
    const password = requireString(body.password, "password", 128);
    if (password.length < 8) throw new ApiError(400, "Le mot de passe doit contenir au moins 8 caractères");
    const displayName = requireString(body.displayName, "displayName", 60);
    const { deviceUid, platform } = getDeviceHeaders(req);

    const existing = await db.user.findUnique({ where: { phone } });
    if (existing) throw new ApiError(409, "Un compte existe déjà avec ce numéro");

    const user = await db.user.create({
      data: {
        phone,
        displayName,
        passwordHash: hashPassword(password),
        role: "USER",
        status: "ACTIVE",
        locale: "fr",
        country: typeof body.country === "string" && body.country.length === 2 ? body.country.toUpperCase() : null,
      },
    });

    const tokens = await issueTokens({ user, deviceUid, platform, req });
    return ok({ user: publicUser(user), ...tokens }, 201);
  });
}
