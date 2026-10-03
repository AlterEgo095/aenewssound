// ============================================================================
// YouTubeApiClient — couche HTTP pour YouTube Data API v3 (MODE PRIVÉ).
//
// Périmètre STRICTEMENT limité (décision produit « voie B », usage privé) :
//   1. RECHERCHE de vidéos musicales pour trouver la version audio d'un titre ;
//   2. LECTURE via le lecteur officiel YouTube (Iframe API) intégré à l'app.
// AUCUNE extraction de flux (yt-dlp/ytdl/…) : c'est interdit par les CGU
// YouTube et ce serait une dette technique + juridique inacceptable.
//
// Config : YOUTUBE_API_KEY (Google Cloud → YouTube Data API v3 → clé API).
// Absente → le service échoue fermé (503 explicite), jamais de données simulées.
//
// Quota (gratuit) : 10 000 unités/jour, une recherche coûte 100 unités
// (+ 1 pour videos.list). D'où : cache mémoire 30 min + limiter local.
// ============================================================================

import { ExternalProviderError } from "@/lib/external/types";
import { TokenBucketLimiter } from "@/lib/external/rate-limit";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 1;

export type YoutubeVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string | null;
  durationText: string | null; // "3:25" (converti depuis ISO-8601 PT3M25S)
  publishedAt: string | null;
};

export function youtubeApiKeyFromEnv(): string | null {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || key.trim().length === 0) return null; // pas de clé en dur — jamais
  return key.trim();
}

function iso8601DurationToText(iso: string): string {
  // PT3M25S / PT1H2M3S → "3:25" / "1:02:03"
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return "";
  const h = Number(match[1] ?? 0);
  const m = Number(match[2] ?? 0);
  const s = Number(match[3] ?? 0);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type SearchResponse = {
  items?: { id?: { videoId?: string }; snippet?: Record<string, unknown> }[];
};
type VideosResponse = {
  items?: {
    id?: string;
    contentDetails?: { duration?: string };
    snippet?: Record<string, unknown>;
  }[];
};

export class YoutubeApiClient {
  private limiter = new TokenBucketLimiter(4, 2); // quota journalier côté Google : restons doux
  private cache = new Map<string, { at: number; videos: YoutubeVideo[] }>();
  private static CACHE_TTL_MS = 30 * 60 * 1000;

  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("key", this.apiKey);

    let res: Response;
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      try {
        res = await fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        if (attempt < MAX_RETRIES) continue;
        throw new ExternalProviderError(
          `YouTube injoignable : ${e instanceof Error ? e.message : "erreur réseau"}`,
          "YOUTUBE_MUSIC",
          undefined,
          true
        );
      }

      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(5, retryAfter) * 1000));
        continue;
      }
      break;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      // Google renvoie parfois une page HTML d'erreur : jamais exposée telle quelle.
      const isHtml = raw.trimStart().startsWith("<");
      const body = isHtml ? "" : raw.slice(0, 300);
      const hint =
        res.status === 400 || res.status === 403
          ? " — clé API invalide, quota journalier épuisé ou YouTube Data API v3 non activée sur le projet Google Cloud"
          : res.status === 404
            ? " — clé API invalide ou YouTube Data API v3 non activée sur le projet Google Cloud"
            : "";
      throw new ExternalProviderError(
        `YouTube Data API ${res.status}${hint}${body ? ` : ${body}` : ""}`,
        "YOUTUBE_MUSIC",
        res.status,
        res.status >= 500
      );
    }
    return (await res.json()) as T;
  }

  /** Recherche de vidéos musicales INTEGRABLES (lecteur officiel uniquement). */
  async searchVideos(query: string, limit = 8): Promise<YoutubeVideo[]> {
    const cacheKey = `${query}::${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < YoutubeApiClient.CACHE_TTL_MS) {
      return cached.videos;
    }

    const search = await this.request<SearchResponse>("search", {
      part: "snippet",
      type: "video",
      videoCategoryId: "10", // Music
      videoEmbeddable: "true", // exclut d'emblée les vidéos interdites d'intégration
      q: query,
      maxResults: String(Math.min(25, Math.max(1, limit))),
    });

    const found = (search.items ?? [])
      .map((item) => ({
        videoId: item.id?.videoId ?? "",
        snippet: item.snippet ?? {},
      }))
      .filter((v) => v.videoId.length > 0);
    if (found.length === 0) {
      this.cache.set(cacheKey, { at: Date.now(), videos: [] });
      return [];
    }

    // videos.list coûte 1 unité : durées exactes (évite les lives de 3 h dans le picker).
    const details = await this.request<VideosResponse>("videos", {
      part: "contentDetails",
      id: found.map((f) => f.videoId).join(","),
    });
    const durations = new Map<string, string>();
    for (const item of details.items ?? []) {
      if (item.id && item.contentDetails?.duration) {
        durations.set(item.id, iso8601DurationToText(item.contentDetails.duration));
      }
    }

    const videos: YoutubeVideo[] = found.map((f) => {
      const snippet = f.snippet as {
        title?: string;
        channelTitle?: string;
        publishedAt?: string;
        thumbnails?: Record<string, { url?: string }>;
      };
      const thumb =
        snippet.thumbnails?.medium?.url ??
        snippet.thumbnails?.default?.url ??
        snippet.thumbnails?.high?.url ??
        null;
      return {
        videoId: f.videoId,
        title: typeof snippet.title === "string" ? snippet.title : f.videoId,
        channelTitle: typeof snippet.channelTitle === "string" ? snippet.channelTitle : "",
        thumbnailUrl: thumb,
        durationText: durations.get(f.videoId) ?? null,
        publishedAt: typeof snippet.publishedAt === "string" ? snippet.publishedAt : null,
      };
    });

    this.cache.set(cacheKey, { at: Date.now(), videos });
    return videos;
  }
}
