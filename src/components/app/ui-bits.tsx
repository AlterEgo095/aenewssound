"use client";

import { useState } from "react";
import { Heart, ListPlus, MoreVertical, Play, Download, UserRound, Youtube as YoutubeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { usePlayerStore, useViewStore, type AlbumDTO, type ArtistDTO, type TrackDTO } from "@/lib/stores";
import { useYoutubeStore } from "@/lib/youtube-store";
import { cn } from "@/lib/utils";

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatCDF(minor: number): string {
  return `${minor.toLocaleString("fr-FR")} FC`;
}

// Artwork réelle servie par l'API (fichiers générés) — fallback initiales si absente.
export function ArtworkImg({
  src,
  fallback,
  alt,
  className,
}: {
  src: string;
  fallback?: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const tried = [src, ...(fallback ? [fallback] : [])].filter((u) => !failed.includes(u));
  const current = tried[0];
  if (!current) {
    return (
      <div className={cn("flex items-center justify-center bg-gradient-to-br from-amber-600/70 to-stone-800", className)}>
        <span className="text-xl font-black tracking-widest text-white/80">{alt.slice(0, 2).toUpperCase()}</span>
      </div>
    );
  }
  return (
     
    <img
      src={current}
      alt={alt}
      className={cn("object-cover", className)}
      loading="lazy"
      onError={() => setFailed((prev) => [...prev, current])}
    />
  );
}

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {action}
    </div>
  );
}

export function PremiumChip({ isPremium, until }: { isPremium: boolean; until?: string | null }) {
  return isPremium ? (
    <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-400 ring-1 ring-amber-500/40">
      Premium{until ? ` · ${new Date(until).toLocaleDateString("fr-FR")}` : ""}
    </span>
  ) : (
    <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-400 ring-1 ring-zinc-700">
      Gratuit
    </span>
  );
}

export function TrackRow({
  track,
  queue,
  showIndex,
  onAfterAction,
}: {
  track: TrackDTO;
  queue?: TrackDTO[];
  showIndex?: number;
  onAfterAction?: () => void;
}) {
  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentId = usePlayerStore((s) => (s.queue[s.index]?.id ?? null));
  const isCurrent = currentId === track.id;
  const { toast } = useToast();
  const openDetail = useViewStore((s) => s.openDetail);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [playlists, setPlaylists] = useState<{ id: string; title: string }[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string>("");

  const openPlaylistDialog = async () => {
    try {
      const data = await api<{ playlists: { id: string; title: string }[] }>("/api/playlists");
      setPlaylists(data.playlists);
      setSelectedPlaylist(data.playlists[0]?.id ?? "");
      setPlaylistOpen(true);
    } catch {
      toast({ title: "Connectez-vous pour gérer vos playlists", variant: "destructive" });
    }
  };

  const addToPlaylist = async () => {
    if (!selectedPlaylist) return;
    try {
      await api(`/api/playlists/${selectedPlaylist}`, { method: "POST", body: { trackId: track.id } });
      toast({ title: "Ajouté à la playlist" });
      setPlaylistOpen(false);
    } catch (e) {
      toast({ title: e instanceof ApiClientError ? e.message : "Échec de l'ajout", variant: "destructive" });
    }
  };

  const toggleFavorite = async () => {
    try {
      await api("/api/favorites", { method: "POST", body: { trackId: track.id } });
      toast({ title: "Ajouté aux favoris" });
      onAfterAction?.();
    } catch (e) {
      toast({ title: e instanceof ApiClientError ? e.message : "Connexion requise", variant: "destructive" });
    }
  };

  const download = async () => {
    try {
      const result = await api<{ signedUrl: string }>("/api/downloads", {
        method: "POST",
        body: { trackId: track.id },
      });
      const a = document.createElement("a");
      a.href = result.signedUrl;
      a.download = `${track.slug}.wav`;
      a.click();
      toast({ title: "Téléchargement offline activé — licence liée à votre pack" });
      onAfterAction?.();
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "PREMIUM_REQUIRED") {
        toast({ title: "Pack premium requis", description: "Activez un pack pour télécharger.", variant: "destructive" });
      } else {
        toast({ title: e instanceof ApiClientError ? e.message : "Téléchargement impossible", variant: "destructive" });
      }
    }
  };

  const playYoutube = () =>
    void useYoutubeStore
      .getState()
      .playTrack({ id: track.id, title: track.title, artistName: track.artist.name });

  return (
    <div
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-zinc-800/60",
        isCurrent && "bg-amber-500/5 ring-1 ring-amber-500/20"
      )}
    >
      <button
        onClick={() => playTrack(track, queue)}
        className="relative shrink-0 overflow-hidden rounded-md"
        aria-label={`Écouter ${track.title}`}
      >
        <ArtworkImg src={track.artworkUrl} fallback={track.artworkFallbackUrl} alt={track.title} className="h-11 w-11" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <Play className="h-4 w-4 fill-white text-white" />
        </span>
      </button>
      <button
        className="min-w-0 flex-1 text-left"
        onClick={() => playTrack(track, queue)}
      >
        <p className={cn("truncate text-sm font-semibold", isCurrent ? "text-amber-400" : "text-zinc-100")}>
          {showIndex ? `${showIndex}. ` : ""}{track.title}
          {track.explicit && <span className="ml-1.5 rounded bg-zinc-700 px-1 text-[10px] font-bold text-zinc-300">E</span>}
        </p>
        <p className="truncate text-xs text-zinc-400">{track.artist.name}</p>
      </button>
      <span className="shrink-0 text-xs tabular-nums text-zinc-500">{formatDuration(track.durationSeconds)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-zinc-400" aria-label="Actions">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="bg-zinc-900 border-zinc-800">
          <DropdownMenuItem onClick={toggleFavorite}>
            <Heart className="mr-2 h-4 w-4" /> Ajouter aux favoris
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openPlaylistDialog}>
            <ListPlus className="mr-2 h-4 w-4" /> Ajouter à une playlist
          </DropdownMenuItem>
          <DropdownMenuItem onClick={download}>
            <Download className="mr-2 h-4 w-4" /> Télécharger (premium)
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-zinc-800" />
          <DropdownMenuItem onClick={playYoutube}>
            <YoutubeIcon className="mr-2 h-4 w-4" /> Écouter sur YouTube (privé)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDetail({ kind: "artist", id: track.artist.id })}>
            <UserRound className="mr-2 h-4 w-4" /> Voir l&apos;artiste
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={playlistOpen} onOpenChange={setPlaylistOpen}>
        <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Ajouter « {track.title} » à une playlist</DialogTitle>
          </DialogHeader>
          {playlists.length === 0 ? (
            <p className="text-sm text-zinc-400">
              Aucune playlist — créez-en une dans l&apos;onglet Bibliothèque.
            </p>
          ) : (
            <div className="space-y-3">
              <Select value={selectedPlaylist} onValueChange={setSelectedPlaylist}>
                <SelectTrigger className="bg-zinc-800 border-zinc-700">
                  <SelectValue placeholder="Choisir une playlist" />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-800">
                  {playlists.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={addToPlaylist} className="w-full bg-amber-500 text-black hover:bg-amber-400">
                Ajouter
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function TrackCardGrid({ tracks, queue }: { tracks: TrackDTO[]; queue?: TrackDTO[] }) {
  const playTrack = usePlayerStore((s) => s.playTrack);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {tracks.map((track) => (
        <button
          key={track.id}
          onClick={() => playTrack(track, queue ?? tracks)}
          className="group text-left"
        >
          <div className="relative overflow-hidden rounded-xl">
            <ArtworkImg src={track.artworkUrl} fallback={track.artworkFallbackUrl} alt={track.title} className="aspect-square w-full" />
            <span className="absolute bottom-2 right-2 flex h-9 w-9 translate-y-2 items-center justify-center rounded-full bg-amber-500 opacity-0 shadow-lg transition-all group-hover:translate-y-0 group-hover:opacity-100">
              <Play className="h-4 w-4 fill-black text-black" />
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-semibold">{track.title}</p>
          <p className="truncate text-xs text-zinc-400">{track.artist.name}</p>
        </button>
      ))}
    </div>
  );
}

export function ArtistCardList({ artists }: { artists: ArtistDTO[] }) {
  const openDetail = useViewStore((s) => s.openDetail);
  return (
    <div className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:thin]">
      {artists.map((artist) => (
        <button key={artist.id} onClick={() => openDetail({ kind: "artist", id: artist.id })} className="w-24 shrink-0 text-center">
          <ArtworkImg
            src={artist.artworkUrl}
            alt={artist.name}
            className="mx-auto h-24 w-24 rounded-full ring-2 ring-zinc-800 transition-transform hover:scale-105"
          />
          <p className="mt-2 truncate text-xs font-semibold">{artist.name}</p>
        </button>
      ))}
    </div>
  );
}

export function AlbumCardGrid({ albums }: { albums: AlbumDTO[] }) {
  const openDetail = useViewStore((s) => s.openDetail);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {albums.map((album) => (
        <button key={album.id} onClick={() => openDetail({ kind: "album", id: album.id })} className="text-left">
          <ArtworkImg src={album.artworkUrl} alt={album.title} className="aspect-square w-full rounded-xl" />
          <p className="mt-2 truncate text-sm font-semibold">{album.title}</p>
          <p className="truncate text-xs text-zinc-400">{album.artist.name}</p>
        </button>
      ))}
    </div>
  );
}
