"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { api, ApiClientError } from "@/lib/api-client";
import {
  getAudio,
  useAuthStore,
  usePlayerStore,
  type PlaybackEventPayload,
  type TrackDTO,
} from "@/lib/stores";
import { ArtworkImg, formatDuration } from "@/components/app/ui-bits";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// EVENT PIPELINE (v1.1 §16) : accumulation locale → batch → /api/events/batch
// Le serveur applique le Fraud Engine et crée les ValidatedListenings (règle 2).
// ---------------------------------------------------------------------------

const eventQueue: PlaybackEventPayload[] = [];
let lastProgressFlush = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function pushEvent(event: PlaybackEventPayload) {
  eventQueue.push(event);
  if (eventQueue.length >= 25) void flushEvents();
}

async function flushEvents(): Promise<void> {
  if (eventQueue.length === 0) return;
  const events = eventQueue.splice(0, eventQueue.length);
  const auth = useAuthStore.getState();
  if (!auth.accessToken) return;
  try {
    await api("/api/events/batch", {
      method: "POST",
      body: {
        events,
        clientBatchId: `batch-${Date.now().toString(36)}`,
      },
    });
  } catch {
    // Hors-ligne : les événements sont perdus (buffer persistant = v2 mobile).
  }
}

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flushEvents(), 30_000);
}

function stopFlushTimer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// ---------------------------------------------------------------------------
// PlayerProvider — le lecteur est un service central, pas un composant UI.
// ---------------------------------------------------------------------------

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const { queue, index, playing, loading, setState } = usePlayerStore();
  const current = queue[index] as TrackDTO | undefined;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stallSince = useRef<number | null>(null);

  // Chargement d'une nouvelle piste : stream signé + session + PLAY_START.
  useEffect(() => {
    const audio = getAudio();
    if (!audio) return;
    audioRef.current = audio;

    if (!current) {
      audio.pause();
      audio.removeAttribute("src");
      return;
    }

    let cancelled = false;
    (async () => {
      setState({ loading: true, position: 0, duration: 0 });
      try {
        const stream = await api<{
          signedUrl: string;
          variant: { kind: string; codec: string; deliveryFormat: string };
        }>(`/api/tracks/${current.id}/stream`, { method: "POST" });
        const session = await api<{ sessionId: string }>("/api/playback/sessions", {
          method: "POST",
          body: { trackId: current.id, context: "HOME" },
        });
        if (cancelled) return;

        setState({ sessionId: session.sessionId, loading: false });
        lastProgressFlush = 0;
        eventQueue.length = 0;
        pushEvent({
          kind: "PLAY_START",
          trackId: current.id,
          sessionId: session.sessionId,
          positionSeconds: 0,
          durationSeconds: current.durationSeconds,
        });
        startFlushTimer();

        audio.src = stream.signedUrl;
        await audio.play().catch(() => setState({ playing: false }));

        if ("mediaSession" in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: current.title,
            artist: current.artist.name,
            album: current.album?.title ?? "AENEWS SOUND",
            artwork: [{ src: current.artworkUrl, sizes: "512x512", type: "image/svg+xml" }],
          });
          navigator.mediaSession.setActionHandler("play", () => void audio.play());
          navigator.mediaSession.setActionHandler("pause", () => audio.pause());
          navigator.mediaSession.setActionHandler("previoustrack", () =>
            usePlayerStore.getState().prev()
          );
          navigator.mediaSession.setActionHandler("nexttrack", () =>
            usePlayerStore.getState().next()
          );
        }
      } catch (e) {
        if (cancelled) return;
        setState({ loading: false, playing: false });
        if (e instanceof ApiClientError) {
          console.error("[player]", e.message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
     
  }, [current?.id]);

  // Écouteurs audio : position, buffering, fin, reprise.
  useEffect(() => {
    const audio = getAudio();
    if (!audio) return;

    const onPlay = () => setState({ playing: true });
    const onPause = () => {
      setState({ playing: false });
      void flushEvents();
    };
    const onTimeUpdate = () => {
      const pos = audio.currentTime;
      setState({ position: pos });
      // Une écoute > 30 s doit être visible côté serveur : flush progress régulier.
      if (pos - lastProgressFlush >= 30) {
        lastProgressFlush = pos;
        const state = usePlayerStore.getState();
        pushEvent({
          kind: "PLAY_PROGRESS",
          trackId: state.queue[state.index]?.id,
          sessionId: state.sessionId ?? undefined,
          positionSeconds: pos,
          durationSeconds: audio.duration || undefined,
        });
      }
    };
    const onLoadedMetadata = () => setState({ duration: audio.duration });
    const onWaiting = () => {
      stallSince.current = performance.now();
      const state = usePlayerStore.getState();
      pushEvent({
        kind: "BUFFER_STALL",
        trackId: state.queue[state.index]?.id,
        sessionId: state.sessionId ?? undefined,
        positionSeconds: audio.currentTime,
      });
    };
    const onPlaying = () => {
      if (stallSince.current !== null) {
        stallSince.current = null;
      }
    };
    const onEnded = () => {
      const state = usePlayerStore.getState();
      const track = state.queue[state.index];
      pushEvent({
        kind: "COMPLETE",
        trackId: track?.id,
        sessionId: state.sessionId ?? undefined,
        positionSeconds: audio.duration,
        durationSeconds: audio.duration,
      });
      void flushEvents();
      if (state.sessionId) {
        void api("/api/playback/sessions", {
          method: "PUT",
          body: { sessionId: state.sessionId },
        }).catch(() => undefined);
      }
      state.next();
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("ended", onEnded);
    };
  }, [setState]);

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// MiniPlayer + FullPlayer
// ---------------------------------------------------------------------------

function Waveform() {
  const { queue, index, position, duration, seek } = usePlayerStore();
  const current = queue[index];
  const { data } = useQuery<{ peaks: number[] }>({
    queryKey: ["waveform", current?.id],
    queryFn: () => api(`/api/tracks/${current!.id}/waveform`),
    enabled: !!current,
    staleTime: 5 * 60 * 1000,
  });

  const bars = useMemo(() => {
    if (!data?.peaks) return null;
    const step = Math.max(1, Math.floor(data.peaks.length / 96));
    return data.peaks.filter((_, i) => i % step === 0);
  }, [data]);

  if (!bars) {
    return (
      <div className="flex h-14 items-end gap-[2px] px-1">
        {Array.from({ length: 96 }).map((_, i) => (
          <div key={i} className="flex-1 rounded-sm bg-zinc-800" style={{ height: `${8 + ((i * 37) % 60)}%` }} />
        ))}
      </div>
    );
  }
  const progress = duration > 0 ? position / duration : 0;
  return (
    <div
      role="slider"
      aria-label="Progression"
      aria-valuenow={Math.round(position)}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      tabIndex={0}
      className="flex h-14 cursor-pointer items-end gap-[2px] px-1"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        seek(((e.clientX - rect.left) / rect.width) * duration);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") seek(position + 5);
        if (e.key === "ArrowLeft") seek(position - 5);
      }}
    >
      {bars.map((peak, i) => (
        <div
          key={i}
          className={cn(
            "flex-1 rounded-sm transition-colors",
            i / bars.length <= progress ? "bg-amber-500" : "bg-zinc-700"
          )}
          style={{ height: `${Math.max(8, peak * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function MiniPlayer() {
  const { queue, index, playing, loading, toggle, next, setExpanded } = usePlayerStore();
  const current = queue[index];
  if (!current) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/95 px-3 py-2 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setExpanded(true)}>
          <ArtworkImg src={current.artworkUrl} fallback={current.artworkFallbackUrl} alt={current.title} className="h-10 w-10 rounded-md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{current.title}</p>
            <p className="truncate text-xs text-zinc-400">{current.artist.name}</p>
          </div>
        </button>
        <Button
          size="icon"
          variant="ghost"
          className="text-zinc-200"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Lecture"}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : playing ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
        </Button>
        <Button size="icon" variant="ghost" className="text-zinc-400" onClick={next} aria-label="Suivant">
          <SkipForward className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" className="text-zinc-400" onClick={() => setExpanded(true)} aria-label="Ouvrir le lecteur">
          <ChevronDown className="h-4 w-4 rotate-180" />
        </Button>
      </div>
    </div>
  );
}

export function FullPlayer() {
  const { queue, index, expanded, setExpanded, playing, loading, position, duration, toggle, next, prev, seek } =
    usePlayerStore();
  const current = queue[index];
  const open = expanded && !!current;

  return (
    <Drawer open={open} onOpenChange={(v) => !v && setExpanded(false)}>
      <DrawerContent className="bg-zinc-950 border-zinc-800 text-zinc-100 select-none">
        <div className="mx-auto w-full max-w-md px-4 pb-8">
          <DrawerHeader className="flex flex-row items-center justify-between p-2">
            <DrawerTitle className="text-sm text-zinc-400">Lecture en cours</DrawerTitle>
            <Button variant="ghost" size="icon" onClick={() => setExpanded(false)} aria-label="Fermer">
              <X className="h-5 w-5" />
            </Button>
          </DrawerHeader>
          {current && (
            <>
              <ArtworkImg
                src={current.artworkUrl}
                fallback={current.artworkFallbackUrl}
                alt={current.title}
                className="mx-auto aspect-square w-full max-w-72 rounded-2xl shadow-2xl"
              />
              <div className="mt-5 text-center">
                <p className="text-xl font-bold">{current.title}</p>
                <p className="text-sm text-zinc-400">{current.artist.name}</p>
                {current.album && <p className="text-xs text-zinc-500">{current.album.title}</p>}
              </div>
              <div className="mt-4">
                <Waveform />
                <div className="flex justify-between px-1 text-xs tabular-nums text-zinc-500">
                  <span>{formatDuration(position)}</span>
                  <span>{formatDuration(duration || current.durationSeconds)}</span>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-center gap-6">
                <Button size="icon" variant="ghost" onClick={prev} aria-label="Précédent" className="text-zinc-300">
                  <SkipBack className="h-6 w-6 fill-current" />
                </Button>
                <Button
                  size="icon"
                  className="h-14 w-14 rounded-full bg-amber-500 text-black hover:bg-amber-400"
                  onClick={toggle}
                  disabled={loading}
                  aria-label={playing ? "Pause" : "Lecture"}
                >
                  {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : playing ? <Pause className="h-7 w-7 fill-current" /> : <Play className="h-7 w-7 fill-current translate-x-[1px]" />}
                </Button>
                <Button size="icon" variant="ghost" onClick={next} aria-label="Suivant" className="text-zinc-300">
                  <SkipForward className="h-6 w-6 fill-current" />
                </Button>
              </div>
              <div className="mt-3 text-center text-[11px] text-zinc-600">
                Streaming adaptatif — événements d&apos;écoute envoyés par batch (fraude &amp; royalties)
              </div>
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
