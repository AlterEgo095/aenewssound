"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Disc3, Home, LibraryBig, Search, ShieldCheck, UserRound, Wallet } from "lucide-react";
import { api } from "@/lib/api-client";
import { ensureDeviceId, useAuthStore, useViewStore, type MeResponse, type Tab } from "@/lib/stores";
import { PlayerProvider, MiniPlayer, FullPlayer } from "@/components/app/player";
import { AuthView } from "@/components/app/views/auth-view";
import { HomeView } from "@/components/app/views/home-view";
import { SearchView } from "@/components/app/views/search-view";
import { LibraryView } from "@/components/app/views/library-view";
import { SubscribeView } from "@/components/app/views/subscribe-view";
import { ProfileView } from "@/components/app/views/profile-view";
import { AdminView } from "@/components/app/views/admin-view";
import { DetailView } from "@/components/app/views/detail-view";
import { cn } from "@/lib/utils";

const STAFF_ROLES = ["ADMIN", "SUPER_ADMIN", "MODERATOR"];

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "home", label: "Accueil", icon: Home },
  { id: "search", label: "Recherche", icon: Search },
  { id: "library", label: "Bibliothèque", icon: LibraryBig },
  { id: "subscribe", label: "Packs", icon: Wallet },
  { id: "profile", label: "Profil", icon: UserRound },
];

const emptySubscribe = () => () => {};

export function AppShell() {
  // Détection d'hydratation sans setState dans un effet (règle react-hooks).
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const { user, accessToken, setMe } = useAuthStore();
  const { tab, setTab, detail } = useViewStore();

  useEffect(() => {
    ensureDeviceId();
  }, []);

  // Recharge /me au montage si une session existe (statut premium à jour).
  useEffect(() => {
    if (!mounted || !accessToken) return;
    api<MeResponse>("/api/auth/me")
      .then(setMe)
      .catch(() => undefined);
  }, [mounted]);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
      }),
    []
  );

  if (!mounted) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-zinc-950 text-zinc-400">
        <Disc3 className="h-8 w-8 animate-spin text-amber-500" />
      </div>
    );
  }

  const tabs: typeof TABS = user && STAFF_ROLES.includes(user.role)
    ? [...TABS, { id: "admin" as Tab, label: "Admin", icon: ShieldCheck }]
    : TABS;

  const activeTab: Tab = tab === "admin" && !STAFF_ROLES.includes(user?.role ?? "") ? "home" : tab;

  return (
    <QueryClientProvider client={queryClient}>
      <PlayerProvider>
        <div className="flex min-h-dvh flex-col bg-zinc-950 text-zinc-100">
        {!user || !accessToken ? (
          <main className="flex flex-1 items-center justify-center">
            <AuthView />
          </main>
        ) : (
          <>
            <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur">
              <div className="mx-auto flex max-w-3xl items-center justify-between">
                <button className="flex items-center gap-2" onClick={() => setTab("home")}>
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-black">
                    <Disc3 className="h-5 w-5" />
                  </span>
                  <span className="text-base font-black tracking-tight">
                    AENEWS <span className="text-amber-400">SOUND</span>
                  </span>
                </button>
                <HeaderStatus />
              </div>
            </header>

            <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-8 pt-4">
              {detail ? (
                <DetailView />
              ) : (
                <>
                  {activeTab === "home" && <HomeView />}
                  {activeTab === "search" && <SearchView />}
                  {activeTab === "library" && <LibraryView />}
                  {activeTab === "subscribe" && <SubscribeView />}
                  {activeTab === "profile" && <ProfileView />}
                  {activeTab === "admin" && STAFF_ROLES.includes(user.role) && <AdminView />}
                </>
              )}
            </main>

            <footer className="border-t border-zinc-900 px-4 py-2 text-center text-[11px] text-zinc-600">
              AENEWS SOUND — plateforme audio distribuée · streaming adaptatif · offline premium · mobile money
            </footer>

            <MiniPlayer />
            <FullPlayer />

            <nav
              className="sticky bottom-0 z-20 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur"
              style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
              aria-label="Navigation principale"
            >
              <div className="mx-auto flex max-w-3xl">
                {tabs.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors",
                      activeTab === id ? "text-amber-400" : "text-zinc-500 hover:text-zinc-300"
                    )}
                    aria-current={activeTab === id ? "page" : undefined}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </button>
                ))}
              </div>
            </nav>
          </>
        )}
      </div>
      </PlayerProvider>
    </QueryClientProvider>
  );
}

function HeaderStatus() {
  const entitlements = useAuthStore((s) => s.entitlements);
  const isPremium = entitlements?.isPremium ?? false;
  return isPremium ? (
    <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-bold text-amber-400 ring-1 ring-amber-500/40">
      PREMIUM
    </span>
  ) : (
    <button
      onClick={() => useViewStore.getState().setTab("subscribe")}
      className="rounded-full bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-zinc-300 ring-1 ring-zinc-700 hover:bg-zinc-700"
    >
      Activer un pack
    </button>
  );
}
