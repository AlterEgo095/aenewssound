"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Link2, Search as SearchIcon } from "lucide-react";
import { api } from "@/lib/api-client";
import { useViewStore, type AlbumDTO, type ArtistDTO, type TrackDTO } from "@/lib/stores";
import { AlbumCardGrid, ArtistCardList, SectionHeader, TrackRow } from "@/components/app/ui-bits";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type SearchResponse = {
  query: string;
  tracks: TrackDTO[];
  artists: ArtistDTO[];
  albums: AlbumDTO[];
};

type ProvidersResponse = {
  providers: { provider: string; displayName: string; enabled: boolean; sandbox: boolean }[];
};

type LinkedAenews = { entityType: string; entityId: string; identityId: string; label: string };

type ExternalSearchResponse = {
  provider: string;
  sandbox: boolean;
  query: string;
  artists: {
    externalId: string;
    name: string;
    externalUrl: string | null;
    genres: string[];
    followers: number | null;
    linkedAenews: LinkedAenews | null;
  }[];
  albums: {
    externalId: string;
    title: string;
    artistName: string | null;
    releaseDate: string | null;
    externalUrl: string | null;
    linkedAenews: LinkedAenews | null;
  }[];
  tracks: {
    externalId: string;
    title: string;
    artistName: string | null;
    albumTitle: string | null;
    durationSeconds: number;
    explicit: boolean;
    externalUrl: string | null;
    linkedAenews: LinkedAenews | null;
  }[];
};

type Scope = "aenews" | "spotify" | "all";

const fmtDuration = (s: number) =>
  Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "—";

export function SearchView() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scope, setScope] = useState<Scope>("aenews");
  const openDetail = useViewStore((s) => s.openDetail);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const providers = useQuery<ProvidersResponse>({
    queryKey: ["external-providers"],
    queryFn: () => api<ProvidersResponse>("/api/external/providers", { auth: false }),
  });
  const spotifyEnabled =
    providers.data?.providers.some((p) => p.provider === "SPOTIFY" && p.enabled) ?? false;
  const spotifySandbox = providers.data?.providers.find((p) => p.provider === "SPOTIFY")?.sandbox ?? false;

  const { data, isFetching } = useQuery<SearchResponse>({
    queryKey: ["search", debounced],
    queryFn: () => api<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}`, { auth: false }),
    enabled: debounced.length >= 2 && (scope === "aenews" || scope === "all"),
  });

  const external = useQuery<ExternalSearchResponse>({
    queryKey: ["external-search", debounced],
    queryFn: () =>
      api<ExternalSearchResponse>(
        `/api/external/search?provider=SPOTIFY&q=${encodeURIComponent(debounced)}`
      ),
    enabled: debounced.length >= 2 && spotifyEnabled && (scope === "spotify" || scope === "all"),
  });

  const externalCount =
    (external.data?.artists.length ?? 0) + (external.data?.albums.length ?? 0) + (external.data?.tracks.length ?? 0);

  return (
    <div className="space-y-5">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Artiste, titre, album… (ex : Koffi, Rumba)"
          className="border-zinc-800 bg-zinc-900 pl-9"
          aria-label="Recherche"
        />
      </div>

      <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
        <TabsList className="bg-zinc-900">
          <TabsTrigger value="aenews">AENEWS</TabsTrigger>
          {spotifyEnabled && <TabsTrigger value="spotify">Spotify</TabsTrigger>}
          {spotifyEnabled && <TabsTrigger value="all">Tous</TabsTrigger>}
        </TabsList>
      </Tabs>

      {spotifyEnabled && scope !== "aenews" && (
        <p className="text-xs text-zinc-500">
          Résultats Spotify = métadonnées &amp; liens externes — l&apos;écoute reste sur le catalogue
          AENEWS.{" "}
          {spotifySandbox && (
            <span className="font-semibold text-amber-500">
              Mode sandbox (identité de démonstration, pas l&apos;API production).
            </span>
          )}
        </p>
      )}

      {debounced.length < 2 ? (
        <p className="py-10 text-center text-sm text-zinc-500">
          Tapez au moins 2 caractères pour lancer la recherche.
        </p>
      ) : (scope === "aenews" || scope === "all") ? (
        isFetching && !data ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 bg-zinc-800" />
            ))}
          </div>
        ) : data ? (
          <div className="space-y-6">
            {data.tracks.length > 0 && (
              <section>
                <SectionHeader title="Titres AENEWS" />
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-1">
                  {data.tracks.map((track) => (
                    <TrackRow key={track.id} track={track} queue={data.tracks} />
                  ))}
                </div>
              </section>
            )}
            {data.artists.length > 0 && (
              <section>
                <SectionHeader title="Artistes AENEWS" />
                <ArtistCardList artists={data.artists} />
              </section>
            )}
            {data.albums.length > 0 && (
              <section>
                <SectionHeader title="Albums AENEWS" />
                <AlbumCardGrid albums={data.albums} />
              </section>
            )}
            {data.tracks.length === 0 && data.artists.length === 0 && data.albums.length === 0 && scope === "aenews" && (
              <p className="py-10 text-center text-sm text-zinc-500">
                Aucun résultat AENEWS pour « {data.query} ».
              </p>
            )}
          </div>
        ) : null
      ) : null}

      {spotifyEnabled && (scope === "spotify" || scope === "all") && (
        <section className="space-y-3">
          <SectionHeader
            title="Spotify — sources externes"
            action={
              <span className="text-xs text-zinc-500">
                {spotifySandbox ? "Adaptateur sandbox identifié" : "API Spotify (usage A)"}
              </span>
            }
          />
          {external.isFetching && !external.data ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 bg-zinc-800" />
              ))}
            </div>
          ) : external.data ? (
            <div className="space-y-2">
              {external.data.artists.map((a) => (
                <ExternalRow
                  key={a.externalId}
                  kind="ARTISTE"
                  title={a.name}
                  subtitle={a.genres.slice(0, 2).join(" · ") || "Artiste"}
                  externalUrl={a.externalUrl}
                  linked={a.linkedAenews}
                  sandbox={external.data!.sandbox}
                  onOpenLinked={() =>
                    openDetail({ kind: "artist", id: a.linkedAenews!.entityId })
                  }
                />
              ))}
              {external.data.albums.map((al) => (
                <ExternalRow
                  key={al.externalId}
                  kind="ALBUM"
                  title={al.title}
                  subtitle={al.artistName ?? "Album"}
                  externalUrl={al.externalUrl}
                  linked={al.linkedAenews}
                  sandbox={external.data!.sandbox}
                  onOpenLinked={() =>
                    openDetail({ kind: "album", id: al.linkedAenews!.entityId })
                  }
                />
              ))}
              {external.data.tracks.map((t) => (
                <ExternalRow
                  key={t.externalId}
                  kind="TITRE"
                  title={t.title}
                  subtitle={`${t.artistName ?? "?"} · ${fmtDuration(t.durationSeconds)}`}
                  externalUrl={t.externalUrl}
                  linked={t.linkedAenews}
                  sandbox={external.data!.sandbox}
                  onOpenLinked={
                    t.linkedAenews!.entityType === "TRACK"
                      ? undefined
                      : () =>
                          openDetail({
                            kind: t.linkedAenews!.entityType === "ARTIST" ? "artist" : "album",
                            id: t.linkedAenews!.entityId,
                          })
                  }
                />
              ))}
              {externalCount === 0 && (
                <p className="py-6 text-center text-sm text-zinc-500">
                  Aucun résultat Spotify pour « {external.data.query} ».
                </p>
              )}
            </div>
          ) : null}
        </section>
      )}

      {scope === "all" && data && externalCount === 0 && (data.tracks.length + data.artists.length + data.albums.length) === 0 && (
        <p className="pb-4 text-center text-sm text-zinc-500">Aucun résultat — essayez un autre terme.</p>
      )}
    </div>
  );
}

function ExternalRow({
  kind,
  title,
  subtitle,
  externalUrl,
  linked,
  sandbox,
  onOpenLinked,
}: {
  kind: string;
  title: string;
  subtitle: string;
  externalUrl: string | null;
  linked: LinkedAenews | null;
  sandbox: boolean;
  onOpenLinked?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate text-sm font-semibold">
          {title}
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-400">
            {kind}
          </span>
          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-400 ring-1 ring-emerald-500/30">
            Spotify
          </span>
          {sandbox && (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-500 ring-1 ring-amber-500/30">
              Sandbox
            </span>
          )}
        </p>
        <p className="truncate text-xs text-zinc-500">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {linked && (
          <button
            onClick={onOpenLinked}
            className="flex items-center gap-1 rounded-lg border border-emerald-500/40 px-2 py-1 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/10"
          >
            <Link2 className="h-3 w-3" /> Lié AENEWS
          </button>
        )}
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Ouvrir ${title} sur Spotify`}
            className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-800"
          >
            <ExternalLink className="h-3 w-3" /> Spotify
          </a>
        )}
      </div>
    </div>
  );
}
