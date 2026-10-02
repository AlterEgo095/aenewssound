import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const flags = await db.fraudFlag.findMany({
      orderBy: { detectedAt: "desc" },
      take: 60,
      include: { reviews: { include: { reviewer: true } } },
    });
    return ok({
      flags: flags.map((f) => ({
        id: f.id,
        subjectType: f.subjectType,
        subjectId: f.subjectId,
        rule: f.rule,
        severity: f.severity,
        score: f.score,
        evidence: f.evidence ? (JSON.parse(f.evidence) as Record<string, unknown>) : null,
        status: f.status,
        relatedUserId: f.relatedUserId,
        relatedSessionId: f.relatedSessionId,
        detectedAt: f.detectedAt.toISOString(),
        resolvedAt: f.resolvedAt?.toISOString() ?? null,
        reviews: f.reviews.map((r) => ({
          reviewer: r.reviewer.displayName,
          decision: r.decision,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
        })),
      })),
    });
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const body = await parseBody<{ flagId?: string; decision?: string; note?: string }>(req);
    const flagId = requireString(body.flagId, "flagId");
    if (!["CONFIRM", "DISMISS", "ESCALATE"].includes(body.decision ?? "")) {
      throw new ApiError(400, "decision invalide (CONFIRM|DISMISS|ESCALATE)");
    }
    const decision = body.decision!;
    const flag = await db.fraudFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw new ApiError(404, "Flag introuvable");

    await db.fraudReview.create({
      data: { flagId, reviewerId: user.id, decision, note: body.note ?? null },
    });

    const nextStatus =
      decision === "CONFIRM" ? "CONFIRMED" : decision === "DISMISS" ? "DISMISSED" : flag.status;
    await db.fraudFlag.update({
      where: { id: flagId },
      data: {
        status: nextStatus,
        reviewedAt: new Date(),
        resolvedAt: decision === "ESCALATE" ? null : new Date(),
      },
    });

    await audit({
      actorId: user.id,
      action: `fraud.${decision.toLowerCase()}`,
      entityType: "FraudFlag",
      entityId: flagId,
      before: { status: flag.status },
      after: { status: nextStatus, note: body.note ?? null },
    });
    return ok({ flagId, status: nextStatus });
  });
}
