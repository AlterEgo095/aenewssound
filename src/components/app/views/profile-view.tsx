"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, ShieldCheck, Smartphone, Unplug } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { useAuthStore, type MeResponse } from "@/lib/stores";
import { Button } from "@/components/ui/button";
import { PremiumChip } from "@/components/app/ui-bits";
import { useToast } from "@/hooks/use-toast";

type ConnectionsResponse = {
  connections: {
    id: string;
    provider: string;
    providerName: string;
    sandbox: boolean;
    externalAccountId: string;
    externalDisplayName: string | null;
    connectedAt: string;
  }[];
};

export function ProfileView() {
  const { user, entitlements, clear } = useAuthStore();
  const { toast } = useToast();
  const me = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => api<MeResponse>("/api/auth/me"),
  });
  const queryClient = useQueryClient();
  const connections = useQuery<ConnectionsResponse>({
    queryKey: ["external-connections"],
    queryFn: () => api<ConnectionsResponse>("/api/external/connections"),
  });

  const connectSpotify = useMutation({
    mutationFn: () =>
      api<{ mode: string; authorizeUrl?: string; sandbox?: boolean }>(
        "/api/external/connections/spotify/start"
      ),
    onSuccess: (res) => {
      if (res.mode === "PRODUCTION_OAUTH" && res.authorizeUrl) {
        window.location.href = res.authorizeUrl; // flux Authorization Code réel
        return;
      }
      toast({
        title: "Spotify connecté (sandbox simulé) — tokens chiffrés côté serveur",
      });
      void queryClient.invalidateQueries({ queryKey: ["external-connections"] });
    },
    onError: (e) =>
      toast({
        title: e instanceof ApiClientError ? e.message : "Connexion impossible",
        variant: "destructive",
      }),
  });

  const disconnect = useMutation({
    mutationFn: (provider: string) =>
      api(`/api/external/connections?provider=${provider}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Connexion externe supprimée" });
      void queryClient.invalidateQueries({ queryKey: ["external-connections"] });
    },
    onError: () => toast({ title: "Action impossible", variant: "destructive" }),
  });

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } catch {
      // on déconnecte localement même si l'API échoue
    }
    clear();
    toast({ title: "Déconnecté" });
  };

  const displayName = me.data?.user.displayName ?? user?.displayName ?? "—";

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-500 text-xl font-black text-black">
          {displayName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold">{displayName}</p>
          <p className="text-sm text-zinc-400">{me.data?.user.phone ?? user?.phone}</p>
          <div className="mt-1 flex items-center gap-2">
            <PremiumChip
              isPremium={entitlements?.isPremium ?? false}
              until={entitlements?.premiumUntil}
            />
            {user && ["ADMIN", "SUPER_ADMIN", "MODERATOR"].includes(user.role) && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400 ring-1 ring-emerald-500/30">
                <ShieldCheck className="h-3 w-3" /> {user.role}
              </span>
            )}
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-bold">Packs actifs</h2>
        {entitlements && entitlements.packs.length > 0 ? (
          <div className="space-y-2">
            {entitlements.packs.map((pack) => (
              <div key={pack.id} className="flex items-center justify-between text-sm">
                <span className="font-semibold">{pack.planCode ?? pack.source}</span>
                <span className="text-zinc-400">
                  jusqu&apos;au {new Date(pack.expiresAt).toLocaleString("fr-FR")}
                </span>
              </div>
            ))}
            <p className="text-xs text-zinc-500">
              Cumul des packs : l&apos;accès effectif expire à la date la plus lointaine.
            </p>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Aucun pack actif — streaming gratuit, téléchargements premium.</p>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-bold">Connexions externes</h2>
        {connections.data?.connections.map((c) => (
          <div
            key={c.id}
            className="mb-2 flex items-center justify-between rounded-xl border border-zinc-800 px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <p className="font-semibold">
                {c.providerName}
                {c.sandbox && (
                  <span className="ml-2 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-500">
                    Sandbox
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-zinc-500">
                {c.externalDisplayName ?? c.externalAccountId} · connecté le{" "}
                {new Date(c.connectedAt).toLocaleDateString("fr-FR")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-rose-500/40 text-rose-400"
              onClick={() => disconnect.mutate(c.provider)}
            >
              <Unplug className="mr-1 h-3.5 w-3.5" /> Déconnecter
            </Button>
          </div>
        ))}
        {!connections.data?.connections.some((c) => c.provider === "SPOTIFY") && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-500">
              Connectez votre compte Spotify pour les futures fonctionnalités de découverte
              (playlist, likes). AENEWS ne lit jamais l&apos;audio de Spotify.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-emerald-500/40 text-emerald-400"
              onClick={() => connectSpotify.mutate()}
              disabled={connectSpotify.isPending}
            >
              Connecter Spotify
            </Button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold">
          <Smartphone className="h-4 w-4 text-amber-400" /> Appareils &amp; sessions
        </h2>
        <div className="space-y-1 text-sm text-zinc-300">
          <p>Appareils enregistrés : <strong>{me.data?.deviceCount ?? "…"}</strong></p>
          <p>Sessions actives : <strong>{me.data?.activeSessions ?? "…"}</strong></p>
          <p className="text-xs text-zinc-500">
            Rotation des refresh tokens active — toute réutilisation déclenche la révocation
            de toutes les sessions (détection de vol).
          </p>
        </div>
      </section>

      <Button
        variant="outline"
        className="w-full border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
        onClick={() => void logout()}
      >
        <LogOut className="mr-2 h-4 w-4" /> Se déconnecter
      </Button>
    </div>
  );
}
