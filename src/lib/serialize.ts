import type { Prisma } from "@prisma/client";

// Sérialisation API — formes stables consommées par le frontend.

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

export type TrackLike = Prisma.TrackGetPayload<{
  include: { mainArtist: true; album: true };
}>;

export function trackDTO(track: TrackLike) {
  return {
    id: track.id,
    title: track.title,
    slug: track.slug,
    durationSeconds: track.durationSeconds,
    explicit: track.explicit,
    status: track.status,
    playCount: Number(track.playCount),
    publishedAt: track.publishedAt?.toISOString() ?? null,
    artist: {
      id: track.mainArtist.id,
      name: track.mainArtist.name,
      slug: track.mainArtist.slug,
    },
    album: track.album ? { id: track.album.id, title: track.album.title } : null,
    artworkUrl: `/api/artwork/TRACK/${track.id}`,
    artworkFallbackUrl: track.albumId ? `/api/artwork/ALBUM/${track.albumId}` : null,
  };
}

export function artistDTO(artist: {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  verifiedAt: Date | null;
}) {
  return {
    id: artist.id,
    name: artist.name,
    slug: artist.slug,
    imageUrl: artist.imageUrl,
    verified: artist.verifiedAt !== null,
    artworkUrl: `/api/artwork/ARTIST/${artist.id}`,
  };
}

export function albumDTO(
  album: Prisma.AlbumGetPayload<{ include: { artist: true } }>
) {
  return {
    id: album.id,
    title: album.title,
    slug: album.slug,
    type: album.type,
    releaseDate: album.releaseDate?.toISOString() ?? null,
    artist: { id: album.artist.id, name: album.artist.name, slug: album.artist.slug },
    artworkUrl: `/api/artwork/ALBUM/${album.id}`,
  };
}
