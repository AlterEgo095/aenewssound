// ============================================================================
// AENEWS SOUND — Contrat multi-fournisseurs externes (Spotify, Apple Music,
// YouTube Music, Deezer, Audiomack…). Le cœur métier AENEWS ne dépend d'aucune
// implémentation spécifique : tout consommateur code contre ces interfaces.
//
// RÈGLE ARCHITECTURALE ABSOLUE (v1.1 §2) :
//   Un provider externe fournit MÉTADONNÉES + IDENTITÉS + LIENS — jamais de
//   l'audio. AENEWS SOUND garde son propre pipeline audio et ses propres droits.
// ============================================================================

export const PROVIDER_KINDS = [
  "SPOTIFY",
  "APPLE_MUSIC",
  "YOUTUBE_MUSIC",
  "DEEZER",
  "AUDIOMACK",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const EXTERNAL_ENTITY_TYPES = ["ARTIST", "ALBUM", "TRACK"] as const;
export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

export type ExternalSearchType = ExternalEntityType | "PLAYLIST";

// ---------------------------------------------------------------------------
// Objets normalisés — formes identiques quel que soit le fournisseur
// ---------------------------------------------------------------------------

export interface ExternalArtist {
  externalId: string;
  name: string;
  externalUrl: string | null;
  imageUrl: string | null;
  genres: string[];
  followers: number | null;
  popularity: number | null;
}

export interface ExternalAlbum {
  externalId: string;
  title: string;
  artistExternalId: string | null;
  artistName: string | null;
  releaseDate: string | null; // ISO yyyy-mm-dd
  trackCount: number | null;
  typeHint: "ALBUM" | "EP" | "SINGLE" | null;
  upc: string | null;
  externalUrl: string | null;
  imageUrl: string | null;
  popularity: number | null;
}

export interface ExternalTrack {
  externalId: string;
  title: string;
  artistExternalId: string | null;
  artistName: string | null;
  albumExternalId: string | null;
  albumTitle: string | null;
  durationSeconds: number;
  isrc: string | null;
  explicit: boolean;
  trackNumber: number | null;
  releaseDate: string | null;
  externalUrl: string | null;
  popularity: number | null;
}

export interface ExternalSearchPage {
  artists: ExternalArtist[];
  albums: ExternalAlbum[];
  tracks: ExternalTrack[];
  total: number | null;
}

// ---------------------------------------------------------------------------
// Interface provider — toute intégration future (Apple Music, YouTube…)
// implémente exactement ce contrat, sans toucher au cœur du catalogue.
// ---------------------------------------------------------------------------

export interface ExternalCatalogProvider {
  readonly kind: ProviderKind;
  /** true = adaptateur de développement identifié, pas un accès production */
  readonly sandbox: boolean;
  search(query: string, types: ExternalSearchType[], limit: number): Promise<ExternalSearchPage>;
  getArtist(externalId: string): Promise<ExternalArtist>;
  getAlbum(externalId: string): Promise<ExternalAlbum>;
  getTrack(externalId: string): Promise<ExternalTrack>;
}

// ---------------------------------------------------------------------------
// Erreurs normalisées
// ---------------------------------------------------------------------------

export class ExternalProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ProviderKind,
    public readonly status?: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "ExternalProviderError";
  }
}

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

export function isExternalEntityType(value: string): value is ExternalEntityType {
  return (EXTERNAL_ENTITY_TYPES as readonly string[]).includes(value);
}
