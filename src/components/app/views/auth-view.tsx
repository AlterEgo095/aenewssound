"use client";

import { useState } from "react";
import { Disc3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { useAuthStore, type MeResponse } from "@/lib/stores";

type AuthResponse = MeResponse & { accessToken: string; refreshToken: string };

// Comptes de démonstration : JAMAIS compilés dans le bundle de production
// (le mot de passe admin livré à chaque visiteur serait une compromission
// immédiate). En production : aucun raccourci de login.
const DEMO_ACCOUNTS =
  process.env.NODE_ENV === "production"
    ? []
    : [
        { label: "Écouteur démo", phone: "+243000000003", password: "ecoute-aenews-2024" },
        { label: "Admin", phone: "+243000000001", password: "admin-aenews-2024" },
        { label: "Artiste", phone: "+243000000002", password: "artiste-aenews-2024" },
      ];

export function AuthView() {
  const setSession = useAuthStore((s) => s.setSession);
  const { toast } = useToast();
  const [loginPhone, setLoginPhone] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signupPhone, setSignupPhone] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupName, setSignupName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (mode: "login" | "signup") => {
    setBusy(true);
    try {
      const data =
        mode === "login"
          ? await api<AuthResponse>("/api/auth/login", {
              auth: false,
              method: "POST",
              body: { phone: loginPhone, password: loginPassword },
            })
          : await api<AuthResponse>("/api/auth/signup", {
              auth: false,
              method: "POST",
              body: { phone: signupPhone, password: signupPassword, displayName: signupName, country: "CD" },
            });
      setSession({
        user: data.user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      });
      toast({ title: `Bienvenue, ${data.user.displayName} !` });
    } catch (e) {
      toast({
        title: e instanceof ApiClientError ? e.message : "Erreur de connexion",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm px-4 py-10">
      <div className="mb-8 text-center">
        <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500 text-black">
          <Disc3 className="h-9 w-9" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">
          AENEWS <span className="text-amber-400">SOUND</span>
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Le son du Congo — streaming adaptatif, offline premium, mobile money.
        </p>
      </div>

      <Tabs defaultValue="login" className="w-full">
        <TabsList className="grid w-full grid-cols-2 bg-zinc-900">
          <TabsTrigger value="login">Connexion</TabsTrigger>
          <TabsTrigger value="signup">Créer un compte</TabsTrigger>
        </TabsList>
        <TabsContent value="login" className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="login-phone">Téléphone (E.164)</Label>
            <Input
              id="login-phone"
              placeholder="+243…"
              className="bg-zinc-900 border-zinc-800"
              value={loginPhone}
              onChange={(e) => setLoginPhone(e.target.value)}
              autoComplete="tel"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="login-password">Mot de passe</Label>
            <Input
              id="login-password"
              type="password"
              className="bg-zinc-900 border-zinc-800"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              autoComplete="current-password"
              onKeyDown={(e) => e.key === "Enter" && !busy && void submit("login")}
            />
          </div>
          <Button
            className="w-full bg-amber-500 text-black hover:bg-amber-400"
            disabled={busy}
            onClick={() => void submit("login")}
          >
            Se connecter
          </Button>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
            <p className="mb-2 text-xs font-semibold text-zinc-400">Comptes de démonstration</p>
            <div className="flex flex-wrap gap-2">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.phone}
                  className="rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                  onClick={() => {
                    setLoginPhone(acc.phone);
                    setLoginPassword(acc.password);
                  }}
                  type="button"
                >
                  {acc.label}
                </button>
              ))}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="signup" className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="signup-name">Nom d&apos;affichage</Label>
            <Input
              id="signup-name"
              className="bg-zinc-900 border-zinc-800"
              value={signupName}
              onChange={(e) => setSignupName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="signup-phone">Téléphone (E.164)</Label>
            <Input
              id="signup-phone"
              placeholder="+243…"
              className="bg-zinc-900 border-zinc-800"
              value={signupPhone}
              onChange={(e) => setSignupPhone(e.target.value)}
              autoComplete="tel"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="signup-password">Mot de passe (8+ caractères)</Label>
            <Input
              id="signup-password"
              type="password"
              className="bg-zinc-900 border-zinc-800"
              value={signupPassword}
              onChange={(e) => setSignupPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <Button
            className="w-full bg-amber-500 text-black hover:bg-amber-400"
            disabled={busy}
            onClick={() => void submit("signup")}
          >
            Créer mon compte
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}
