"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useAuthStore, type AlbumDTO, type ArtistDTO, type TrackDTO } from "@/lib/stores";
import {
  AlbumCardGrid,
  ArtistCardList,
  PremiumChip,
  SectionHeader,
  TrackCardGrid,
  TrackRow,
} from "@/components/app/ui-bits";
import { Skeleton } from "@/components/ui/skeleton";

type HomeResponse = {
  newReleases: TrackDTO[];
  trending: TrackDTO[];
  artists: ArtistDTO[];
  genres: { id: string; name: string; slug: string; trackCount: number }[];
};

export function HomeView() {
  const user = useAuthStore((s) => s.user);
  const entitlements = useAuthStore((s) => s.entitlements);
  const { data, isLoading, error } = useQuery<HomeResponse>({
    queryKey: ["home"],
    queryFn: () => api<HomeResponse>("/api/home", { auth: false }),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48 bg-zinc-800" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square bg-zinc-800" />
          ))}
        </div>
        <Skeleton className="h-40 bg-zinc-800" />
      </div>
    );
  }
  if (error || !data) {
    return <p className="py-10 text-center text-sm text-zinc-500">Impossible de charger l&apos;accueil.</p>;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-black tracking-tight">
            Bonjour {user?.displayName.split(" ")[0]} 👋
          </h1>
          <p className="text-sm text-zinc-400">Nouveautés et sons chauds de Kinshasa</p>
        </div>
        <PremiumChip isPremium={entitlements?.isPremium ?? false} until={entitlements?.premiumUntil} />
      </div>

      <section>
        <SectionHeader title="Nouveautés" />
        <TrackCardGrid tracks={data.newReleases} />
      </section>

      <section>
        <SectionHeader title="Top écoutes validées" />
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-1">
          {data.trending.slice(0, 6).map((track, i) => (
            <TrackRow key={track.id} track={track} queue={data.trending} showIndex={i + 1} />
          ))}
        </div>
      </section>

      <section>
        <SectionHeader title="Artistes" />
        <ArtistCardList artists={data.artists} />
      </section>

      {data.genres.length > 0 && (
        <section>
          <SectionHeader title="Genres" />
          <div className="flex flex-wrap gap-2">
            {data.genres.map((g) => (
              <span
                key={g.id}
                className="rounded-full bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 ring-1 ring-zinc-700"
              >
                {g.name} · {g.trackCount}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
