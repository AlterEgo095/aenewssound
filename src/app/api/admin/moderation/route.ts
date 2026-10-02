import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { trackDTO } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const pendingTracks = await db.track.findMany({
      where: { status: { in: ["PENDING_REVIEW", "IN_REVIEW"] } },
      include: { mainArtist: true, album: true },
      orderBy: { createdAt: "asc" },
    });
    const reports = await db.moderationReport.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    return ok({
      queue: pendingTracks.map((t) => {
        const report = reports.find((r) => r.subjectType === "TRACK" && r.subjectId === t.id);
        return {
          reportId: report?.id ?? null,
          reason: report?.reason ?? null,
          details: report?.details ?? null,
          submittedAt: t.createdAt.toISOString(),
          track: trackDTO(t),
        };
      }),
    });
  });
}

// POST — décision de modération : APPROVED => publication, TAKEDOWN => blocage.
export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const body = await parseBody<{ trackId?: string; outcome?: string; note?: string }>(req);
    const trackId = requireString(body.trackId, "trackId");
    const outcome = body.outcome === "TAKEDOWN" ? "TAKEDOWN" : body.outcome === "APPROVED" ? "APPROVED" : null;
    if (!outcome) throw new ApiError(400, "outcome doit valoir APPROVED ou TAKEDOWN");

    const track = await db.track.findUnique({ where: { id: trackId } });
    if (!track) throw new ApiError(404, "Titre introuvable");

    const updated = await db.track.update({
      where: { id: trackId },
      data:
        outcome === "APPROVED"
          ? { status: "PUBLISHED", publishedAt: track.publishedAt ?? new Date() }
          : { status: "BLOCKED" },
    });

    await db.moderationReport.updateMany({
      where: { subjectType: "TRACK", subjectId: trackId, status: "PENDING" },
      data: {
        status: "RESOLVED",
        outcome,
        resolutionNote: body.note ?? null,
        assignedToId: user.id,
        resolvedAt: new Date(),
      },
    });
    if (outcome === "TAKEDOWN") {
      await db.track.update({ where: { id: trackId }, data: { status: "BLOCKED" } });
      await db.right.updateMany({
        where: { trackId, status: "ACTIVE" },
        data: { status: "SUSPENDED" },
      });
    } else {
      await db.right.updateMany({
        where: { trackId, status: "DRAFT" },
        data: { status: "ACTIVE" },
      });
    }

    await audit({
      actorId: user.id,
      action: outcome === "APPROVED" ? "moderation.approve" : "moderation.takedown",
      entityType: "Track",
      entityId: trackId,
      before: { status: track.status },
      after: { status: updated.status, note: body.note ?? null },
    });

    return ok({ trackId, status: updated.status });
  });
}
