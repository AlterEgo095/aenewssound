"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPlus, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { type TrackDTO } from "@/lib/stores";
import { SectionHeader, TrackRow, formatDuration } from "@/components/app/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

type FavoritesResponse = { favorites: { addedAt: string; track: TrackDTO }[] };
type PlaylistsResponse = { playlists: { id: string; title: string; description: string | null; trackCount: number; updatedAt: string }[] };
type PlaylistDetailResponse = { tracks: { addedAt: string; track: TrackDTO }[] };
type HistoryResponse = { history: { playedAt: string; track: TrackDTO }[] };
type DownloadsResponse = {
  downloads: {
    id: string;
    status: string;
    licenseExpiresAt: string | null;
    freshUrl: string | null;
    track: TrackDTO;
  }[];
};

export function LibraryView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [openPlaylistId, setOpenPlaylistId] = useState<string | null>(null);

  const favorites = useQuery<FavoritesResponse>({
    queryKey: ["favorites"],
    queryFn: () => api<FavoritesResponse>("/api/favorites"),
  });
  const playlists = useQuery<PlaylistsResponse>({
    queryKey: ["playlists"],
    queryFn: () => api<PlaylistsResponse>("/api/playlists"),
  });
  const history = useQuery<HistoryResponse>({
    queryKey: ["history"],
    queryFn: () => api<HistoryResponse>("/api/history"),
  });
  const downloads = useQuery<DownloadsResponse>({
    queryKey: ["downloads"],
    queryFn: () => api<DownloadsResponse>("/api/downloads"),
  });
  const playlistDetail = useQuery<PlaylistDetailResponse>({
    queryKey: ["playlist", openPlaylistId],
    queryFn: () => api<PlaylistDetailResponse>(`/api/playlists/${openPlaylistId}`),
    enabled: !!openPlaylistId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["favorites"] });
    void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    void queryClient.invalidateQueries({ queryKey: ["downloads"] });
    if (openPlaylistId) void queryClient.invalidateQueries({ queryKey: ["playlist", openPlaylistId] });
  };

  const createPlaylist = useMutation({
    mutationFn: () => api("/api/playlists", { method: "POST", body: { title: newTitle } }),
    onSuccess: () => {
      setCreateOpen(false);
      setNewTitle("");
      invalidate();
      toast({ title: "Playlist créée" });
    },
    onError: (e) => toast({ title: e instanceof ApiClientError ? e.message : "Échec", variant: "destructive" }),
  });

  const removeFavorite = useMutation({
    mutationFn: (trackId: string) => api(`/api/favorites?trackId=${trackId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(),
  });

  const deletePlaylist = useMutation({
    mutationFn: (id: string) => api(`/api/playlists/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setOpenPlaylistId(null);
      invalidate();
      toast({ title: "Playlist supprimée" });
    },
  });

  const removeFromPlaylist = useMutation({
    mutationFn: (trackId: string) => api(`/api/playlists/${openPlaylistId}?trackId=${trackId}`, { method: "DELETE" }),
    onSuccess: () => invalidate(),
  });

  const refreshDownload = useMutation({
    mutationFn: (trackId: string) => api<DownloadsResponse>(`/api/downloads?refreshTrackId=${trackId}`),
    onSuccess: (data) => {
      const fresh = data.downloads.find((d) => d.freshUrl);
      if (fresh?.freshUrl) {
        const a = document.createElement("a");
        a.href = fresh.freshUrl;
        a.download = `${fresh.track.slug}.wav`;
        a.click();
        toast({ title: "Nouvelle URL signée — licence revalidée" });
      }
      invalidate();
    },
  });

  return (
    <div className="space-y-4">
      <SectionHeader title="Ma bibliothèque" />
      <Tabs defaultValue="favorites">
        <TabsList className="bg-zinc-900">
          <TabsTrigger value="favorites">Favoris</TabsTrigger>
          <TabsTrigger value="playlists">Playlists</TabsTrigger>
          <TabsTrigger value="history">Historique</TabsTrigger>
          <TabsTrigger value="downloads">Téléchargements</TabsTrigger>
        </TabsList>

        <TabsContent value="favorites" className="mt-3">
          {favorites.isLoading ? (
            <p className="py-6 text-sm text-zinc-500">Chargement…</p>
          ) : favorites.data && favorites.data.favorites.length > 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-1">
              {favorites.data.favorites.map((f) => (
                <TrackRow key={f.track.id} track={f.track} queue={favorites.data!.favorites.map((x) => x.track)} onAfterAction={() => removeFavorite.mutate(f.track.id)} />
              ))}
            </div>
          ) : (
            <p className="py-6 text-sm text-zinc-500">Aucun favori — utilisez le menu ⋮ sur un titre.</p>
          )}
        </TabsContent>

        <TabsContent value="playlists" className="mt-3 space-y-3">
          <Button
            size="sm"
            className="bg-amber-500 text-black hover:bg-amber-400"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1 h-4 w-4" /> Nouvelle playlist
          </Button>
          {openPlaylistId && playlistDetail.data ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-2">
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-sm font-bold">
                  {playlists.data?.playlists.find((p) => p.id === openPlaylistId)?.title}
                </p>
                <Button size="sm" variant="ghost" className="text-zinc-400" onClick={() => setOpenPlaylistId(null)}>
                  Fermer
                </Button>
              </div>
              {playlistDetail.data.tracks.length === 0 ? (
                <p className="px-1 py-4 text-sm text-zinc-500">Playlist vide — ajoutez des titres via le menu ⋮.</p>
              ) : (
                playlistDetail.data.tracks.map((item) => (
                  <div key={item.track.id} className="flex items-center">
                    <div className="min-w-0 flex-1">
                      <TrackRow
                        track={item.track}
                        queue={playlistDetail.data!.tracks.map((x) => x.track)}
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-zinc-500"
                      onClick={() => removeFromPlaylist.mutate(item.track.id)}
                      aria-label="Retirer"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
              <Button
                size="sm"
                variant="outline"
                className="mt-2 border-zinc-700 text-zinc-300"
                onClick={() => deletePlaylist.mutate(openPlaylistId)}
              >
                Supprimer la playlist
              </Button>
            </div>
          ) : playlists.data && playlists.data.playlists.length > 0 ? (
            <div className="space-y-2">
              {playlists.data.playlists.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setOpenPlaylistId(p.id)}
                  className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-left hover:bg-zinc-800/60"
                >
                  <span className="flex items-center gap-3">
                    <ListPlus className="h-5 w-5 text-amber-400" />
                    <span>
                      <span className="block text-sm font-semibold">{p.title}</span>
                      <span className="block text-xs text-zinc-500">{p.trackCount} titres</span>
                    </span>
                  </span>
                  <span className="text-xs text-zinc-500">{formatDuration(0) && p.updatedAt.slice(0, 10)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-4 text-sm text-zinc-500">Aucune playlist pour l&apos;instant.</p>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-3">
          {history.data && history.data.history.length > 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-1">
              {history.data.history.map((h) => (
                <div key={`${h.track.id}-${h.playedAt}`}>
                  <TrackRow track={h.track} queue={history.data!.history.map((x) => x.track)} />
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-sm text-zinc-500">Aucune écoute récente.</p>
          )}
        </TabsContent>

        <TabsContent value="downloads" className="mt-3">
          {downloads.data && downloads.data.downloads.length > 0 ? (
            <div className="space-y-2">
              {downloads.data.downloads.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{d.track.title}</p>
                    <p className="text-xs text-zinc-500">
                      Licence :{" "}
                      {d.status === "READY" && d.licenseExpiresAt
                        ? `valide jusqu'au ${new Date(d.licenseExpiresAt).toLocaleString("fr-FR")}`
                        : d.status === "EXPIRED"
                          ? "expirée — réactivez un pack"
                          : d.status}
                    </p>
                  </div>
                  {d.status === "READY" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 border-amber-500/40 text-amber-400"
                      onClick={() => refreshDownload.mutate(d.track.id)}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" /> Re-télécharger
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-sm text-zinc-500">
              Aucun téléchargement — réservé aux packs premium (menu ⋮ sur un titre).
            </p>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Nouvelle playlist</DialogTitle>
          </DialogHeader>
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Titre de la playlist"
            className="bg-zinc-800 border-zinc-700"
          />
          <DialogFooter>
            <Button
              className="bg-amber-500 text-black hover:bg-amber-400"
              disabled={newTitle.trim().length < 1 || createPlaylist.isPending}
              onClick={() => createPlaylist.mutate()}
            >
              Créer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
