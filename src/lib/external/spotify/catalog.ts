// ============================================================================
// SpotifyCatalogProvider — implémentation SPOTIFY de ExternalCatalogProvider.
// Compose : SpotifyApiClient (HTTP) + mapper (normalisation) + cache (TTL par
// type) + rate limiter. Les controllers/services n'importent QUE cette classe
// via le registry, jamais le client HTTP direct.
// ============================================================================

import { cached, DEFAULT_TTL_SECONDS } from "@/lib/external/cache";
import {
  ExternalProviderError,
  type ExternalAlbum,
  type ExternalArtist,
  type ExternalCatalogProvider,
  type ExternalSearchPage,
  type ExternalTrack,
  type ExternalSearchType,
} from "@/lib/external/types";
import { SpotifyApiClient } from "./api";
import { mapAlbum, mapArtist, mapTrack, type RawAlbum, type RawArtist, type RawTrack } from "./mapper";

type SearchResponse = {
  artists?: { items?: RawArtist[]; total?: number };
  albums?: { items?: RawAlbum[]; total?: number };
  tracks?: { items?: RawTrack[]; total?: number };
};

export class SpotifyCatalogProvider implements ExternalCatalogProvider {
  readonly kind = "SPOTIFY" as const;
  readonly sandbox = false;

  constructor(private readonly client: SpotifyApiClient) {}

  async search(
    query: string,
    types: ExternalSearchType[],
    limit: number
  ): Promise<ExternalSearchPage> {
    if (!query.trim()) {
      return { artists: [], albums: [], tracks: [], total: 0 };
    }
    const typeParam = types.length > 0 ? types.join(",") : "artist,album,track";
    return cached(
      `spotify:search:${typeParam}:${limit}:${query.trim().toLowerCase()}`,
      DEFAULT_TTL_SECONDS.SEARCH,
      async () => {
        const raw = await this.client.request<SearchResponse>("GET", "/search", {
          q: query,
          type: typeParam,
          limit: String(Math.min(20, Math.max(1, limit))),
        });
        const page: ExternalSearchPage = { artists: [], albums: [], tracks: [], total: null };
        for (const item of raw.artists?.items ?? []) {
          try {
            page.artists.push(mapArtist(item));
          } catch {
            /* item partiel — ignoré, la suite reste exploitable */
          }
        }
        for (const item of raw.albums?.items ?? []) {
          try {
            page.albums.push(mapAlbum(item));
          } catch {
            /* ignoré */
          }
        }
        for (const item of raw.tracks?.items ?? []) {
          try {
            page.tracks.push(mapTrack(item));
          } catch {
            /* ignoré */
          }
        }
        page.total =
          (raw.artists?.total ?? 0) + (raw.albums?.total ?? 0) + (raw.tracks?.total ?? 0) || null;
        return page;
      }
    );
  }

  async getArtist(externalId: string): Promise<ExternalArtist> {
    return cached(
      `spotify:artist:${externalId}`,
      DEFAULT_TTL_SECONDS.ARTIST,
      async () => {
        const raw = await this.client.request<RawArtist>("GET", `/artists/${encodeURIComponent(externalId)}`);
        return mapArtist(raw);
      }
    );
  }

  async getAlbum(externalId: string): Promise<ExternalAlbum> {
    return cached(
      `spotify:album:${externalId}`,
      DEFAULT_TTL_SECONDS.ALBUM,
      async () => {
        const raw = await this.client.request<RawAlbum>("GET", `/albums/${encodeURIComponent(externalId)}`);
        return mapAlbum(raw);
      }
    );
  }

  async getTrack(externalId: string): Promise<ExternalTrack> {
    return cached(
      `spotify:track:${externalId}`,
      DEFAULT_TTL_SECONDS.TRACK,
      async () => {
        const raw = await this.client.request<RawTrack>("GET", `/tracks/${encodeURIComponent(externalId)}`);
        return mapTrack(raw);
      }
    );
  }
}

export { ExternalProviderError };
