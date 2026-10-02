import { ApiError, handle, ok, parseBody, requireString } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { assertProviderKind, getProviderConfig, requireEnabledProvider } from "@/lib/external/registry";
import { isExternalEntityType } from "@/lib/external/types";
import { attachIdentity, listIdentities } from "@/lib/external/identity";

export const dynamic = "force-dynamic";

// GET /api/admin/external/identities?provider=&entityType=&entityId=
export async function GET(req: Request) {
  return handle(async () => {
    await requireAdmin(req);
    const url = new URL(req.url);
    const providerParam = url.searchParams.get("provider");
    const entityTypeParam = url.searchParams.get("entityType");
    const entityId = url.searchParams.get("entityId") ?? undefined;
    const identities = await listIdentities({
      provider: providerParam ? assertProviderKind(providerParam.toUpperCase()) : undefined,
      entityType:
        entityTypeParam && isExternalEntityType(entityTypeParam) ? entityTypeParam : undefined,
      entityId,
    });
    return ok({ identities });
  });
}

type AttachBody = {
  provider?: string;
  entityType?: string;
  entityId?: string;
  externalId?: string;
  externalUrl?: string;
  metadata?: unknown;
};

// POST /api/admin/external/identities — associer manuellement un objet externe
// à un objet AENEWS existant (Source externe → Associer).
export async function POST(req: Request) {
  return handle(async () => {
    const { user } = await requireAdmin(req);
    const body = await parseBody<AttachBody>(req);
    const providerKind = assertProviderKind(requireString(body.provider, "provider").toUpperCase());
    const entityTypeParam = requireString(body.entityType, "entityType").toUpperCase();
    if (!isExternalEntityType(entityTypeParam)) {
      throw new ApiError(400, "entityType doit être ARTIST, ALBUM ou TRACK");
    }
    const entityId = requireString(body.entityId, "entityId");
    const externalId = requireString(body.externalId, "externalId");

    const config = await getProviderConfig(providerKind);
    if (!config) throw new ApiError(404, "Fournisseur inconnu");
    await requireEnabledProvider(providerKind);

    const identity = await attachIdentity({
      provider: providerKind,
      providerId: config.id,
      entityType: entityTypeParam,
      entityId,
      externalId,
      externalUrl: body.externalUrl ?? null,
      metadata: body.metadata ?? null,
      actorId: user.id,
    });
    return ok({
      identity: {
        id: identity.id,
        provider: providerKind,
        entityType: identity.entityType,
        entityId: identity.entityId,
        externalId: identity.externalId,
      },
    });
  });
}
