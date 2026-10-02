"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Clock, Loader2, Smartphone, Wallet } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { useAuthStore, type MeResponse } from "@/lib/stores";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatCDF } from "@/components/app/ui-bits";
import { cn } from "@/lib/utils";

type Plan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  durationHours: number;
  priceMinor: number;
  currency: string;
  maxDevices: number;
};
type PlansResponse = { plans: Plan[] };
type InitiateResponse = {
  paymentId: string;
  status: string;
  providerRef: string;
  amountMinor: number;
  currency: string;
  phoneNumber: string;
  expiresAt: string | null;
  plan: { code: string; name: string };
};
type PaymentsResponse = {
  payments: {
    id: string;
    status: string;
    statusReason: string | null;
    amountMinor: number;
    currency: string;
    provider: string;
    plan: { code: string; name: string };
    createdAt: string;
  }[];
};
type GatewayResponse = { accepted: boolean; duplicate: boolean; status?: string };

export function SubscribeView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const entitlements = useAuthStore((s) => s.entitlements);
  const setMe = useAuthStore((s) => s.setMe);

  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [phone, setPhone] = useState(user?.phone ?? "+243");
  const [payment, setPayment] = useState<InitiateResponse | null>(null);
  const [pinStep, setPinStep] = useState(false);

  const plans = useQuery<PlansResponse>({
    queryKey: ["plans"],
    queryFn: () => api<PlansResponse>("/api/payments/plans", { auth: false }),
  });
  const payments = useQuery<PaymentsResponse>({
    queryKey: ["payments"],
    queryFn: () => api<PaymentsResponse>("/api/payments"),
  });

  const refreshMe = async () => {
    const me = await api<MeResponse>("/api/auth/me");
    setMe(me);
    void queryClient.invalidateQueries({ queryKey: ["payments"] });
  };

  // Clé d'idempotence STABLE par intention (v1.1 §27) : régénérée au changement
  // de plan, RÉUTILISÉE en cas de re-clic après un timeout réseau (sinon double
  // initiation), et remise à zéro après un paiement terminal (un nouvel achat
  // du même pack doit créer un NOUVEAU paiement, pas rejouer l'ancien).
  const intentKeyRef = useRef<{ plan: string; key: string } | null>(null);
  const idempotencyKeyFor = (planCode: string) => {
    if (intentKeyRef.current?.plan !== planCode) {
      intentKeyRef.current = { plan: planCode, key: `init-${planCode}-${crypto.randomUUID()}` };
    }
    return intentKeyRef.current.key;
  };

  const initiate = useMutation({
    mutationFn: async () => {
      const res = await api<InitiateResponse>("/api/payments/initiate", {
        method: "POST",
        body: { planCode: selectedPlan!.code, phoneNumber: phone },
        idempotencyKey: idempotencyKeyFor(selectedPlan!.code),
      });
      return res;
    },
    onSuccess: (res) => {
      setPayment(res);
      setPinStep(true);
    },
    onError: (e) =>
      toast({ title: e instanceof ApiClientError ? e.message : "Échec de l'initiation", variant: "destructive" }),
  });

  // Simulation passerelle agrégateur : le webhook signé est réellement traité.
  const gateway = useMutation({
    mutationFn: (outcome: "SUCCESS" | "FAIL") =>
      api<GatewayResponse>("/api/payments/sandbox/gateway", {
        method: "POST",
        body: { paymentRef: payment!.providerRef, outcome },
      }),
    onSuccess: async (res) => {
      if (res.status === "SUCCEEDED") {
        await refreshMe();
        toast({ title: "Pack activé 🎉", description: "Votre entitlement premium est actif." });
      } else {
        toast({ title: "Paiement refusé par l'opérateur (simulation)", variant: "destructive" });
      }
      setPinStep(false);
      setPayment(null);
      intentKeyRef.current = null;
      setSelectedPlan(null);
    },
    onError: (e) =>
      toast({ title: e instanceof ApiClientError ? e.message : "Erreur passerelle", variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-black tracking-tight">Packs premium</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Paiement mobile money (M-Pesa, Orange Money, Airtel Money) — packs prépayés,
          pas de prélèvement automatique.
        </p>
        {entitlements?.isPremium && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-400 ring-1 ring-amber-500/30">
            <BadgeCheck className="h-4 w-4" />
            Premium actif jusqu&apos;au{" "}
            <strong>{new Date(entitlements.premiumUntil!).toLocaleString("fr-FR")}</strong>
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {plans.data?.plans.map((plan) => (
          <button
            key={plan.id}
            onClick={() => {
              setSelectedPlan(plan);
              setPinStep(false);
              setPayment(null);
            }}
            className={cn(
              "rounded-2xl border p-4 text-left transition-all",
              selectedPlan?.id === plan.id
                ? "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/50"
                : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
            )}
          >
            <p className="text-sm font-bold">{plan.name}</p>
            <p className="mt-1 text-2xl font-black text-amber-400">{formatCDF(plan.priceMinor)}</p>
            <p className="mt-1 flex items-center gap-1 text-xs text-zinc-400">
              <Clock className="h-3 w-3" /> {plan.durationHours >= 24 ? `${plan.durationHours / 24} jours` : `${plan.durationHours} h`}
            </p>
            <p className="mt-2 text-xs text-zinc-500">{plan.description}</p>
          </button>
        ))}
      </div>

      {selectedPlan && !payment && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <Label className="text-sm">Numéro mobile money à débiter</Label>
          <div className="mt-2 flex gap-2">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+243…"
              className="bg-zinc-800 border-zinc-700"
            />
            <Button
              className="shrink-0 bg-amber-500 text-black hover:bg-amber-400"
              disabled={initiate.isPending}
              onClick={() => initiate.mutate()}
            >
              {initiate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
              Payer {formatCDF(selectedPlan.priceMinor)}
            </Button>
          </div>
        </div>
      )}

      {/* Étape USSD : en production, c'est le téléphone du client qui reçoit le push. */}
      <Dialog open={pinStep} onOpenChange={(v) => !v && setPinStep(false)}>
        <DialogContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-amber-400" /> Push USSD envoyé
            </DialogTitle>
          </DialogHeader>
          {payment && (
            <div className="space-y-4 text-sm">
              <p className="text-zinc-300">
                {payment.phoneNumber} — {payment.plan.name} —{" "}
                <strong className="text-amber-400">{formatCDF(payment.amountMinor)}</strong>
              </p>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-zinc-400">
                <p className="font-semibold text-amber-400">Passerelle agrégateur (simulation sandbox)</p>
                <p className="mt-1">
                  En production : le client valide son code PIN sur son téléphone, puis
                  l&apos;agrégateur (FlexPay/CinetPay…) appelle notre webhook signé. Ici, la
                  passerelle sandbox emprunte exactement le même chemin (signature HMAC +
                  traitement webhook idempotent).
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1 bg-amber-500 text-black hover:bg-amber-400"
                  disabled={gateway.isPending}
                  onClick={() => gateway.mutate("SUCCESS")}
                >
                  {gateway.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Entrer le PIN ✔ (succès)"}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 border-zinc-700"
                  disabled={gateway.isPending}
                  onClick={() => gateway.mutate("FAIL")}
                >
                  Simuler un échec
                </Button>
              </div>
              <p className="text-[11px] text-zinc-600">
                Référence : {payment.providerRef} · expiration :{" "}
                {payment.expiresAt ? new Date(payment.expiresAt).toLocaleTimeString("fr-FR") : "—"}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <section>
        <h2 className="mb-2 text-sm font-bold text-zinc-300">Historique des paiements</h2>
        {payments.data && payments.data.payments.length > 0 ? (
          <div className="space-y-2">
            {payments.data.payments.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-semibold">{p.plan.name}</p>
                  <p className="text-xs text-zinc-500">
                    {new Date(p.createdAt).toLocaleString("fr-FR")} · {p.provider}
                  </p>
                  {p.statusReason && <p className="text-xs text-zinc-600">{p.statusReason}</p>}
                </div>
                <div className="text-right">
                  <p className="font-bold text-amber-400">{formatCDF(p.amountMinor)}</p>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-bold",
                      p.status === "SUCCEEDED"
                        ? "bg-emerald-500/15 text-emerald-400"
                        : p.status === "FAILED" || p.status === "EXPIRED"
                          ? "bg-rose-500/15 text-rose-400"
                          : "bg-zinc-700/40 text-zinc-300"
                    )}
                  >
                    {p.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Aucun paiement pour l&apos;instant.</p>
        )}
      </section>
    </div>
  );
}
