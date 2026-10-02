import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const flags = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
    return ok({
      flags: flags.map((f) => ({
        id: f.id,
        key: f.key,
        description: f.description,
        enabled: f.enabled,
        rolloutPercent: f.rolloutPercent,
        updatedAt: f.updatedAt.toISOString(),
        updatedBy: f.updatedById,
      })),
    });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const body = await parseBody<{ key?: string; enabled?: boolean }>(req);
    const key = requireString(body.key, "key", 80);
    if (typeof body.enabled !== "boolean") throw new ApiError(400, "enabled (booléen) requis");

    const flag = await db.featureFlag.findUnique({ where: { key } });
    if (!flag) throw new ApiError(404, "Flag inconnu");

    const updated = await db.featureFlag.update({
      where: { key },
      data: { enabled: body.enabled, updatedById: user.id },
    });
    await audit({
      actorId: user.id,
      action: "feature_flag.toggle",
      entityType: "FeatureFlag",
      entityId: flag.id,
      before: { enabled: flag.enabled },
      after: { enabled: updated.enabled },
    });
    return ok({ key, enabled: updated.enabled });
  });
}
