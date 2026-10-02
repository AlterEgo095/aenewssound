// ============================================================================
// SpotifyMapper — normalisation des réponses Spotify vers les formes
// External* (contrat src/lib/external/types.ts). Toute la tolérance aux
// réponses partielles/inattendues vit ici, nulle part ailleurs.
// ============================================================================

import type { ExternalAlbum, ExternalArtist, ExternalTrack } from "@/lib/external/types";

type RawArtist = {
  id?: string;
  name?: string;
  uri?: string;
  external_urls?: { spotify?: string };
  images?: { url: string; width: number | null }[];
  genres?: string[];
  followers?: { total?: number };
  popularity?: number;
};

type RawAlbum = {
  id?: string;
  name?: string;
  album_type?: string;
  total_tracks?: number;
  release_date?: string;
  external_urls?: { spotify?: string };
  images?: { url: string }[];
  artists?: RawArtist[];
  external_ids?: { upc?: string };
  popularity?: number;
};

type RawTrack = {
  id?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  track_number?: number;
  is_local?: boolean;
  external_urls?: { spotify?: string };
  artists?: RawArtist[];
  album?: RawAlbum;
  external_ids?: { isrc?: string };
  popularity?: number;
};

export function spotifyIdFromUri(uri: string | undefined): string | null {
  if (!uri) return null;
  const parts = uri.split(":");
  return parts.length === 3 ? parts[2] : null;
}

function pickImage(images: { url: string; width: number | null }[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url ?? null;
}

export function mapArtist(raw: RawArtist): ExternalArtist {
  if (!raw.id || !raw.name) throw new Error("Artiste Spotify incomplet (id/name manquant)");
  return {
    externalId: raw.id,
    name: raw.name,
    externalUrl: raw.external_urls?.spotify ?? null,
    imageUrl: pickImage(raw.images ?? []),
    genres: Array.isArray(raw.genres) ? raw.genres.slice(0, 8) : [],
    followers: typeof raw.followers?.total === "number" ? raw.followers.total : null,
    popularity: typeof raw.popularity === "number" ? raw.popularity : null,
  };
}

export function mapAlbumType(albumType: string | undefined): "ALBUM" | "EP" | "SINGLE" | null {
  switch (albumType) {
    case "album":
      return "ALBUM";
    case "single":
      return "SINGLE";
    case "ep":
    case "compilation":
      return "EP";
    default:
      return null;
  }
}

export function mapAlbum(raw: RawAlbum): ExternalAlbum {
  if (!raw.id || !raw.name) throw new Error("Album Spotify incomplet (id/name manquant)");
  const artist = raw.artists?.[0];
  return {
    externalId: raw.id,
    title: raw.name,
    artistExternalId: artist?.id ?? null,
    artistName: artist?.name ?? null,
    releaseDate: raw.release_date ?? null,
    trackCount: typeof raw.total_tracks === "number" ? raw.total_tracks : null,
    typeHint: mapAlbumType(raw.album_type),
    upc: raw.external_ids?.upc ?? null,
    externalUrl: raw.external_urls?.spotify ?? null,
    imageUrl: raw.images?.[0]?.url ?? null,
    popularity: typeof raw.popularity === "number" ? raw.popularity : null,
  };
}

export function mapTrack(raw: RawTrack): ExternalTrack {
  if (!raw.id || !raw.name) throw new Error("Titre Spotify incomplet (id/name manquant)");
  if (raw.is_local) throw new Error("Fichier local Spotify non importable");
  const artist = raw.artists?.[0];
  return {
    externalId: raw.id,
    title: raw.name,
    artistExternalId: artist?.id ?? null,
    artistName: artist?.name ?? null,
    albumExternalId: raw.album?.id ?? null,
    albumTitle: raw.album?.name ?? null,
    durationSeconds:
      typeof raw.duration_ms === "number" ? Math.round(raw.duration_ms / 1000) : 0,
    isrc: raw.external_ids?.isrc ?? null,
    explicit: raw.explicit === true,
    trackNumber: typeof raw.track_number === "number" ? raw.track_number : null,
    releaseDate: raw.album?.release_date ?? null,
    externalUrl: raw.external_urls?.spotify ?? null,
    popularity: typeof raw.popularity === "number" ? raw.popularity : null,
  };
}

export type { RawAlbum, RawArtist, RawTrack };
