"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Types partagés (formes des DTO sérialisés par l'API)
// ---------------------------------------------------------------------------

export type TrackDTO = {
  id: string;
  title: string;
  slug: string;
  durationSeconds: number;
  explicit: boolean;
  status: string;
  playCount: number;
  publishedAt: string | null;
  artist: { id: string; name: string; slug: string };
  album: { id: string; title: string } | null;
  artworkUrl: string;
  artworkFallbackUrl: string | null;
};

export type ArtistDTO = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  verified: boolean;
  artworkUrl: string;
  bio?: string | null;
};

export type AlbumDTO = {
  id: string;
  title: string;
  slug: string;
  type: string;
  releaseDate: string | null;
  artist: { id: string; name: string; slug: string };
  artworkUrl: string;
};

export type MeResponse = {
  user: { id: string; phone: string; email: string | null; displayName: string; role: string; locale: string; country: string | null };
  deviceId: string;
  entitlements: {
    isPremium: boolean;
    premiumUntil: string | null;
    packs: { id: string; source: string; planCode: string | null; expiresAt: string }[];
  };
  deviceCount: number;
  activeSessions: number;
};

// ---------------------------------------------------------------------------
// Device id (stable, généré côté client — exigé par l'API X-Device-Id)
// ---------------------------------------------------------------------------

const DEVICE_KEY = "aenews-device-id";

export function ensureDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Auth store (persistant — access/refresh tokens, cf. rotation API)
// ---------------------------------------------------------------------------

type AuthState = {
  user: MeResponse["user"] | null;
  accessToken: string | null;
  refreshToken: string | null;
  entitlements: MeResponse["entitlements"] | null;
  setSession: (payload: {
    user: MeResponse["user"];
    accessToken: string;
    refreshToken: string;
  }) => void;
  setMe: (me: MeResponse) => void;
  clear: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      entitlements: null,
      setSession: ({ user, accessToken, refreshToken }) =>
        set({ user, accessToken, refreshToken }),
      setMe: (me) => set({ user: me.user, entitlements: me.entitlements }),
      clear: () =>
        set({ user: null, accessToken: null, refreshToken: null, entitlements: null }),
    }),
    { name: "aenews-auth" }
  )
);

// ---------------------------------------------------------------------------
// View store (navigation SPA — une seule route /, v1.1 §3)
// ---------------------------------------------------------------------------

export type Tab = "home" | "search" | "library" | "subscribe" | "profile" | "admin";
export type DetailTarget = { kind: "artist" | "album"; id: string } | null;

type ViewState = {
  tab: Tab;
  detail: DetailTarget;
  setTab: (tab: Tab) => void;
  openDetail: (detail: NonNullable<DetailTarget>) => void;
  closeDetail: () => void;
};

export const useViewStore = create<ViewState>((set) => ({
  tab: "home",
  detail: null,
  setTab: (tab) => set({ tab, detail: null }),
  openDetail: (detail) => set({ detail }),
  closeDetail: () => set({ detail: null }),
}));

// ---------------------------------------------------------------------------
// Player store + singleton audio (le lecteur est un SERVICE, v1.1 §5)
// ---------------------------------------------------------------------------

export type PlaybackEventPayload = {
  kind: string;
  trackId?: string;
  sessionId?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  bufferedMs?: number;
  occurredAt?: string;
  networkType?: string;
};

type PlayerState = {
  queue: TrackDTO[];
  index: number;
  playing: boolean;
  position: number;
  duration: number;
  expanded: boolean;
  sessionId: string | null;
  loading: boolean;
  playTrack: (track: TrackDTO, queue?: TrackDTO[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setExpanded: (expanded: boolean) => void;
  setState: (partial: Partial<Pick<PlayerState, "playing" | "position" | "duration" | "sessionId" | "loading" | "queue" | "index">>) => void;
};

let audioEl: HTMLAudioElement | null = null;

export function getAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "metadata";
  }
  return audioEl;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  index: 0,
  playing: false,
  position: 0,
  duration: 0,
  expanded: false,
  sessionId: null,
  loading: false,
  playTrack: (track, queue) => {
    const nextQueue = queue && queue.length > 0 ? queue : [track];
    const index = Math.max(
      0,
      nextQueue.findIndex((t) => t.id === track.id)
    );
    set({ queue: nextQueue, index, playing: false, position: 0, duration: 0, loading: true });
  },
  toggle: () => {
    const audio = getAudio();
    if (!audio || !get().queue.length) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  },
  next: () => {
    const { index, queue } = get();
    if (index < queue.length - 1) set({ index: index + 1, position: 0, loading: true });
    else set({ playing: false });
  },
  prev: () => {
    const { index } = get();
    if (index > 0) set({ index: index - 1, position: 0, loading: true });
    else if (getAudio()) get().seek(0);
  },
  seek: (seconds) => {
    const audio = getAudio();
    if (audio && Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(Math.max(0, seconds), audio.duration);
      set({ position: audio.currentTime });
    }
  },
  setExpanded: (expanded) => set({ expanded }),
  setState: (partial) => set(partial),
}));
