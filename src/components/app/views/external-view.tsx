"use client";

// ============================================================================
// Back-office — SOURCES EXTERNES (v1.1 §11)
// Rechercher Spotify → aperçu (doublons + correspondances) → associer ou
// importer → identités (resync/dissocier) → worker de synchronisation.
// ============================================================================

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cloud,
  Database,
  ExternalLink,
  Link2,
  Link2Off,
  RefreshCw,
  Search,
  Unplug,
} from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type ProvidersResponse = {
  providers: { provider: string; displayName: string; enabled: boolean; sandbox: boolean }[];
};

type LinkedAenews = { entityType: string; entityId: string; identityId: string; label: string };

type ExternalSearchResponse = {
  provider: string;
  sandbox: boolean;
  artists: { externalId: string; name: string; externalUrl: string | null; linkedAenews: LinkedAenews | null }[];
  albums: { externalId: string; title: string; artistName: string | null; externalUrl: string | null; linkedAenews: LinkedAenews | null }[];
  tracks: { externalId: string; title: string; artistName: string | null; externalUrl: string | null; linkedAenews: LinkedAenews | null }[];
};

type PreviewResponse = {
  provider: string;
  sandbox: boolean;
  entityType: string;
  externalId: string;
  externalUrl: string | null;
  metadata: Record<string, unknown>;
  existingIdentity: { identityId: string; entityId: string } | null;
  catalogCandidates: { id: string; label: string; sublabel: string | null }[];
};

type Identity = {
  id: string;
  provider: string;
  sandbox: boolean;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  entityStatus: string | null;
  externalId: string;
  externalUrl: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string;
  lastSyncError: string | null;
};

type IdentitiesResponse = { identities: Identity[] };

type SyncResponse = {
  counters: { pending: number; running: number; done: number; failed: number };
  jobs: {
    id: string;
    entityType: string;
    entityId: string;
    operation: string;
    status: string;
    attempts: number;
    lastError: string | null;
    finishedAt: string | null;
  }[];
};

type CandidatesResponse = { items: { id: string; label: string; sublabel?: string; status: string }[] };

type Selection = { entityType: "ARTIST" | "ALBUM" | "TRACK"; externalId: string; title: string; artistName: string | null };

export function ExternalView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<"LINK" | "CREATE">("LINK");
  const [linkedTarget, setLinkedTarget] = useState<string | null>(null);
  const [createArtistId, setCreateArtistId] = useState<string | null>(null);

  const providers = useQuery<ProvidersResponse>({
    queryKey: ["external-providers"],
    queryFn: () => api<ProvidersResponse>("/api/external/providers"),
  });
  const identities = useQuery<IdentitiesResponse>({
    queryKey: ["external-identities"],
    queryFn: () => api<IdentitiesResponse>("/api/admin/external/identities"),
  });
  const syncJobs = useQuery<SyncResponse>({
    queryKey: ["external-sync"],
    queryFn: () => api<SyncResponse>("/api/admin/external/sync"),
  });

  const spotify = providers.data?.providers.find((p) => p.provider === "SPOTIFY");

  const search = useQuery<ExternalSearchResponse>({
    queryKey: ["admin-external-search", debounced],
    queryFn: () =>
      api<ExternalSearchResponse>(`/api/external/search?provider=SPOTIFY&q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });

  const preview = useQuery<PreviewResponse>({
    queryKey: ["external-preview", selection?.entityType, selection?.externalId],
    queryFn: () =>
      api<PreviewResponse>(
        `/api/admin/external/import/preview?provider=SPOTIFY&entityType=${selection!.entityType}&externalId=${encodeURIComponent(selection!.externalId)}`
      ),
    enabled: !!selection,
  });

  const candidates = useQuery<CandidatesResponse>({
    queryKey: ["external-candidates", selection?.entityType],
    queryFn: () =>
      api<CandidatesResponse>(`/api/admin/external/catalog-candidates?entityType=${selection!.entityType}`),
    enabled: !!selection,
  });

  const artists = useQuery<CandidatesResponse>({
    queryKey: ["external-candidates", "ARTIST"],
    queryFn: () => api<CandidatesResponse>("/api/admin/external/catalog-candidates?entityType=ARTIST"),
    enabled: !!selection && mode === "CREATE" && selection.entityType !== "ARTIST",
  });

  const invalidate = (...keys: string[]) =>
    keys.forEach((k) => void queryClient.invalidateQueries({ queryKey: [k] }));

  const onError = (e: unknown) =>
    toast({ title: e instanceof ApiClientError ? e.message : "Action impossible", variant: "destructive" });

  const importMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ action: string; entityId: string; entityStatus: string | null }>("/api/admin/external/import", {
        method: "POST",
        body,
      }),
    onSuccess: (res) => {
      toast({
        title:
          res.action === "LINKED"
            ? "Objet externe associé"
            : `Importé (${res.entityStatus ?? "?"}) — audio à fournir via le pipeline AENEWS`,
      });
      setSelection(null);
      setLinkedTarget(null);
      setCreateArtistId(null);
      invalidate("external-identities", "external-sync", "admin-external-search");
    },
    onError,
  });

  const detach = useMutation({
    mutationFn: (identityId: string) =>
      api(`/api/admin/external/identities/${identityId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Identité dissociée — l'entité AENEWS est conservée" });
      invalidate("external-identities", "admin-external-search");
    },
    onError,
  });

  const resync = useMutation({
    mutationFn: (identityId: string) =>
      api("/api/admin/external/identities/sync", { method: "POST", body: { identityId } }),
    onSuccess: (res) => {
      toast({ title: `Synchronisation : ${JSON.stringify(res).slice(0, 90)}` });
      invalidate("external-identities", "external-sync");
    },
    onError,
  });

  const planAll = useMutation({
    mutationFn: () => api<{ queued: number; skipped: number }>("/api/admin/external/sync", {
      method: "POST",
      body: { provider: "SPOTIFY" },
    }),
    onSuccess: (res) => {
      toast({ title: `Sync planifiée : ${res.queued} job(s) en file, ${res.skipped} déjà actif(s)` });
      invalidate("external-sync");
    },
    onError,
  });

  const tick = useMutation({
    mutationFn: () => api<{ processed: number; done: number; failed: number }>("/api/admin/external/sync/tick", {
      method: "POST",
      body: { max: 25 },
    }),
    onSuccess: (res) => {
      toast({ title: `Worker : ${res.processed} traité(s) — ${res.done} OK, ${res.failed} échec(s)` });
      invalidate("external-sync", "external-identities");
    },
    onError,
  });

  const doSearch = () => setDebounced(searchQuery.trim());

  return (
    <div className="space-y-5">
      {/* Statut des fournisseurs */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {providers.data?.providers.map((p) => (
          <div
            key={p.provider}
            className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <Cloud className={cn("h-4 w-4", p.enabled ? "text-emerald-400" : "text-zinc-600")} />
              <p className="text-sm font-semibold">{p.displayName}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge
                className={cn(
                  p.enabled ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-800 text-zinc-500"
                )}
              >
                {p.enabled ? "ACTIF" : "INACTIF"}
              </Badge>
              {p.enabled && (
                <Badge className={p.sandbox ? "bg-amber-500/15 text-amber-500" : "bg-zinc-800 text-zinc-300"}>
                  {p.sandbox ? "SANDBOX" : "PRODUCTION"}
                </Badge>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Recherche Spotify */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
          <Search className="h-4 w-4 text-amber-400" /> Recherche Spotify (métadonnées)
        </h2>
        <div className="flex gap-2">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
            placeholder="Rechercher un artiste, album ou titre chez Spotify…"
            className="border-zinc-800 bg-zinc-950"
          />
          <Button className="bg-amber-500 text-black hover:bg-amber-400" onClick={doSearch}>
            Chercher
          </Button>
        </div>
        {search.data && spotify?.sandbox && (
          <p className="mt-2 text-xs font-semibold text-amber-500">
            Adaptateur sandbox actif (SPOTIFY_CLIENT_ID/SECRET absents) — données de démonstration,
            jamais présentées comme l&apos;API production.
          </p>
        )}
        {search.data && (
          <div className="mt-3 space-y-1.5">
            {[
              ...search.data.artists.map((a) => ({
                entityType: "ARTIST" as const,
                externalId: a.externalId,
                title: a.name,
                subtitle: "Artiste",
                externalUrl: a.externalUrl,
                linked: a.linkedAenews,
              })),
              ...search.data.albums.map((a) => ({
                entityType: "ALBUM" as const,
                externalId: a.externalId,
                title: a.title,
                subtitle: `Album — ${a.artistName ?? "?"}`,
                externalUrl: a.externalUrl,
                linked: a.linkedAenews,
              })),
              ...search.data.tracks.map((t) => ({
                entityType: "TRACK" as const,
                externalId: t.externalId,
                title: t.title,
                subtitle: `Titre — ${t.artistName ?? "?"}`,
                externalUrl: t.externalUrl,
                linked: t.linkedAenews,
              })),
            ].map((item) => (
              <div
                key={`${item.entityType}-${item.externalId}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold">
                    {item.title}
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-400">
                      {item.entityType}
                    </span>
                    {item.linked && (
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">
                        lié → {item.linked.label}
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-zinc-500">{item.subtitle}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {item.externalUrl && (
                    <a
                      href={item.externalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="rounded-lg border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800"
                      aria-label={`Ouvrir sur Spotify`}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 border-zinc-700"
                    onClick={() => {
                      setSelection({
                        entityType: item.entityType,
                        externalId: item.externalId,
                        title: item.title,
                        artistName: null,
                      });
                      setMode(item.linked ? "LINK" : "LINK");
                      setLinkedTarget(null);
                      setCreateArtistId(null);
                    }}
                  >
                    Gérer
                  </Button>
                </div>
              </div>
            ))}
            {search.data.artists.length + search.data.albums.length + search.data.tracks.length === 0 && (
              <p className="py-4 text-center text-sm text-zinc-500">Aucun résultat.</p>
            )}
          </div>
        )}
      </section>

      {/* Identités externes */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold">
          <Database className="h-4 w-4 text-amber-400" /> Identités externes ({identities.data?.identities.length ?? 0})
        </h2>
        {identities.data?.identities.length === 0 && (
          <p className="text-sm text-zinc-500">
            Aucune identité — recherchez chez Spotify puis associez ou importez.
          </p>
        )}
        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {identities.data?.identities.map((identity) => (
            <div
              key={identity.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {identity.entityLabel ?? identity.entityId}{" "}
                  <span className="text-xs font-normal text-zinc-500">
                    {identity.entityType} · {identity.provider}
                    {identity.sandbox ? " (sandbox)" : ""}
                  </span>
                </p>
                <p className="truncate text-xs text-zinc-500">
                  externe : {identity.externalId} ·{" "}
                  {identity.lastSyncStatus === "OK" && identity.lastSyncedAt
                    ? `sync ${new Date(identity.lastSyncedAt).toLocaleString("fr-FR")}`
                    : identity.lastSyncStatus === "FAILED"
                      ? `échec sync : ${identity.lastSyncError ?? "?"}`
                      : "jamais synchronisé"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge
                  className={cn(
                    identity.entityStatus === "PUBLISHED" || identity.entityStatus === "ACTIVE"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-zinc-800 text-zinc-400"
                  )}
                >
                  {identity.entityStatus ?? "?"}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-zinc-700"
                  onClick={() => resync.mutate(identity.id)}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
                {identity.externalUrl && (
                  <a
                    href={identity.externalUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-lg border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800"
                    aria-label="Ouvrir chez le fournisseur"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-rose-500/40 text-rose-400"
                  onClick={() => detach.mutate(identity.id)}
                >
                  <Link2Off className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Worker de synchronisation */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <RefreshCw className="h-4 w-4 text-amber-400" /> Synchronisation (worker)
          </h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="border-zinc-700" onClick={() => planAll.mutate()}>
              Planifier tout
            </Button>
            <Button size="sm" className="bg-amber-500 text-black hover:bg-amber-400" onClick={() => tick.mutate()}>
              Exécuter le lot
            </Button>
          </div>
        </div>
        <div className="mb-2 flex flex-wrap gap-2 text-xs">
          {syncJobs.data &&
            Object.entries(syncJobs.data.counters).map(([k, v]) => (
              <Badge key={k} className="bg-zinc-800 text-zinc-300">
                {k} : {v}
              </Badge>
            ))}
        </div>
        <div className="max-h-56 space-y-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {syncJobs.data?.jobs.length === 0 && <p className="text-sm text-zinc-500">File vide.</p>}
          {syncJobs.data?.jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-1.5 text-xs"
            >
              <p className="truncate">
                {job.entityType} {job.entityId.slice(-8)} · {job.operation} · tentative {job.attempts}
                {job.lastError ? ` · ${job.lastError.slice(0, 70)}` : ""}
              </p>
              <Badge
                className={cn(
                  job.status === "DONE" && "bg-emerald-500/15 text-emerald-400",
                  job.status === "FAILED" && "bg-rose-500/15 text-rose-400",
                  (job.status === "PENDING" || job.status === "RUNNING") && "bg-amber-500/15 text-amber-500"
                )}
              >
                {job.status}
              </Badge>
            </div>
          ))}
        </div>
      </section>

      {/* Dialog : associer / importer */}
      <Dialog open={!!selection} onOpenChange={(open) => !open && setSelection(null)}>
        <DialogContent
          aria-describedby={undefined}
          className="max-h-[85vh] max-w-lg overflow-y-auto border-zinc-800 bg-zinc-950"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-amber-400" /> {selection?.title}
              <span className="text-xs font-normal text-zinc-500">{selection?.entityType} · Spotify</span>
            </DialogTitle>
          </DialogHeader>

          {preview.data ? (
            <div className="space-y-4">
              {/* Aperçu métadonnées */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="mb-1 text-xs font-bold uppercase text-zinc-500">Aperçu des métadonnées</p>
                <div className="space-y-0.5 text-xs text-zinc-300">
                  {Object.entries(preview.data.metadata).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-zinc-500">{k}</span> : {String(v ?? "—")}
                    </p>
                  ))}
                </div>
                {preview.data.existingIdentity && (
                  <p className="mt-2 rounded bg-emerald-500/10 p-2 text-xs text-emerald-400">
                    Déjà lié à l&apos;entité AENEWS {preview.data.existingIdentity.entityId.slice(-8)}.
                    Réassocier mettra à jour le lien.
                  </p>
                )}
              </div>

              {/* Mode */}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={mode === "LINK" ? "default" : "outline"}
                  className={mode === "LINK" ? "bg-amber-500 text-black" : "border-zinc-700"}
                  onClick={() => setMode("LINK")}
                >
                  <Link2 className="mr-1 h-3.5 w-3.5" /> Associer à un objet AENEWS
                </Button>
                <Button
                  size="sm"
                  variant={mode === "CREATE" ? "default" : "outline"}
                  className={mode === "CREATE" ? "bg-amber-500 text-black" : "border-zinc-700"}
                  onClick={() => setMode("CREATE")}
                >
                  Importer les métadonnées
                </Button>
              </div>

              {mode === "LINK" ? (
                <div className="space-y-2">
                  <p className="text-xs font-bold uppercase text-zinc-500">
                    Correspondances dans le catalogue AENEWS
                  </p>
                  {candidates.data?.items.length === 0 && (
                    <p className="text-xs text-zinc-500">Aucune correspondance — créez plutôt l&apos;objet.</p>
                  )}
                  <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                    {candidates.data?.items.map((c) => (
                      <label
                        key={c.id}
                        className={cn(
                          "flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm",
                          linkedTarget === c.id
                            ? "border-amber-500 bg-amber-500/10"
                            : "border-zinc-800 hover:bg-zinc-900"
                        )}
                      >
                        <span>
                          {c.label}
                          {c.sublabel ? ` — ${c.sublabel}` : ""}
                          <span className="ml-2 text-xs text-zinc-500">{c.status}</span>
                        </span>
                        <input
                          type="radio"
                          name="link-target"
                          checked={linkedTarget === c.id}
                          onChange={() => setLinkedTarget(c.id)}
                          className="accent-amber-500"
                        />
                      </label>
                    ))}
                  </div>
                  <Button
                    className="w-full bg-amber-500 text-black hover:bg-amber-400"
                    disabled={!linkedTarget}
                    onClick={() =>
                      linkedTarget &&
                      importMutation.mutate({
                        provider: "SPOTIFY",
                        entityType: selection!.entityType,
                        externalId: selection!.externalId,
                        mode: "LINK",
                        targetEntityId: linkedTarget,
                      })
                    }
                  >
                    Confirmer l&apos;association
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {selection!.entityType === "ARTIST" ? (
                    <p className="text-xs text-zinc-400">
                      Créera l&apos;artiste <strong>{selection!.title}</strong> (profil métadonnées,
                      sans audio). L&apos;audio publié restera exclusivement celui du pipeline AENEWS.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      <p className="text-xs font-bold uppercase text-zinc-500">
                        Artiste AENEWS de rattachement
                      </p>
                      <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                        {artists.data?.items.map((a) => (
                          <label
                            key={a.id}
                            className={cn(
                              "flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm",
                              createArtistId === a.id
                                ? "border-amber-500 bg-amber-500/10"
                                : "border-zinc-800 hover:bg-zinc-900"
                            )}
                          >
                            <span>
                              {a.label} <span className="ml-1 text-xs text-zinc-500">{a.status}</span>
                            </span>
                            <input
                              type="radio"
                              name="create-artist"
                              checked={createArtistId === a.id}
                              onChange={() => setCreateArtistId(a.id)}
                              className="accent-amber-500"
                            />
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-zinc-500">
                        {selection!.entityType === "ALBUM"
                          ? "L'album sera créé en DRAFT (titres à produire + modération avant publication)."
                          : "Le titre sera créé en DRAFT : upload du master via le pipeline AENEWS puis modération."}
                      </p>
                    </div>
                  )}
                  <Button
                    className="w-full bg-amber-500 text-black hover:bg-amber-400"
                    disabled={selection!.entityType !== "ARTIST" && !createArtistId}
                    onClick={() =>
                      importMutation.mutate({
                        provider: "SPOTIFY",
                        entityType: selection!.entityType,
                        externalId: selection!.externalId,
                        mode: "CREATE",
                        mainArtistId: selection!.entityType === "ARTIST" ? undefined : createArtistId,
                      })
                    }
                  >
                    Confirmer l&apos;import (métadonnées uniquement)
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-zinc-500">Chargement de l&apos;aperçu…</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Rappel architectural */}
      <p className="flex items-start gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">
        <Unplug className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Spotify est un fournisseur externe de métadonnées et de découverte. AENEWS SOUND conserve son
        propre pipeline audio, ses droits et son catalogue — la synchronisation n&apos;efface jamais
        une donnée AENEWS.
      </p>
    </div>
  );
}
