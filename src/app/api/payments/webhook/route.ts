import { ApiError, clientIp, handle, ok } from "@/lib/api";
import { processWebhook } from "@/lib/payments";

export const dynamic = "force-dynamic";

// POST /api/payments/webhook — endpoint réellement appelé par les agrégateurs.
// Signature : en-tête X-Aenews-Signature = HMAC-SHA256(base64url, corps brut).
// Tout callback est persisté (WebhookEvent), idempotent par (provider, eventId),
// et la signature invalide est tracée puis rejetée (v1.1 §19/§27).
export async function POST(req: Request) {
  return handle(async () => {
    const rawBody = await req.text();
    if (!rawBody) throw new ApiError(400, "Corps webhook vide");
    const signature = req.headers.get("x-aenews-signature");
    if (!signature) throw new ApiError(400, "En-tête X-Aenews-Signature requis");

    let providerCode: string;
    try {
      providerCode = (JSON.parse(rawBody) as { provider?: string }).provider ?? "SANDBOX";
    } catch {
      throw new ApiError(400, "Corps webhook non JSON");
    }

    const result = await processWebhook({
      providerCode,
      rawBody,
      signature,
      ip: clientIp(req),
    });
    return ok({ received: true, ...result });
  });
}
