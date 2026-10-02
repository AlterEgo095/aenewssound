import { ApiError, handle } from "@/lib/api";
import { verifySignedUrl } from "@/lib/signed-url";
import { contentTypeForKey, objectPath } from "@/lib/storage";
import fs from "fs";
import { Readable } from "stream";

export const dynamic = "force-dynamic";

// GET /api/stream?p=…&sig=… — diffusion du média via URL signée (v1.1 §19).
// Support Range (206) pour le seek audio dans le navigateur.
//
// Streaming réel (audit v1.1) : le fichier est lu en FLUX (createReadStream)
// borné au Range demandé — plus jamais une lecture complète du fichier en
// mémoire à chaque requête/chunk (amplification mémoire ×N sur un service
// de streaming). Cache interdit (private, no-store) sur 200 comme sur 206.
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
    const baseHeaders: Record<string, string> = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
    };

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      // Suffix range (bytes=-N) : les N derniers octets — interprété ici
      // comme un start explicite pour rester sémantiquement correct.
      let start = match?.[1] ? parseInt(match[1], 10) : 0;
      let end = match?.[2] ? Math.min(parseInt(match[2], 10), stat.size - 1) : stat.size - 1;
      if (match && !match[1] && match[2]) {
        // suffix range : bytes=-N → [size-N, size-1]
        const suffix = parseInt(match[2], 10);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      }
      if (start >= stat.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${stat.size}` },
        });
      }
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${stat.size}`,
        },
      });
    }

    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 200,
      headers: {
        ...baseHeaders,
        "content-length": String(stat.size),
      },
    });
  });
}
