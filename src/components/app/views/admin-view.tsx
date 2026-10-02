"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Check, Download, Pause, Play, RefreshCw, ShieldAlert } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { formatCDF } from "@/components/app/ui-bits";
import { ExternalView } from "@/components/app/views/external-view";
import { cn } from "@/lib/utils";

// Bouton destructeur à double confirmation (audit v1.1 F4) : remboursement,
// blocage, suspension, confirmation de payout — aucun clic involontaire.
function ConfirmButton({
  label,
  icon,
  className,
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  icon?: React.ReactNode;
  className?: string;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline" className={className}>
          {icon}
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuler</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Overview = {
  users: number;
  publishedTracks: number;
  pendingTracks: number;
  paymentsSucceeded: number;
  grossRevenueMinor: number;
  openFraudFlags: number;
  pendingModerations: number;
};
type ModerationQueue = {
  queue: {
    reportId: string | null;
    reason: string | null;
    details: string | null;
    track: { id: string; title: string; artist: { name: string } };
  }[];
};
type AdminPayments = {
  payments: {
    id: string;
    user: { displayName: string; phone: string };
    status: string;
    amountMinor: number;
    currency: string;
    plan: { name: string };
    createdAt: string;
    providerRef: string | null;
  }[];
};
type RoyaltyPeriod = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  lines: {
    id: string;
    artist: { name: string };
    track: { title: string };
    validatedListeningCount: number;
    netAmountMinor: number;
  }[];
  payouts: {
    id: string;
    payee: { displayName: string };
    method: string | null;
    amountMinor: number;
    status: string;
    providerRef: string | null;
  }[];
  statementCount: number;
};
type RoyaltiesResponse = { periods: RoyaltyPeriod[] };
type FraudResponse = {
  flags: {
    id: string;
    rule: string;
    severity: string;
    status: string;
    subjectType: string;
    evidence: Record<string, unknown> | null;
    detectedAt: string;
  }[];
};
type AdminUsers = {
  users: {
    id: string;
    displayName: string;
    phone: string;
    role: string;
    status: string;
    payments: number;
    devices: number;
  }[];
};
type FlagsResponse = { flags: { id: string; key: string; description: string | null; enabled: boolean }[] };

export function AdminView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("overview");

  const overview = useQuery({ queryKey: ["admin-overview"], queryFn: () => api<Overview>("/api/admin/overview") });
  const moderation = useQuery({ queryKey: ["admin-moderation"], queryFn: () => api<ModerationQueue>("/api/admin/moderation") });
  const payments = useQuery({ queryKey: ["admin-payments"], queryFn: () => api<AdminPayments>("/api/admin/payments") });
  const royalties = useQuery({ queryKey: ["admin-royalties"], queryFn: () => api<RoyaltiesResponse>("/api/admin/royalties") });
  const fraud = useQuery({ queryKey: ["admin-fraud"], queryFn: () => api<FraudResponse>("/api/admin/fraud") });
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api<AdminUsers>("/api/admin/users"), enabled: tab === "users" });
  const flags = useQuery({ queryKey: ["admin-flags"], queryFn: () => api<FlagsResponse>("/api/admin/flags"), enabled: tab === "flags" });

  const invalidate = (...keys: string[]) =>
    keys.forEach((k) => void queryClient.invalidateQueries({ queryKey: [k] }));

  const onError = (e: unknown) =>
    toast({ title: e instanceof ApiClientError ? e.message : "Action impossible", variant: "destructive" });

  const moderate = useMutation({
    mutationFn: (vars: { trackId: string; outcome: "APPROVED" | "TAKEDOWN" }) =>
      api("/api/admin/moderation", { method: "POST", body: vars }),
    onSuccess: (_d, vars) => {
      toast({ title: vars.outcome === "APPROVED" ? "Titre publié" : "Titre bloqué" });
      invalidate("admin-moderation", "admin-overview");
    },
    onError,
  });

  const refund = useMutation({
    mutationFn: (paymentId: string) =>
      api("/api/admin/payments", { method: "POST", body: { paymentId, action: "REFUND" } }),
    onSuccess: () => {
      toast({ title: "Paiement remboursé — entitlements révoqués" });
      invalidate("admin-payments", "admin-overview");
    },
    onError,
  });

  const royaltyAction = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Record<string, unknown>>("/api/admin/royalties", { method: "POST", body }),
    onSuccess: (res, body) => {
      toast({ title: `Action ${String(body.action)} : ${JSON.stringify(res).slice(0, 80)}…` });
      invalidate("admin-royalties", "admin-overview");
    },
    onError,
  });

  const reviewFlag = useMutation({
    mutationFn: (vars: { flagId: string; decision: string }) =>
      api("/api/admin/fraud", { method: "POST", body: vars }),
    onSuccess: () => {
      toast({ title: "Décision enregistrée" });
      invalidate("admin-fraud", "admin-overview");
    },
    onError,
  });

  const toggleUser = useMutation({
    mutationFn: (vars: { userId: string; action: "SUSPEND" | "ACTIVATE" }) =>
      api("/api/admin/users", { method: "POST", body: vars }),
    onSuccess: () => {
      toast({ title: "Statut utilisateur mis à jour" });
      invalidate("admin-users");
    },
    onError,
  });

  const toggleFlag = useMutation({
    mutationFn: (vars: { key: string; enabled: boolean }) =>
      api("/api/admin/flags", { method: "POST", body: vars }),
    onSuccess: () => invalidate("admin-flags"),
    onError,
  });

  const stat = (label: string, value: string) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-xl font-black">{value}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-black tracking-tight">Back-office AENEWS</h1>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap bg-zinc-900">
          <TabsTrigger value="overview">Vue d&apos;ensemble</TabsTrigger>
          <TabsTrigger value="moderation">Modération</TabsTrigger>
          <TabsTrigger value="payments">Paiements</TabsTrigger>
          <TabsTrigger value="royalties">Royalties</TabsTrigger>
          <TabsTrigger value="fraud">Fraude</TabsTrigger>
          <TabsTrigger value="users">Utilisateurs</TabsTrigger>
          <TabsTrigger value="external">Sources externes</TabsTrigger>
          <TabsTrigger value="flags">Flags</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-3">
          {overview.data && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {stat("Utilisateurs", String(overview.data.users))}
              {stat("Titres publiés", String(overview.data.publishedTracks))}
              {stat("En modération", String(overview.data.pendingTracks))}
              {stat("Paiements OK", String(overview.data.paymentsSucceeded))}
              {stat("Revenus bruts", formatCDF(overview.data.grossRevenueMinor))}
              {stat("Flags fraude ouverts", String(overview.data.openFraudFlags))}
              {stat("Modérations en attente", String(overview.data.pendingModerations))}
              {stat("Périodes royaltie", String(royalties.data?.periods.length ?? 0))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="moderation" className="mt-3 space-y-2">
          {moderation.data?.queue.length === 0 && <p className="text-sm text-zinc-500">File vide.</p>}
          {moderation.data?.queue.map((item) => (
            <div key={item.track.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="font-semibold">{item.track.title} — {item.track.artist.name}</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {item.reason} · {item.details}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-500"
                  onClick={() => moderate.mutate({ trackId: item.track.id, outcome: "APPROVED" })}
                >
                  <Check className="mr-1 h-3.5 w-3.5" /> Approuver &amp; publier
                </Button>
                <ConfirmButton
                  label="Bloquer"
                  icon={<Ban className="mr-1 h-3.5 w-3.5" />}
                  className="border-rose-500/40 text-rose-400"
                  title="Bloquer ce titre ?"
                  description={`« ${item.track.title} » sera retiré de la diffusion publique (takedown).`}
                  confirmLabel="Bloquer le titre"
                  onConfirm={() => moderate.mutate({ trackId: item.track.id, outcome: "TAKEDOWN" })}
                />
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="payments" className="mt-3 space-y-2">
          {payments.data?.payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm">
              <div>
                <p className="font-semibold">{p.plan.name} — {formatCDF(p.amountMinor)}</p>
                <p className="text-xs text-zinc-500">
                  {p.user.displayName} · {new Date(p.createdAt).toLocaleString("fr-FR")} · {p.providerRef}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  className={cn(
                    p.status === "SUCCEEDED" && "bg-emerald-500/15 text-emerald-400",
                    p.status === "REFUNDED" && "bg-zinc-700 text-zinc-300",
                    p.status !== "SUCCEEDED" && p.status !== "REFUNDED" && "bg-zinc-700/40 text-zinc-300"
                  )}
                >
                  {p.status}
                </Badge>
                {p.status === "SUCCEEDED" && (
                  <ConfirmButton
                    label="Rembourser"
                    className="border-rose-500/40 text-rose-400"
                    title="Rembourser ce paiement ?"
                    description={`Le client sera remboursé de ${formatCDF(Number(p.amountMinor))} et l'accès premium associé sera révoqué immédiatement.`}
                    confirmLabel="Confirmer le remboursement"
                    onConfirm={() => refund.mutate(p.id)}
                  />
                )}
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="royalties" className="mt-3 space-y-3">
          {royalties.data?.periods.map((period) => (
            <div key={period.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">
                  {new Date(period.periodStart).toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
                </p>
                <Badge className="bg-zinc-800 text-zinc-300">{period.status}</Badge>
              </div>
              {period.lines.length > 0 && (
                <div className="mt-2 space-y-1 text-xs text-zinc-400">
                  {period.lines.slice(0, 5).map((line) => (
                    <p key={line.id}>
                      {line.artist.name} — « {line.track.title} » : {line.validatedListeningCount} écoutes validées ={" "}
                      <strong className="text-amber-400">{formatCDF(line.netAmountMinor)}</strong>
                    </p>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {period.status === "OPEN" && (
                  <Button size="sm" className="bg-amber-500 text-black hover:bg-amber-400" onClick={() => royaltyAction.mutate({ action: "CALCULATE", periodId: period.id })}>
                    Calculer le ledger
                  </Button>
                )}
                {period.status === "CLOSED" && (
                  <Button size="sm" className="bg-amber-500 text-black hover:bg-amber-400" onClick={() => royaltyAction.mutate({ action: "CREATE_PAYOUTS", periodId: period.id })}>
                    Générer les payouts
                  </Button>
                )}
                {period.statementCount > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-zinc-700"
                    onClick={async () => {
                      try {
                        const res = await api<{ statementUrl: string }>("/api/admin/royalties", {
                          method: "POST",
                          body: { action: "STATEMENT_URL", periodId: period.id },
                        });
                        window.open(res.statementUrl, "_blank");
                      } catch (e) {
                        onError(e);
                      }
                    }}
                  >
                    <Download className="mr-1 h-3.5 w-3.5" /> Relevé
                  </Button>
                )}
              </div>
              {period.payouts.map((payout) => (
                <div key={payout.id} className="mt-2 flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2 text-xs">
                  <div>
                    <p className="font-semibold text-zinc-200">
                      {payout.payee.displayName} — {formatCDF(payout.amountMinor)}
                    </p>
                    <p className="text-zinc-500">{payout.method} · {payout.providerRef ?? "—"}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge className="bg-zinc-800 text-zinc-300">{payout.status}</Badge>
                    {payout.status === "PENDING" && (
                      <Button size="sm" variant="outline" className="h-7 border-zinc-700" onClick={() => royaltyAction.mutate({ action: "PAYOUT_TRANSITION", payoutId: payout.id, transition: "APPROVE" })}>
                        Approuver
                      </Button>
                    )}
                    {payout.status === "APPROVED" && (
                      <Button size="sm" variant="outline" className="h-7 border-zinc-700" onClick={() => royaltyAction.mutate({ action: "PAYOUT_TRANSITION", payoutId: payout.id, transition: "SEND" })}>
                        <Play className="mr-1 h-3 w-3" /> Envoyer (MM)
                      </Button>
                    )}
                    {payout.status === "SENT" && (
                      <ConfirmButton
                        label="Confirmer réception"
                        icon={<Check className="mr-1 h-3 w-3" />}
                        className="h-7 bg-emerald-600 hover:bg-emerald-500"
                        title="Confirmer la réception des fonds ?"
                        description={`Le payout ${payout.id.slice(-8)} sera marqué CONFIRMED — vérifiez la réception réelle sur le compte mobile money avant de confirmer.`}
                        confirmLabel="Confirmer la réception"
                        onConfirm={() => royaltyAction.mutate({ action: "PAYOUT_TRANSITION", payoutId: payout.id, transition: "CONFIRM" })}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </TabsContent>

        <TabsContent value="fraud" className="mt-3 space-y-2">
          {fraud.data?.flags.length === 0 && (
            <p className="text-sm text-zinc-500">Aucun flag — le Fraud Engine tourne sur chaque batch d&apos;événements.</p>
          )}
          {fraud.data?.flags.map((flag) => (
            <div key={flag.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className={cn("h-4 w-4", flag.severity === "HIGH" ? "text-rose-400" : "text-amber-400")} />
                  {flag.rule}
                </p>
                <Badge className="bg-zinc-800 text-zinc-300">{flag.status}</Badge>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {flag.subjectType} · sévérité {flag.severity} · {new Date(flag.detectedAt).toLocaleString("fr-FR")}
                {flag.evidence ? ` · ${JSON.stringify(flag.evidence).slice(0, 90)}` : ""}
              </p>
              {flag.status !== "DISMISSED" && flag.status !== "CONFIRMED" && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="outline" className="h-7 border-rose-500/40 text-rose-400" onClick={() => reviewFlag.mutate({ flagId: flag.id, decision: "CONFIRM" })}>
                    <ShieldAlert className="mr-1 h-3 w-3" /> Confirmer
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 border-zinc-700" onClick={() => reviewFlag.mutate({ flagId: flag.id, decision: "DISMISS" })}>
                    Rejeter
                  </Button>
                </div>
              )}
            </div>
          ))}
        </TabsContent>

        <TabsContent value="users" className="mt-3 space-y-2">
          {users.data?.users.map((u) => (
            <div key={u.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm">
              <div>
                <p className="font-semibold">{u.displayName} <span className="ml-1 text-xs text-zinc-500">{u.role}</span></p>
                <p className="text-xs text-zinc-500">{u.phone} · {u.payments} paiements · {u.devices} appareils</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={u.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"}>
                  {u.status}
                </Badge>
                {u.status === "ACTIVE" ? (
                  <ConfirmButton
                    label="Suspendre"
                    icon={<Pause className="mr-1 h-3 w-3" />}
                    className="h-7 border-rose-500/40 text-rose-400"
                    title="Suspendre ce compte ?"
                    description={`${u.displayName} perdra immédiatement l'accès (sessions révoquées).`}
                    confirmLabel="Suspendre le compte"
                    onConfirm={() => toggleUser.mutate({ userId: u.id, action: "SUSPEND" })}
                  />
                ) : (
                  <Button size="sm" variant="outline" className="h-7 border-emerald-500/40 text-emerald-400" onClick={() => toggleUser.mutate({ userId: u.id, action: "ACTIVATE" })}>
                    <RefreshCw className="mr-1 h-3 w-3" /> Réactiver
                  </Button>
                )}
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="external" className="mt-3">
          <ExternalView />
        </TabsContent>

        <TabsContent value="flags" className="mt-3 space-y-2">
          {flags.data?.flags.map((flag) => (
            <div key={flag.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-sm">
              <div>
                <p className="font-mono text-xs font-semibold">{flag.key}</p>
                <p className="text-xs text-zinc-500">{flag.description}</p>
              </div>
              <Switch
                checked={flag.enabled}
                onCheckedChange={(enabled) => toggleFlag.mutate({ key: flag.key, enabled })}
                aria-label={`Basculer ${flag.key}`}
              />
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
