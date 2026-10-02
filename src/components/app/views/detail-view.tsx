"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BadgeCheck, ExternalLink, Play } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { usePlayerStore, useViewStore, type AlbumDTO, type ArtistDTO, type TrackDTO } from "@/lib/stores";
import { AlbumCardGrid, ArtworkImg, SectionHeader, TrackRow, formatDuration } from "@/components/app/ui-bits";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type ExternalLink = { provider: string; externalUrl: string | null };

type ArtistResponse = {
  artist: ArtistDTO & { bio: string | null };
  albums: AlbumDTO[];
  topTracks: TrackDTO[];
  followers: number;
  externalLinks?: ExternalLink[];
};
type AlbumResponse = { album: AlbumDTO; tracks: TrackDTO[]; externalLinks?: ExternalLink[] };

function ExternalLinksRow({ links }: { links: ExternalLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-zinc-500">Aussi sur :</span>
      {links.map(
        (link) =>
          link.externalUrl && (
            <a
              key={link.provider}
              href={link.externalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800"
            >
              <ExternalLink className="h-3 w-3" /> {link.provider}
            </a>
          )
      )}
    </div>
  );
}

export function DetailView() {
  const detail = useViewStore((s) => s.detail)!;
  const closeDetail = useViewStore((s) => s.closeDetail);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const artist = useQuery<ArtistResponse>({
    queryKey: ["artist", detail.id],
    queryFn: () => api<ArtistResponse>(`/api/artists/${detail.id}`),
    enabled: detail.kind === "artist",
  });
  const album = useQuery<AlbumResponse>({
    queryKey: ["album", detail.id],
    queryFn: () => api<AlbumResponse>(`/api/albums/${detail.id}`),
    enabled: detail.kind === "album",
  });

  const follow = useMutation({
    mutationFn: (artistId: string) => api("/api/follows", { method: "POST", body: { artistId } }),
    onSuccess: () => {
      toast({ title: "Vous suivez cet artiste" });
      void queryClient.invalidateQueries({ queryKey: ["artist", detail.id] });
    },
    onError: (e) =>
      toast({ title: e instanceof ApiClientError ? e.message : "Échec", variant: "destructive" }),
  });

  if (detail.kind === "artist") {
    const data = artist.data;
    return (
      <div className="space-y-6">
        <button className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200" onClick={closeDetail}>
          <ArrowLeft className="h-4 w-4" /> Retour
        </button>
        {data ? (
          <>
            <div className="flex items-center gap-4">
              <ArtworkImg src={data.artist.artworkUrl} alt={data.artist.name} className="h-24 w-24 rounded-2xl" />
              <div>
                <h1 className="flex items-center gap-2 text-2xl font-black">
                  {data.artist.name}
                  {data.artist.verified && <BadgeCheck className="h-5 w-5 text-amber-400" />}
                </h1>
                <p className="text-sm text-zinc-400">{data.followers} abonnés</p>
                {data.artist.bio && <p className="mt-1 max-w-md text-xs text-zinc-500">{data.artist.bio}</p>}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="bg-amber-500 text-black hover:bg-amber-400"
                onClick={() => data.topTracks[0] && playTrack(data.topTracks[0], data.topTracks)}
              >
                <Play className="mr-1 h-4 w-4 fill-current" /> Écouter les tops
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-zinc-700"
                onClick={() => follow.mutate(data.artist.id)}
              >
                Suivre
              </Button>
            </div>
            {data.externalLinks && data.externalLinks.length > 0 && (
              <ExternalLinksRow links={data.externalLinks} />
            )}
            <section>
              <SectionHeader title="Top titres" />
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-1">
                {data.topTracks.map((track, i) => (
                  <TrackRow key={track.id} track={track} queue={data.topTracks} showIndex={i + 1} />
                ))}
              </div>
            </section>
            {data.albums.length > 0 && (
              <section>
                <SectionHeader title="Albums & EP" />
                <AlbumCardGrid albums={data.albums} />
              </section>
            )}
          </>
        ) : (
          <p className="py-10 text-center text-sm text-zinc-500">Chargement…</p>
        )}
      </div>
    );
  }

  const data = album.data;
  const totalDuration = data?.tracks.reduce((acc, t) => acc + t.durationSeconds, 0) ?? 0;
  return (
    <div className="space-y-6">
      <button className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200" onClick={closeDetail}>
        <ArrowLeft className="h-4 w-4" /> Retour
      </button>
      {data ? (
        <>
          <div className="flex items-center gap-4">
            <ArtworkImg src={data.album.artworkUrl} alt={data.album.title} className="h-28 w-28 rounded-2xl" />
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-amber-400">{data.album.type}</p>
              <h1 className="text-2xl font-black">{data.album.title}</h1>
              <p className="text-sm text-zinc-400">
                {data.album.artist.name} · {data.tracks.length} titres · {formatDuration(totalDuration)}
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-1">
            {data.tracks.map((track, i) => (
              <TrackRow key={track.id} track={track} queue={data.tracks} showIndex={i + 1} />
            ))}
          </div>
          {data.externalLinks && data.externalLinks.length > 0 && (
            <ExternalLinksRow links={data.externalLinks} />
          )}
        </>
      ) : (
        <p className="py-10 text-center text-sm text-zinc-500">Chargement…</p>
      )}
    </div>
  );
}
