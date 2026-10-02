import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const users = await db.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { _count: { select: { payments: true, playbackSessions: true, devices: true } } },
    });
    return ok({
      users: users.map((u) => ({
        id: u.id,
        phone: u.phone.replace(/(\+\d{4})\d{3}(\d{3})/, "$1 *** $2"),
        displayName: u.displayName,
        role: u.role,
        status: u.status,
        country: u.country,
        createdAt: u.createdAt.toISOString(),
        payments: u._count.payments,
        sessions: u._count.playbackSessions,
        devices: u._count.devices,
      })),
    });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user: actor } = await requireAdmin(req);
    const body = await parseBody<{ userId?: string; action?: string }>(req);
    const userId = requireString(body.userId, "userId");
    if (!["SUSPEND", "ACTIVATE"].includes(body.action ?? "")) {
      throw new ApiError(400, "action doit valoir SUSPEND ou ACTIVATE");
    }
    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) throw new ApiError(404, "Utilisateur introuvable");
    if (target.role === "SUPER_ADMIN" && actor.role !== "SUPER_ADMIN") {
      throw new ApiError(403, "Seul un SUPER_ADMIN peut agir sur un SUPER_ADMIN");
    }

    const nextStatus = body.action === "SUSPEND" ? "SUSPENDED" : "ACTIVE";
    const updated = await db.user.update({ where: { id: userId }, data: { status: nextStatus } });
    if (nextStatus === "SUSPENDED") {
      await db.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await audit({
      actorId: actor.id,
      action: `user.${body.action?.toLowerCase()}`,
      entityType: "User",
      entityId: userId,
      before: { status: target.status },
      after: { status: nextStatus },
    });
    return ok({ userId, status: updated.status });
  });
}
