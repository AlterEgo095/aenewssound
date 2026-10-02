import { handle, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { detachIdentity } from "@/lib/external/identity";

export const dynamic = "force-dynamic";

// DELETE /api/admin/external/identities/[id] — dissocier (le lien est retiré,
// l'entité AENEWS reste intacte).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const { id } = await params;
    const removed = await detachIdentity(id, user.id);
    return ok({
      detached: true,
      entityType: removed.entityType,
      entityId: removed.entityId,
      externalId: removed.externalId,
    });
  });
}
