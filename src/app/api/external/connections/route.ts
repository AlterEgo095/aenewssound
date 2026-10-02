import { db } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { assertProviderKind } from "@/lib/external/registry";

export const dynamic = "force-dynamic";

// GET /api/external/connections — connexions de comptes externes de
// l'utilisateur connecté. JAMAIS de token ici (chiffrés au repos, serveur only).
export async function GET(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const connections = await db.externalAccountConnection.findMany({
      where: { userId: user.id },
      include: { provider: { select: { provider: true, displayName: true, sandbox: true } } },
      orderBy: { connectedAt: "desc" },
    });
    return ok({
      connections: connections.map((c) => ({
        id: c.id,
        provider: c.provider.provider,
        providerName: c.provider.displayName,
        sandbox: c.sandbox,
        externalAccountId: c.externalAccountId,
        externalDisplayName: c.externalDisplayName,
        scopes: c.scopes,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        connectedAt: c.connectedAt.toISOString(),
      })),
    });
  });
}

// DELETE /api/external/connections?provider=SPOTIFY — déconnexion.
export async function DELETE(req: Request) {
  return handle(async () => {
    const { user } = await requireAuth(req);
    const providerKind = assertProviderKind(
      (new URL(req.url).searchParams.get("provider") ?? "SPOTIFY").toUpperCase()
    );
    const config = await db.externalProviderConfig.findUnique({ where: { provider: providerKind } });
    if (!config) return ok({ deleted: 0 });
    const result = await db.externalAccountConnection.deleteMany({
      where: { userId: user.id, providerId: config.id },
    });
    return ok({ deleted: result.count });
  });
}
