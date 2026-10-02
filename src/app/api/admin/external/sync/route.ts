import { db } from "@/lib/db";
import { ApiError, handle, ok, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { assertProviderKind } from "@/lib/external/registry";
import { isExternalEntityType } from "@/lib/external/types";
import { enqueueSyncJobs } from "@/lib/external/sync-worker";

export const dynamic = "force-dynamic";

// GET /api/admin/external/sync — file des jobs (observabilité).
export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const jobs = await db.externalSyncJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { provider: { select: { provider: true } } },
    });
    const [pending, running, done, failed] = await Promise.all([
      db.externalSyncJob.count({ where: { status: "PENDING" } }),
      db.externalSyncJob.count({ where: { status: "RUNNING" } }),
      db.externalSyncJob.count({ where: { status: "DONE" } }),
      db.externalSyncJob.count({ where: { status: "FAILED" } }),
    ]);
    return ok({
      counters: { pending, running, done, failed },
      jobs: jobs.map((j) => ({
        id: j.id,
        provider: j.provider.provider,
        identityId: j.identityId,
        entityType: j.entityType,
        entityId: j.entityId,
        operation: j.operation,
        status: j.status,
        attempts: j.attempts,
        lastError: j.lastError,
        startedAt: j.startedAt?.toISOString() ?? null,
        finishedAt: j.finishedAt?.toISOString() ?? null,
        createdAt: j.createdAt.toISOString(),
      })),
    });
  });
}

type EnqueueBody = { provider?: string; entityType?: string; entityId?: string };

// POST /api/admin/external/sync — planifie la synchronisation.
export async function POST(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const body = await parseBody<EnqueueBody>(req).catch(() => ({}) as EnqueueBody);
    const providerKind = assertProviderKind(
      (body.provider ?? "SPOTIFY").toUpperCase()
    );
    const entityType =
      body.entityType && isExternalEntityType(body.entityType) ? body.entityType : undefined;
    const result = await enqueueSyncJobs({
      provider: providerKind,
      entityType,
      entityId: body.entityId,
    });
    return ok(result);
  });
}
