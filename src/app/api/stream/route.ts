import { ApiError, handle } from "@/lib/api";
import { verifySignedUrl } from "@/lib/signed-url";
import { contentTypeForKey, objectPath } from "@/lib/storage";
import fs from "fs";

export const dynamic = "force-dynamic";

// GET /api/stream?p=…&sig=… — diffusion du média via URL signée (v1.1 §19).
// Support Range (206) pour le seek audio dans le navigateur.
export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const payload = url.searchParams.get("p");
    const signature = url.searchParams.get("sig");
    if (!payload || !signature) throw new ApiError(400, "URL signée incomplète");

    const verified = verifySignedUrl(payload, signature);
    if (!verified) throw new ApiError(403, "URL signée invalide ou expirée");

    const filePath = objectPath(verified.key);
    if (!filePath) throw new ApiError(404, "Média introuvable");

    const stat = fs.statSync(filePath);
    const contentType = contentTypeForKey(verified.key);
    const range = req.headers.get("range");

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? parseInt(match[1], 10) : 0;
      const end = match?.[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${stat.size}` },
        });
      }
      const buffer = fs.readFileSync(filePath).subarray(start, end + 1);
      return new Response(new Uint8Array(buffer), {
        status: 206,
        headers: {
          "content-type": contentType,
          "content-length": String(buffer.length),
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
        },
      });
    }

    const buffer = fs.readFileSync(filePath);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(stat.size),
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
      },
    });
  });
}
