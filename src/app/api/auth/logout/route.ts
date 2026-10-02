import { db } from "@/lib/db";
import { handle, ok, parseBody } from "@/lib/api";
import { requireAuth, sha256 } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const body = await parseBody<{ refreshToken?: string }>(req);
    if (body.refreshToken) {
      await db.userSession.updateMany({
        where: { userId: user.id, refreshHash: sha256(body.refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return ok({ success: true });
  });
}
