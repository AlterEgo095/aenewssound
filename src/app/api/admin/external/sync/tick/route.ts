import { handle, ok, parseBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { processPendingJobs } from "@/lib/external/sync-worker";

export const dynamic = "force-dynamic";

// POST /api/admin/external/sync/tick — exécute le worker in-process (un lot).
// Production : appelé par le scheduler BullMQ ; ici déclenchable depuis
// l'administration et après chaque planification (worker visible, pas caché).
export async function POST(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const body = await parseBody<{ max?: number }>(req).catch(() => ({}) as { max?: number });
    const max = Math.min(25, Math.max(1, Number(body.max ?? 10)));
    const result = await processPendingJobs(max);
    return ok(result);
  });
}
