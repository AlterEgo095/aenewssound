"use client";

// ============================================================================
// Lecteur YouTube PRIVÉ — lecteur OFFICIEL YouTube (Iframe Player API).
//
// Conformité CGU YouTube : le lecteur est TOUJOURS VISIBLE (jamais masqué, pas
// de 0×0) et intègre les contrôles officiels. Aucune extraction de flux.
//
// Mutual exclusion : le démarrage d'une lecture AENEWS met YouTube en pause
// (et réciproquement via le store) — jamais deux audios simultanés.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import {
  ListMusic,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  X,
  Youtube as YoutubeIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/api-client";
import { usePlayerStore } from "@/lib/stores";
import { useYoutubeStore, type YoutubeVideo } from "@/lib/youtube-store";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// -- Typage minimal de l'Iframe API YouTube (pas de dépendance externe) ------

type YTPlayer = {
  loadVideoById: (videoId: string) => void;
  pauseVideo: () => void;
  playVideo: () => void;
  destroy: () => void;
};

type YTNamespace = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width: string;
      height: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onError?: (e: { data: number }) => void;
      };
    }
  ) => YTPlayer;
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YTNamespace> | null = null;

function loadYoutubeIframeApi(): Promise<YTNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("rendu serveur"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Chargement du lecteur YouTube trop long — vérifiez le réseau")),
      15_000
    );
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      clearTimeout(timeout);
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("Lecteur YouTube indisponible"));
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    tag.onerror = () => {
      clearTimeout(timeout);
      ytApiPromise = null; // permettra une nouvelle tentative
      reject(new Error("Impossible de charger le lecteur YouTube (réseau bloqué ?)"));
    };
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

const YT_ERROR_MESSAGES: Record<number, string> = {
  2: "Identifiant de vidéo invalide",
  5: "Erreur du lecteur HTML5",
  100: "Vidéo introuvable ou privée",
  101: "Le propriétaire interdit la lecture intégrée de cette vidéo",
  150: "Le propriétaire interdit la lecture intégrée de cette vidéo",
};

// ----------------------------------------------------------------------------

export function YoutubeMiniPlayer() {
  const { status, track, video, error, expanded, setExpanded } = useYoutubeStore();
  const setPickerOpen = useYoutubeStore((s) => s.setPickerOpen);
  const close = useYoutubeStore((s) => s.close);
  const aenewsPlaying = usePlayerStore((s) => s.playing);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const { toast } = useToast();

  // Mutual exclusion : le lecteur AENEWS démarre → YouTube en pause.
  useEffect(() => {
    if (aenewsPlaying) playerRef.current?.pauseVideo();
  }, [aenewsPlaying]);

  // Création du lecteur (une fois) puis remplacement de vidéo sans recréation.
  const videoId = video?.videoId ?? null;
  useEffect(() => {
    if (status !== "ready" || !videoId) return;
    let cancelled = false;
    void loadYoutubeIframeApi()
      .then((YT) => {
        if (cancelled) return;
        const host = hostRef.current;
        if (!host) return;
        if (playerRef.current) {
          playerRef.current.loadVideoById(videoId);
          return;
        }
        // YT.Player REMPLACE l'élément passé : on lui donne un div dédié.
        const inner = document.createElement("div");
        host.replaceChildren(inner);
        playerRef.current = new YT.Player(inner, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
          events: {
            onError: (e) => {
              const reason = YT_ERROR_MESSAGES[e.data] ?? "Lecture impossible";
              toast({
                title: `YouTube : ${reason}`,
                description: "Choisissez une autre version ci-dessous.",
                variant: "destructive",
              });
              useYoutubeStore.getState().setPickerOpen(true);
            },
          },
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          useYoutubeStore.setState({
            status: "error",
            error: err instanceof Error ? err.message : "Lecteur YouTube indisponible",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [status, videoId, toast]);

  // Fermeture / démontage : destruction propre du lecteur.
  useEffect(() => {
    if (status === "idle" && playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }
  }, [status]);
  useEffect(() => {
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  if (status === "idle") return null;

  return (
    <div className="border-t border-red-900/40 bg-zinc-900/95 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-3 py-2">
        {/* Lecteur OFFICIEL visible (exigence CGU YouTube) */}
        <div
          className={cn(
            "shrink-0 overflow-hidden rounded-md bg-black shadow-lg transition-all",
            expanded ? "w-64" : "w-40"
          )}
        >
          <div className="aspect-video w-full">
            {status === "ready" && videoId ? (
              <div ref={hostRef} className="h-full w-full" />
            ) : status === "resolving" ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center">
                <YoutubeIcon className="h-6 w-6 text-zinc-700" />
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-400 ring-1 ring-red-500/30">
              YouTube
            </span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-400">
              Lecture privée
            </span>
          </p>
          {status === "resolving" && (
            <p className="mt-1.5 flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Recherche de la version YouTube…
            </p>
          )}
          {status === "ready" && track && (
            <>
              <p className="mt-1 truncate text-sm font-semibold text-zinc-100">{track.title}</p>
              <p className="truncate text-xs text-zinc-400">
                {track.artistName}
                {video?.channelTitle ? ` · ${video.channelTitle}` : ""}
              </p>
            </>
          )}
          {status === "error" && (
            <p className="mt-1.5 line-clamp-3 text-xs leading-4 text-red-400" role="status">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {status === "ready" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-zinc-400"
              onClick={() => setPickerOpen(true)}
              aria-label="Changer de version"
              title="Changer de version"
            >
              <ListMusic className="h-4 w-4" />
            </Button>
          )}
          {status === "ready" && video && (
            <a
              href={`https://www.youtube.com/watch?v=${video.videoId}`}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Ouvrir sur YouTube"
            >
              <Button size="icon" variant="ghost" className="h-8 w-8 text-zinc-400" title="Ouvrir sur YouTube">
                <YoutubeIcon className="h-4 w-4" />
              </Button>
            </a>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-zinc-400"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? "Réduire la vignette" : "Agrandir la vignette"}
          >
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-zinc-400"
            onClick={close}
            aria-label="Fermer le lecteur YouTube"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <VersionPicker />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sélecteur de version : candidats de la résolution + recherche libre.
// ---------------------------------------------------------------------------

function VersionPicker() {
  const open = useYoutubeStore((s) => s.pickerOpen);
  const setOpen = useYoutubeStore((s) => s.setPickerOpen);
  const storeCandidates = useYoutubeStore((s) => s.candidates);
  const track = useYoutubeStore((s) => s.track);
  const pick = useYoutubeStore((s) => s.pick);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YoutubeVideo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doSearch = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ candidates: YoutubeVideo[] }>(
        `/api/external/youtube/search?q=${encodeURIComponent(q)}`
      );
      setResults(data.candidates);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Recherche impossible");
    } finally {
      setLoading(false);
    }
  };

  const list = results ?? storeCandidates;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto bg-zinc-900 border-zinc-800 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-base">
            Choisir la version YouTube{track ? ` — ${track.title}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void doSearch()}
            placeholder="Rechercher une autre version…"
            className="border-zinc-700 bg-zinc-800"
            aria-label="Recherche YouTube"
          />
          <Button size="icon" className="shrink-0 bg-zinc-800 text-zinc-200 hover:bg-zinc-700" onClick={() => void doSearch()} aria-label="Lancer la recherche">
            <Search className="h-4 w-4" />
          </Button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {loading ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Recherche…
            </p>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500">
              Aucune candidate — lancez une recherche.
            </p>
          ) : (
            list.map((v) => (
              <button
                key={v.videoId}
                onClick={() => {
                  void pick(v);
                  setResults(null);
                  setQuery("");
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-left transition-colors hover:border-red-500/40 hover:bg-red-500/5"
              >
                {v.thumbnailUrl ? (
                  <img src={v.thumbnailUrl} alt="" className="h-10 w-16 shrink-0 rounded object-cover" loading="lazy" />
                ) : (
                  <div className="h-10 w-16 shrink-0 rounded bg-zinc-800" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{v.title}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {v.channelTitle}
                    {v.durationText ? ` · ${v.durationText}` : ""}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        <p className="text-[11px] leading-4 text-zinc-600">
          Lecture privée via le lecteur officiel YouTube — aucune écoute ici n&apos;est comptée dans
          les royalties du catalogue AENEWS.
        </p>
      </DialogContent>
    </Dialog>
  );
}
