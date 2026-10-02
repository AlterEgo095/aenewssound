// ============================================================================
// SANDBOX SPOTIFY PROVIDER — ADAPTATEUR DE DÉVELOPPEMENT, IDENTIFIÉ COMME TEL.
// (v1.1 §20 : « utiliser un adaptateur sandbox clairement identifié ; ne jamais
// présenter le sandbox comme production »)
//
// Actif UNIQUEMENT quand SPOTIFY_CLIENT_ID/SECRET sont absents. Il simule les
// réponses de l'API Spotify avec un jeu de données déterministe (métadonnées
// plausibles incluant le catalogue seedé AENEWS pour démontrer le chaînage
// recherche→association→import→sync). Les deep links utilisent l'URL de
// recherche Spotify (fonctionnels sans id réel). En production, le vrai client
// (SpotifyCatalogProvider) prend le relais — même contrat, zéro changement.
// ============================================================================

import {
  ExternalProviderError,
  type ExternalAlbum,
  type ExternalArtist,
  type ExternalCatalogProvider,
  type ExternalSearchPage,
  type ExternalSearchType,
  type ExternalTrack,
} from "@/lib/external/types";

interface SbxArtist {
  id: string;
  name: string;
  genres: string[];
  followers: number;
  popularity: number;
}

interface SbxAlbum {
  id: string;
  title: string;
  artistId: string;
  release: string;
  type: "ALBUM" | "EP" | "SINGLE";
  tracks: string[]; // ids
}

interface SbxTrack {
  id: string;
  title: string;
  artistId: string;
  albumId: string | null;
  durationSeconds: number;
  isrc: string | null;
  explicit: boolean;
  trackNumber: number;
  popularity: number;
}

const ARTISTS: SbxArtist[] = [
  { id: "sbx-art-001", name: "Koffi Nazenga", genres: ["rumba congolaise", "soukous"], followers: 48210, popularity: 64 },
  { id: "sbx-art-002", name: "Nadia Mbombo", genres: ["gospel africain", "world"], followers: 21540, popularity: 55 },
  { id: "sbx-art-003", name: "Innoss'B", genres: ["afrobeat", "dance congolaise"], followers: 812400, popularity: 78 },
  { id: "sbx-art-004", name: "Fally Ipupa", genres: ["rumba congolaise", "afrobeat"], followers: 2410000, popularity: 85 },
  { id: "sbx-art-005", name: "Dadju Kanda", genres: ["afropop"], followers: 998000, popularity: 80 },
];

const ALBUMS: SbxAlbum[] = [
  { id: "sbx-alb-100", title: "Formule Kino", artistId: "sbx-art-001", release: "2025-11-14", type: "ALBUM", tracks: ["sbx-trk-900", "sbx-trk-901", "sbx-trk-902", "sbx-trk-903"] },
  { id: "sbx-alb-101", title: "Lumière de Léo", artistId: "sbx-art-002", release: "2025-12-05", type: "EP", tracks: ["sbx-trk-905", "sbx-trk-906"] },
  { id: "sbx-alb-102", title: "Kinshasa Makasi", artistId: "sbx-art-003", release: "2024-06-21", type: "ALBUM", tracks: ["sbx-trk-910"] },
  { id: "sbx-alb-103", title: "Tokooos II Gold", artistId: "sbx-art-004", release: "2023-09-15", type: "ALBUM", tracks: ["sbx-trk-920"] },
  { id: "sbx-alb-104", title: "Ligne de Bus — Single", artistId: "sbx-art-001", release: "2025-08-01", type: "SINGLE", tracks: ["sbx-trk-901"] },
];

const TRACKS: SbxTrack[] = [
  { id: "sbx-trk-900", title: "Formule Kino", artistId: "sbx-art-001", albumId: "sbx-alb-100", durationSeconds: 214, isrc: "SBSBX2500001", explicit: false, trackNumber: 1, popularity: 61 },
  { id: "sbx-trk-901", title: "Ligne de Bus", artistId: "sbx-art-001", albumId: "sbx-alb-100", durationSeconds: 188, isrc: "SBSBX2500002", explicit: false, trackNumber: 2, popularity: 58 },
  { id: "sbx-trk-902", title: "Marché Gambela", artistId: "sbx-art-001", albumId: "sbx-alb-100", durationSeconds: 240, isrc: "SBSBX2500003", explicit: false, trackNumber: 3, popularity: 60 },
  { id: "sbx-trk-903", title: "Poids Lourd", artistId: "sbx-art-001", albumId: "sbx-alb-100", durationSeconds: 176, isrc: "SBSBX2500004", explicit: true, trackNumber: 4, popularity: 57 },
  { id: "sbx-trk-905", title: "Lumière de Léo", artistId: "sbx-art-002", albumId: "sbx-alb-101", durationSeconds: 202, isrc: "SBSBX2500006", explicit: false, trackNumber: 1, popularity: 54 },
  { id: "sbx-trk-906", title: "Espoir Matin", artistId: "sbx-art-002", albumId: "sbx-alb-101", durationSeconds: 195, isrc: "SBSBX2500007", explicit: false, trackNumber: 2, popularity: 52 },
  { id: "sbx-trk-910", title: "Kinshasa Makasi", artistId: "sbx-art-003", albumId: "sbx-alb-102", durationSeconds: 221, isrc: "SBSBX2400010", explicit: false, trackNumber: 1, popularity: 74 },
  { id: "sbx-trk-920", title: "Afrobéton", artistId: "sbx-art-004", albumId: "sbx-alb-103", durationSeconds: 233, isrc: "SBSBX2300020", explicit: true, trackNumber: 5, popularity: 83 },
];

// Deep link sandbox : URL de recherche Spotify (ouvrable réellement) — en
// production ce sont les external_urls renvoyés par l'API qui sont utilisés.
function sandboxSearchUrl(query: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function toExternalArtist(a: SbxArtist): ExternalArtist {
  return {
    externalId: a.id,
    name: a.name,
    externalUrl: sandboxSearchUrl(a.name),
    imageUrl: null,
    genres: a.genres,
    followers: a.followers,
    popularity: a.popularity,
  };
}

function toExternalAlbum(al: SbxAlbum): ExternalAlbum {
  const artist = ARTISTS.find((a) => a.id === al.artistId)!;
  return {
    externalId: al.id,
    title: al.title,
    artistExternalId: artist.id,
    artistName: artist.name,
    releaseDate: al.release,
    trackCount: al.tracks.length,
    typeHint: al.type,
    upc: null,
    externalUrl: sandboxSearchUrl(`${artist.name} ${al.title}`),
    imageUrl: null,
    popularity: Math.max(...al.tracks.map((t) => TRACKS.find((x) => x.id === t)?.popularity ?? 0), 0),
  };
}

function toExternalTrack(t: SbxTrack): ExternalTrack {
  const artist = ARTISTS.find((a) => a.id === t.artistId)!;
  const album = ALBUMS.find((a) => a.id === t.albumId);
  return {
    externalId: t.id,
    title: t.title,
    artistExternalId: artist.id,
    artistName: artist.name,
    albumExternalId: album?.id ?? null,
    albumTitle: album?.title ?? null,
    durationSeconds: t.durationSeconds,
    isrc: t.isrc,
    explicit: t.explicit,
    trackNumber: t.trackNumber,
    releaseDate: album?.release ?? null,
    externalUrl: sandboxSearchUrl(`${artist.name} ${t.title}`),
    popularity: t.popularity,
  };
}

export class SandboxSpotifyProvider implements ExternalCatalogProvider {
  readonly kind = "SPOTIFY" as const;
  readonly sandbox = true;

  async search(
    query: string,
    types: ExternalSearchType[],
    limit: number
  ): Promise<ExternalSearchPage> {
    const q = norm(query.trim());
    if (!q) return { artists: [], albums: [], tracks: [], total: 0 };
    const cap = Math.min(20, Math.max(1, limit));
    const wants = (t: ExternalSearchType) => types.length === 0 || types.includes(t);

    const artists = wants("ARTIST")
      ? ARTISTS.filter((a) => norm(a.name).includes(q)).slice(0, cap).map(toExternalArtist)
      : [];
    const albums = wants("ALBUM")
      ? ALBUMS.filter((al) => norm(al.title).includes(q) || norm(ARTISTS.find((a) => a.id === al.artistId)?.name ?? "").includes(q))
          .slice(0, cap)
          .map(toExternalAlbum)
      : [];
    const tracks = wants("TRACK")
      ? TRACKS.filter((t) => norm(t.title).includes(q) || norm(ARTISTS.find((a) => a.id === t.artistId)?.name ?? "").includes(q))
          .slice(0, cap)
          .map(toExternalTrack)
      : [];

    return { artists, albums, tracks, total: artists.length + albums.length + tracks.length };
  }

  async getArtist(externalId: string): Promise<ExternalArtist> {
    const a = ARTISTS.find((x) => x.id === externalId);
    if (!a) throw new ExternalProviderError("Artiste introuvable", "SPOTIFY", 404, false);
    return toExternalArtist(a);
  }

  async getAlbum(externalId: string): Promise<ExternalAlbum> {
    const al = ALBUMS.find((x) => x.id === externalId);
    if (!al) throw new ExternalProviderError("Album introuvable", "SPOTIFY", 404, false);
    return toExternalAlbum(al);
  }

  async getTrack(externalId: string): Promise<ExternalTrack> {
    const t = TRACKS.find((x) => x.id === externalId);
    if (!t) throw new ExternalProviderError("Titre introuvable", "SPOTIFY", 404, false);
    return toExternalTrack(t);
  }
}
