# AENEWS SOUND v1.1

**Plateforme de streaming audio souveraine pour la RDC** — moteur audio propriétaire, paiements mobile money, catalogue et droits gérés en propre, intégration externe multi-fournisseurs (Spotify en premier).

> Deux règles structurent toute la plateforme :
>
> 1. **Paiement ≠ Droit** — un paiement réussi ne confère rien par lui-même ; seul un `Entitlement` créé par le webhook donne accès, et l'accès effectif = `max(expiresAt)` des entitlements actifs cumulables.
> 2. **Écoute ≠ Royalty** — un `PlaybackEvent` ne devient une royalty qu'après le Fraud Engine (≥ 30 s, déduplication `session:track`), écrit en `RoyaltyLine` append-only, puis agrégée en `Payout`.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Stack technique](#stack-technique)
- [Structure du dépôt](#structure-du-dépôt)
- [Démarrage rapide](#démarrage-rapide)
- [Variables d'environnement](#variables-denvironnement)
- [Comptes de démonstration](#comptes-de-démonstration)
- [Scripts d'exploitation](#scripts-dexploitation)
- [Intégration Spotify (multi-fournisseurs)](#intégration-spotify-multi-fournisseurs)
- [Composants sandbox ↔ production](#composants-sandbox--production)
- [Sécurité — invariants appliqués](#sécurité--invariants-appliqués)
- [Feuille de route](#feuille-de-route)

---

## Fonctionnalités

| Domaine | Contenu |
|---|---|
| **Identité & Auth** | Inscription/connexion téléphone + mot de passe (scrypt), JWT HS256, rotation des refresh tokens avec détection de réutilisation → révocation de la famille, sessions traçables |
| **Entitlements** | Source unique de vérité d'accès ; packs cumulables ; expiration paresseuse ; révocation en cascade vers les téléchargements hors-ligne |
| **Paiements** | Packs CDF via mobile money ; init idempotente (`Idempotency-Key`) ; webhook signé HMAC persisté et rejouable ; refund → révocation ; passerelle sandbox au contrat identique aux agrégateurs réels |
| **Catalogue** | Artistes / albums / titres / genres / territoires ; fiche enrichie « Aussi sur » ; modération ; artworks par type de propriétaire |
| **Audio & Lecture** | Masters privés jamais exposés ; URLs signées HMAC à TTL court ; streaming `Range 206` ; waveforms cliquables ; sessions de lecture ; événements batchés (30 s / 25) ; MediaSession verrouillage |
| **Fraud Engine** | `IMPOSSIBLE_PLAYBACK` (sessions chevauchantes), `VELOCITY_ANOMALY`, seuil 30 s, déduplication stricte, audit complet |
| **Royalties** | Ledger append-only (`ENTRY` / `REVERSAL` auto-référencé), splits en basis points, périodes, payouts (`APPROVE → SEND → CONFIRM → PAID`), statements JSON |
| **Administration** | Vue d'ensemble, modération, utilisateurs, feature flags, paiements + remboursements, fraudes, royalties + ledger + payouts, sources externes |
| **Fournisseurs externes** | Architecture `ExternalProvider` multi-fournisseurs : recherche, import contrôlé (jamais aveugle), identités externes anti-doublon, worker de sync non destructif, connexions utilisateur OAuth chiffrées |

## Stack technique

- **Next.js 16** (App Router) + **TypeScript** strict
- **Tailwind CSS 4** + **shadcn/ui** (New York) + Lucide
- **Prisma** (runtime SQLite ; contrat PostgreSQL 15+ dans `aenews-sound/`)
- **Zustand** (état client) — mono-route SPA avec shell applicatif
- Auth maison (scrypt + JWT) sans dépendance externe
- Bun comme runtime/gestionnaire

## Structure du dépôt

```
├── prisma/                  # schéma runtime + seed démo (catalogue + audio WAV réels)
│   └── sql/                 # DDL partitionnement mensuel PlaybackEvent (PostgreSQL)
├── aenews-sound/            # CONTRAT PostgreSQL 15+ v1.1 (43 modèles / 42 enums) — cible prod
├── src/
│   ├── app/api/             # ~40 routes API réelles (auth, catalogue, playback, paiements,
│   │                        #   entitlements, admin, external/*)
│   ├── app/                 # SPA mono-route (page.tsx) + layout
│   ├── components/app/      # shell, player (MediaSession, waveforms), vues (Home, Search,
│   │                        #   Library, Subscribe, Profile, Admin, Detail, Auth, External)
│   ├── components/ui/       # shadcn/ui
│   └── lib/
│       ├── auth.ts          # scrypt, JWT, rotation refresh, révocation de famille
│       ├── entitlements.ts  # source unique de vérité d'accès
│       ├── payments.ts      # idempotence, webhooks HMAC persistés, refunds
│       ├── fraud.ts         # détection (sessions chevauchantes, vélocité)
│       ├── royalties.ts     # ledger append-only, splits, payouts, statements
│       ├── signed-url.ts    # URLs signées HMAC (stream / download / artwork)
│       ├── external/        # ARCHITECTURE MULTI-FOURNISSEURS
│       │   ├── types.ts     #   contrat provider-agnostic (le cœur n'importe jamais Spotify)
│       │   ├── registry.ts  #   registre + bascule sandbox↔réel automatique
│       │   ├── identity.ts  #   identités externes (attach/sync/list — non destructif)
│       │   ├── import.ts    #   import contrôlé (preview, détection doublons, CREATE/LINK)
│       │   ├── sync-worker.ts # file idempotente, reprenable, observable
│       │   ├── cache.ts     #   TTL différenciés (artiste 24h / album 12h / titre 6h / search 5min)
│       │   ├── rate-limit.ts#   seau à jetons
│       │   ├── crypto.ts    #   AES-256-GCM (tokens utilisateurs jamais en clair)
│       │   └── spotify/     #   api / catalog / mapper / connection / sandbox IDENTIFIÉ
│       └── ...
├── scripts/                 # ops : royalty-check, royalty-reset, spotify-token-check
├── tests/                   # harness sandbox
├── mini-services/           # services annexes (websocket…)
└── worklog.md               # journal de travail détaillé par tâche
```

## Démarrage rapide

```bash
bun install
bun run db:push        # crée le schéma SQLite
bun run prisma/seed.ts # catalogue démo + comptes + audio WAV réels
bun run dev            # http://localhost:3000
```

> Sur un poste vierge, créez d'abord `.env` (voir ci-dessous) avec au minimum `DATABASE_URL` et `AUTH_SECRET`.

## Variables d'environnement

Toutes les secrets passent par l'environnement — **jamais dans le code, jamais dans Git** (`.env*` est ignoré).

| Variable | Rôle | Statut |
|---|---|---|
| `DATABASE_URL` | Connexion base (SQLite runtime, PostgreSQL en prod) | requis |
| `AUTH_SECRET` | Clé racine de dérivation (JWT, HMAC des URLs signées, AES-GCM des tokens externes, states OAuth) | requis en prod |
| `SANDBOX_PROVIDER_SECRET` | Secret de signature de la passerelle de paiement sandbox | dev/sandbox |
| `ROYALTY_RATE_MINOR_PER_STREAM` | Taux par écoute validée, en unités mineures (CDF) | optionnel (défaut code) |
| `SPOTIFY_CLIENT_ID` | Identifiant de l'app Spotify Developer | optionnel — déclenche le client réel |
| `SPOTIFY_CLIENT_SECRET` | Secret de l'app Spotify (jamais exposé au frontend) | optionnel — idem |
| `SPOTIFY_REDIRECT_URI` | Callback OAuth utilisateur (`https://<domaine>/api/external/connections/spotify/callback`) | optionnel (fallback : origine de la requête) |

**Sans credentials Spotify**, le registre installe automatiquement `SandboxSpotifyProvider` — clairement identifié (`sandbox: true`, badges visibles dans l'UI). Avec credentials, il bascule sur le client réel sans aucun changement de code.

## Comptes de démonstration

Créés par le seed (à changer avant toute exposition publique) :

| Téléphone | Mot de passe | Rôle |
|---|---|---|
| `+243000000001` | `admin-aenews-2024` | Administrateur |
| `+243000000002` | `artiste-aenews-2024` | Artiste |
| `+243000000003` | `ecoute-aenews-2024` | Auditeur |

## Scripts d'exploitation

```bash
bun scripts/spotify-token-check.ts   # auth réelle + recherche réelle Spotify
                                     # (exit codes 1-6 : panne distincte par étape ;
                                     #  n'affiche jamais le secret)
bun scripts/royalty-check.ts         # cohérence ledger / payouts / statements
bun scripts/royalty-reset.ts         # réinitialisation audité de la démo royalties
```

## Intégration Spotify (multi-fournisseurs)

Spotify est la **première implémentation** du système `ExternalProvider` — pas une dépendance :

- **Le cœur métier n'importe jamais Spotify** : tout passe par `ExternalCatalogProvider` (`registry.getCatalogProvider(kind)`). Apple Music, YouTube Music, Deezer, Audiomack sont enregistrés *inactifs* — prêts pour leurs adaptateurs.
- **Usages autorisés** : métadonnées, découverte, correspondance d'identités, deep links, connexion optionnelle du compte utilisateur. **Aucun audio Spotify ne transite jamais par AENEWS** (pas de re-diffusion, pas de proxy, pas de téléchargement).
- **Identités externes** : `ExternalCatalogIdentity` relie un objet AENEWS à N fournisseurs, avec anti-doublon double-face `(provider, entityType, entityId)` / `(provider, entityType, externalId)` ; les IDs externes ne sont jamais mélangés aux IDs internes.
- **Import contrôlé** : recherche → aperçu des métadonnées + détection de doublons/correspondances → CREATE (artiste ACTIF, album/titre DRAFT à modérer) ou LINK vers l'existant — jamais d'import aveugle ; l'audio reste 100 % pipeline AENEWS.
- **Sync non destructive** : la disparition temporaire d'une donnée chez Spotify ne supprime **jamais** une donnée AENEWS (jobs idempotents, reprises, observables).
- **Connexions utilisateur** : Authorization Code + state HMAC (TTL 10 min) ; tokens chiffrés AES-256-GCM au repos ; jamais renvoyés au frontend.
- **État actuel** : credentials validés (token réel obtenu) ; Spotify exige désormais un **abonnement Premium actif sur le compte propriétaire de l'app** pour servir l'API Web — bascule automatique quelques heures après souscription, mêmes credentials.

## Composants sandbox ↔ production

Chaque substitut sandbox est **explicitement identifié** dans l'UI et les données — jamais déguisé en production :

| Composant | Aujourd'hui (sandbox) | Cible production |
|---|---|---|
| Base de données | SQLite (Prisma) | **PostgreSQL 15+** (contrat dans `aenews-sound/`, partitionnement mensuel `PlaybackEvent`) |
| Passerelle de paiement | Passerelle SANDBOX signée (même contrat webhook que les agrégateurs) | FlexPay / CinetPay / Flutterwave (RDC : M-Pesa, Orange Money, Airtel Money) |
| Livraison audio | WAV progressif local + URLs signées | **FFmpeg → HLS multi-variants → R2 privé → CDN** (master jamais public) |
| Recherche | SQL (LIKE) | **Meilisearch** |
| File de sync/queues | Worker in-process observable | **BullMQ + Redis** |
| Rate limiting | Mémoire | Redis |
| Stockage médias | `db/storage` privé | **Cloudflare R2** + CDN |

## Sécurité — invariants appliqués

- Secrets exclusivement via variables d'environnement ; `.env*` ignoré par Git ; tokens OAuth utilisateurs chiffrés AES-256-GCM au repos, jamais renvoyés au client.
- Masters audio privés ; seules des URLs signées (HMAC, TTL court) exposent les médias ; le master n'est jamais servi.
- Webhooks de paiement persistés *systématiquement* (même invalides), idempotents par `(provider, eventId)` ; seul `SUCCEEDED` vérifié crée un entitlement.
- `RoyaltyLine` append-only : toute correction passe par une `REVERSAL` référencée — rien n'est jamais édité ni supprimé.
- Rotation des refresh tokens avec chaîne de confiance : une réutilisation détectée révoque toute la famille de sessions.
- RBAC sur toutes les routes admin (401 sans session, 403 hors rôle) ; audit log `EXTERNAL_*` / financier complet.
- Le backend seul parle aux fournisseurs externes et aux secrets ; le frontend ne contient aucune logique d'autorisation.

## Feuille de route

- [x] Contrat de données v1.1 (43 modèles, 2 règles d'or)
- [x] Chaîne verticale complète : Auth → Entitlements → Paiements → Catalogue → Lecture → Fraude → Royalties → Admin
- [x] Architecture `ExternalProvider` + Spotify (sandbox identifié / réel prêt)
- [x] Frontend mobile-first (player, waveforms, offline flag, admin, sources externes)
- [ ] Activation Spotify réel (Premium owner) + quota étendu si besoin
- [ ] Migration **PostgreSQL 15+** + partitionnement mensuel `PlaybackEvent` automatisé
- [ ] Passerelles mobile money réelles (matrix de tests paiements/webhooks/entitlements)
- [ ] Pipeline audio production (R2/CDN/HLS + validation master)
- [ ] Client mobile natif (react-native-track-player, lecture arrière-plan, hors-ligne licencié)
- [ ] E2E global + durcissement production (observabilité par module)

---

© AENEWS — projet propriétaire. Les données Spotify restent la propriété de leurs détenteurs ; aucun contenu audio externe n'est stocké ni re-diffusé.
