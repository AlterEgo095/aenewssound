"use client";

// ============================================================================
// Store du LECTEUR PRIVÉ YouTube (décision produit « voie B », usage
// strictement personnel). Indépendant du lecteur AENEWS :
//   - Mutual exclusion : lancer YouTube met en pause le lecteur AENEWS et
//     réciproquement — jamais deux audios en même temps.
//   - L'écoute YouTube ne génère AUCUN événement de royalties (le contenu
//     n'est pas détenu par AENEWS — ledger intègre, v1.1 §15).
// ============================================================================

import { create } from "zustand";
import { api, ApiClientError } from "@/lib/api-client";
import { getAudio } from "@/lib/stores";

export type YoutubeVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string | null;
  durationText: string | null;
  publishedAt: string | null;
};

type YoutubeTrackRef = { id: string; title: string; artistName: string };

type ResolveResponse = {
  mode: "LINKED" | "CANDIDATES" | "UNAVAILABLE";
  reason?: string;
  linked: YoutubeVideo | null;
  candidates: YoutubeVideo[];
};

type YoutubeStatus = "idle" | "resolving" | "ready" | "error";

type YoutubeState = {
  status: YoutubeStatus;
  track: YoutubeTrackRef | null; // id vide = lecture éphémère (sans lien catalogue)
  video: YoutubeVideo | null;
  candidates: YoutubeVideo[];
  error: string | null;
  pickerOpen: boolean;
  expanded: boolean;
  /** Écouter un titre du catalogue AENEWS via YouTube (lien mémorisé si possible). */
  playTrack: (track: YoutubeTrackRef) => Promise<void>;
  /** Écouter un résultat externe (ex : track Spotify) par requête libre — jamais lié. */
  playQuery: (query: string, label: YoutubeTrackRef) => Promise<void>;
  /** Choisit une version candidate ; la mémorise si le titre appartient au catalogue. */
  pick: (video: YoutubeVideo) => Promise<void>;
  setPickerOpen: (open: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  close: () => void;
};

function pauseAenewsPlayer() {
  // Mutual exclusion — couper le lecteur propriétaire avant de démarrer YouTube.
  getAudio()?.pause();
}

async function linkSilently(trackId: string, video: YoutubeVideo) {
  // Le lien nécessite le rôle admin (propriétaire de la plateforme). En usage
  // privé c'est le cas ; ailleurs on joue quand même, simplement sans mémoriser.
  try {
    await api("/api/external/youtube/link", {
      method: "POST",
      body: { trackId, video },
    });
  } catch {
    // silencieux : la lecture n'en dépend pas
  }
}

export const useYoutubeStore = create<YoutubeState>((set, get) => ({
  status: "idle",
  track: null,
  video: null,
  candidates: [],
  error: null,
  pickerOpen: false,
  expanded: false,

  playTrack: async (track) => {
    pauseAenewsPlayer();
    set({ status: "resolving", track, video: null, error: null, candidates: [] });
    try {
      const data = await api<ResolveResponse>(
        `/api/external/youtube/resolve?trackId=${encodeURIComponent(track.id)}`
      );
      if (data.mode === "UNAVAILABLE") {
        set({ status: "error", error: data.reason ?? "Lecteur YouTube non configuré" });
        return;
      }
      if (data.mode === "LINKED" && data.linked) {
        set({ status: "ready", video: data.linked, candidates: data.candidates });
        return;
      }
      const candidates = data.candidates ?? [];
      if (candidates.length === 0) {
        set({ status: "error", error: "Aucune version YouTube trouvée pour ce titre" });
        return;
      }
      // Premier candidat joué immédiatement, et mémorisé pour les prochaines fois.
      const first = candidates[0];
      set({ status: "ready", video: first, candidates });
      void linkSilently(track.id, first);
    } catch (e) {
      set({
        status: "error",
        error: e instanceof ApiClientError ? e.message : "Erreur réseau — réessayez",
      });
    }
  },

  playQuery: async (query, label) => {
    pauseAenewsPlayer();
    set({ status: "resolving", track: label, video: null, error: null, candidates: [] });
    try {
      const data = await api<{ candidates: YoutubeVideo[] }>(
        `/api/external/youtube/search?q=${encodeURIComponent(query)}`
      );
      const candidates = data.candidates ?? [];
      if (candidates.length === 0) {
        set({ status: "error", error: `Aucune version YouTube trouvée pour « ${label.title} »` });
        return;
      }
      // Lecture éphémère : AUCUN lien mémorisé (le résultat n'est pas au catalogue).
      set({ status: "ready", video: candidates[0], candidates });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof ApiClientError ? e.message : "Erreur réseau — réessayez",
      });
    }
  },

  pick: async (video) => {
    pauseAenewsPlayer();
    const { track } = get();
    set({ status: "ready", video, pickerOpen: false, error: null });
    if (track && track.id) void linkSilently(track.id, video);
  },

  setPickerOpen: (open) => set({ pickerOpen: open }),
  setExpanded: (expanded) => set({ expanded }),
  close: () =>
    set({ status: "idle", track: null, video: null, candidates: [], error: null, pickerOpen: false }),
}));
