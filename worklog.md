# Worklog — AENEWS SOUND

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Produire le schéma Prisma complet AENEWS SOUND v1.1 (contrat de données pour API NestJS, workers, paiements, royalties, mobile)

Work Log:
- Relecture du contrat v1.1 : entitlemeents/paiements/royalties/événements/droits comme primitives ; règles « Payment ≠ droit » et « Écoute ≠ royalty »
- Écriture de `aenews-sound/prisma/schema.prisma` : 43 modèles, 42 enums, index et contraintes d'unicité, timestamps, statuts métier, argent en unités mineures (BigInt) + parts en basis points, ledger immuable, PK composite (id, occurredAt) pour la table d'événements
- Écriture de `aenews-sound/prisma/sql/001_playback_events_partitioning.sql` : conversion de PlaybackEvent en table partitionnée mensuelle (option A recommandée : DDL intégré à la migration --create-only)
- Validation CLI : `bunx prisma format` (OK) puis `bunx prisma validate` (provider postgresql) → 2 erreurs corrigées (references: [code] sur License.territory ; inverse playlistTracks ajouté sur Track) → « The schema is valid 🚀 »

Stage Summary:
- `schema.prisma` validé = contrat de données prêt pour les étapes 2→7 du plan (migrations, entitlements+payments, catalog, playback, upload, royalties)
- Décisions clés : PlaybackEvent sans FK (event store, inserts batchés) + PK composite imposée par le partitionnement PostgreSQL ; ValidatedListening ajouté comme pont append-only Playback→Royalties (dedupeKey {sessionId}:{trackId}, seuil 30 s) ; RoyaltyLine/AuditLog append-only avec corrections par REVERSAL ; Entitlement = source unique de vérité (Payment ne confère aucun droit) ; IdempotencyKey/WebhookEvent pour paiements mobile money idempotents ; soft-delete User + Restrict sur les records financiers (pas de cascade)
- Cible PostgreSQL 15+ exclusive (enums, Decimal, partitions) — incompatible SQLite volontairement

---
Task ID: 2
Agent: main (Z.ai Code)
Task: Implémentation tranches 1-9 de la v1.1 — plateforme AENEWS SOUND fonctionnelle (persistance réelle, API réelle, aucun mock)

Work Log:
- T1: prisma/schema.prisma adapté runtime SQLite (43 modèles, enums→String documentés, Json→String, PK composite PlaybackEvent) + db:push + génération client
- T2: src/lib/ — config.ts (secrets/tunable), api.ts (ApiError/handle/rateLimit), auth.ts (scrypt, JWT HS256 maison, rotation refresh + réutilisation→révocation famille), storage.ts (stockage privé db/storage, adaptateur interface R2), signed-url.ts (HMAC expiration courte), entitlements.ts (source unique de vérité, cumul packs, expiration paresseuse, révocation→downloads révoqués), payments.ts (idempotence, webhooks HMAC persistés idempotents, refund→révocation), fraud.ts (IMPOSSIBLE_PLAYBACK par sessions chevauchantes, VELOCITY_ANOMALY, seuil 30 s, dedupeKey session:track), royalties.ts (ledger append-only ENTRY/REVERSAL, splits shareBps, payouts, statements JSON), audit.ts, serialize.ts
- T3: prisma/seed.ts — comptes démo (admin/artiste/écouteur), provider SANDBOX, 3 packs CDF, 6 genres, 5 territoires, 3 feature flags, 2 artistes + 2 albums + 8 titres avec VRAIS fichiers WAV PCM générés (masters privés + variante progressive + waveforms JSON 400 buckets + artworks SVG), droits OWNERSHIP, payout method M-Pesa, période royaltie ouverte, 2 titres en modération
- T4: ~30 routes API — auth (signup/login/refresh/logout/me), catalogue (home/search/genres/artists/albums/tracks), stream signé avec Range 206, artwork public, playback (sessions, events/batch→fraude→validation), bibliothèque (favorites/follows/playlists/history/downloads), paiements (plans/initiate idempotent/sandbox gateway/webhook signé/historique), entitlements, admin (overview/modération/users/flags/payments+refund/royalties+ledger+payouts+statements/fraud)
- T5: SPA mono-route — stores zustand (auth persistant, player service central, navigation), api-client avec refresh automatique 401→rotation→retry, PlayerProvider (MediaSession, événements batchés 30 s/25, Buffer_stall, session lifecycle), MiniPlayer + FullPlayer drawer avec waveform cliquable, vues Auth/Home/Search/Library/Subscribe/Profile/Admin/Detail
- T6: Vérification navigateur (agent-browser) — 5 bugs trouvés et corrigés : (1) PlayerProvider non monté dans AppShell ; (2) imports STREAM_URL_TTL_SECONDS/DOWNLOAD_URL_TTL_SECONDS depuis le mauvais module ; (3) findUnique sur providerRef non-unique (sandbox gateway) ; (4) updateMany à 2 arguments (Prisma 6.19 exige {where,data}) + réconciliation du rapport orphelin ; (5) taux royaltie 1 FC écrasé par division entière → 20 FC/écoute + reset démo audité. Serveur démonisé (double-fork setsid → PPID 1) après corruption du cache Turbopack.
- Tests end-to-end vérifiés: login/rotation/réjeu→révocation famille (curl), lecture audio (stream 200 → GET signé 206 Range → session 201), événements batchés (4 events, 1 ValidatedListening), download gratuit→402 PREMIUM_REQUIRED, achat pack (initiate→USSD→gateway→webhook sig:true→SUCCEEDED→entitlement ACTIVE), download premium→201+licence, modération (2 titres approuvés→publiés visibles en accueil), royalties (4 lignes ENTRY split 70/30=14+6 FC, payout 40 FC, statement, APPROVE→SEND→CONFIRM→PAID), recherche, viewport mobile 390px (nav sticky, footer visible), lint 0 erreur.

Stage Summary:
- Plateforme verticale complète : Identity/Auth → Entitlements → Payments → Catalog → Media → Playback → Fraud → Royalties → Admin, le tout branché sur Prisma SQLite réel avec les invariants v1.1 (Payment≠droit ; écoute≠royalty ; ledger append-only ; URLs signées ; idempotence)
- Adaptations sandbox documentées (interfaces de production prêtes) : stockage local↔R2, WAV progressif↔HLS/FFmpeg, passerelle SANDBOX↔agrégateurs réels (même contrat webhook signé), recherche SQL↔Meilisearch, rate-limit mémoire↔Redis, partition mensuelle PlaybackEvent reportée à PostgreSQL (DDL fourni)
- Comptes démo: +243000000001/admin-aenews-2024, +243000000002/artiste-aenews-2024, +243000000003/ecoute-aenews-2024
- Scripts utilitaires: prisma/seed.ts, scripts/royalty-reset.ts, scripts/royalty-check.ts

---
Task ID: 3
Agent: main (Z.ai Code)
Task: PHASES 1-4 v1.1 — Architecture ExternalProvider multi-fournisseurs + intégration Spotify (recherche, identités, import contrôlé, sync, connexions utilisateur, back-office, frontend)

Work Log:
- Prisma : 4 nouveaux modèles (ExternalProviderConfig, ExternalCatalogIdentity — unicité double (provider,entityType,entityId)/(provider,entityType,externalId) anti-doublon, ExternalAccountConnection tokens chiffrés, ExternalSyncJob file idempotente) + db:push OK
- src/lib/external/ : types.ts (contrat ExternalCatalogProvider + ExternalArtist/Album/Track/SearchPage — le cœur ne dépend d'aucune implémentation), cache.ts (TTL différenciés artiste 24h/album 12h/titre 6h/recherche 5min + stats), rate-limit.ts (seau à jetons async), crypto.ts (AES-256-GCM, clé dérivée AUTH_SECRET, format v1:iv:tag:ct), registry.ts (auto-provision configs ; Spotify actif : réel si SPOTIFY_CLIENT_ID/SECRET présents sinon SandboxSpotifyProvider IDENTIFIÉ, badges visibles ; autres fournisseurs enregistrés INACTIFS sans simulacre)
- src/lib/external/spotify/ : api.ts (Client Credentials, expiration+marge 60s, timeout 10s, retry 429/5xx respect Retry-After, renouvellement 401, logs), mapper.ts (normalisation tolérante), catalog.ts (provider réel), sandbox.ts (jeu déterministe incluant le catalogue seedé ; deep links = URLs de recherche Spotify ouvrables), connection.ts (Authorization Code réel : state HMAC TTL 10min + échange code→tokens ; sandbox simulé explicite)
- Services : identity.ts (attach/detach/sync/list/mapExternalToEntities/getExternalLinks — sync ne détruit JAMAIS une donnée AENEWS, 404 provider = FAILED + diagnostic), import.ts (preview avec détection doublons + correspondances catalogue ; LINK et CREATE — ARTIST ACTIVE, ALBUM/TRACK DRAFT, métadonnées seules, audio 100% pipeline AENEWS), sync-worker.ts (idempotent, reprenable — réclamation RUNNING stale 5min, observable, MAX_ATTEMPTS, batch)
- API : /api/external/providers (auto-provision), /api/external/search (auth + rate limit 30/min, enrichissement linkedAenews), /api/external/connections (GET/DELETE, aucun token exposé), /api/external/connections/spotify/start + callback (OAuth réel ou sandbox simulé), /api/admin/external/identities (GET/POST/[id] DELETE/sync), /api/admin/external/import/preview + import, /api/admin/external/sync (GET file/POST planif/tick worker), /api/admin/external/catalog-candidates (y compris DRAFT)
- Fiches enrichies : /api/artists|albums|tracks/[id] renvoient externalLinks (provider + URL publique seulement)
- Frontend : search-view (scopes AENEWS|Spotify|Tous, rangées externes avec badges SPOTIFY/SANDBOX/Lié + liens), external-view.tsx (onglet admin Sources externes : statuts fournisseurs, recherche, dialog Gérer = aperçu métadonnées + association radio ou import CREATE avec rattachement artiste, table identités resync/dissocier, worker planifier/exécuter), profile-view (Connexions externes connecter/déconnecter Spotify), detail-view (chips « Aussi sur : SPOTIFY »)
- Bugs trouvés et corrigés : (1) worker passait providerId comme kind → « fournisseur désactivé », résolu via résolution config→provider ; (2) webhook paiements utilisait ok() sans l'importer (500 latent sur tout webhook réussi — bug préexistant sérieux corrigé) ; (3) enrich() entityType déduit de la mauvaise source ; (4) routes preview/import déstructuraient requireEnabledProvider comme un tuple ; (5) SectionHeader n'acceptait pas subtitle ; (6) types préexistants (transitionPayout, items[] downloads, showIndex boolean vs number, Buffer→Uint8Array waveform, handle élargi à Response) — tsc app désormais 100% propre
- E2E curl vérifié : providers auto-provision → login admin → recherche sandbox (Koffi Nazenga + Formule Kino…) → preview avec détection doublons (candidat « Koffi Nazenga ») → LINK sbx-art-001→artiste AENEWS → anti-doublon 409 EXTERNAL_ALREADY_LINKED (même externalId sur 2e artiste refusé) → CREATE Innoss'B ACTIVE + import titre « Kinshasa Makasi » DRAFT (métadonnées seules) → sync 3 jobs DONE, 2e tick = 0 traité (idempotence) → fiche artiste « Aussi sur SPOTIFY » → connexion utilisateur sandbox (tokens JAMAIS en clair en DB : v1:… AES-GCM vérifié) → dissociation : le titre DRAFT reste intact (non-destruction) → 401 sans auth, 403 non-admin → audit log EXTERNAL_* complet
- Navigateur vérifié (agent-browser) : login admin → recherche scopes AENEWS/Spotify → badge « Lié AENEWS » ouvre la fiche enrichie → admin Sources externes (statuts Spotify ACTIF+SANDBOX, autres INACTIFS) → dialog Gérer Fally Ipupa (aperçu followers/popularity, candidats, modes) → import CREATE → « Identités externes (3) » → profil : Connecter Spotify → Déconnecter → footer sticky vérifié 390px (push-down naturel, noGapBelow, noOverlap), console sans erreur (1 warning dialog corrigé), lint 0 erreur, tsc app 0 erreur

Stage Summary:
- Spotify intégré comme PREMIÈRE implémentation du système ExternalProvider : l'architecture est multi-fournisseurs (Apple Music/YouTube/Deezer/Audiomack enregistrés INACTIFS, interface unique) et ne sera jamais prisonnière de Spotify
- Règles absolues respectées et testées : métadonnées/liens seulement (aucun audio externe), imports = DRAFT passant par la modération AENEWS, sync non destructrice, anti-doublon DB, IDs externes jamais mélangés aux IDs internes, secrets uniquement via env (sandbox si absents, identifié), tokens utilisateurs chiffrés AES-GCM et jamais exposés
- 3 identités réelles en base (2 artistes liés/importés, 1 titre importé DRAFT), audit EXTERNAL_* tracé, file de sync fonctionnelle et observable
- En production : SPOTIFY_CLIENT_ID/SECRET/REDIRECT_URI activent le client réel sans aucun changement de code (même contrat, cache TTL, rate limiter, retries déjà en place) ; le worker in-process se déplace dans BullMQ sans changer les garanties

---
Task ID: 4
Agent: main (Z.ai Code)
Task: Création de l'app Spotify Developer « AenewsSound » + câblage credentials réels + diagnostic complet jusqu'à identification du blocage Premium

Work Log:
- Dashboard Spotify rempli avec l'utilisateur : nom AenewsSound, redirect URI corrigé de https://aenews.online (incorrect) vers https://aenews.online/api/external/connections/spotify/callback (route exacte du callback existant, vérifiée dans src/app/api/external/connections/spotify/{start,callback}/route.ts), APIs = Web API uniquement (l'utilisateur avait coché Web Playback SDK/Android/iOS/Ads API — décochés), mode développement
- .env : SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET ajoutés (.env* gitignore vérifié — secrets hors Git) ; SPOTIFY_REDIRECT_URI laissé commenté (fallback origin correct en prod)
- Diagnostic `invalid_client` (HTTP 400) : 4 tentatives token (header Basic, body params, délai propagation 20s, secret lu à l'écran vs copié-collé) — toutes rejetées
- Piège identifié et documenté : la sonde GET /authorize semblait valider le client_id (303→login) MAIS les contrôles (faux ID + redirect bogus → même 303) ont prouvé que Spotify valide ID/redirect_uri APRÈS login uniquement — la sonde ne prouvait rien
- Résolution : copier-coller TEXTE des deux valeurs (l'ID lu sur capture contenait plusieurs erreurs : 62c11f90660b4cfc86ddf8feefb54855 vs réel 62c1f190660b4cfe8deff8feefb54855) + rotation du secret
- Validation réelle : token Client Credentials OBTENU (Bearer 3600s, curl + scripts/spotify-token-check.ts créé — n'affiche jamais le secret, codes de sortie 1-6 documentés)
- Blocage découvert : Web API → HTTP 403 « Active premium subscription required for the owner of the app. When the subscription status changes, it can take a few hours before requests are allowed again » — politique Spotify : le compte PROPRIÉTAIRE de l'app doit avoir Premium actif
- .env remis en mode sandbox propre (creds commentées avec note datée + procédure de réactivation) pour éviter 403 en boucle dans l'app pendant l'attente

Stage Summary:
- Dashboard Spotify 100% conforme (redirect URI exact, Web API seule, app en dev mode) — credentials validés par Spotify (token réel obtenu)
- SEUL bloquant restant : abonnement Spotify Premium requis sur le compte propriétaire (décision business, aucun contournement technique légitime) ; déblocage automatique quelques heures après souscription, mêmes credentials
- Procédure de bascule documentée dans .env : décommenter SPOTIFY_CLIENT_ID/SECRET → redémarrer → registry bascule automatiquement sandbox→réel (aucun changement de code, cache TTL/rate limiter/retries déjà en place)
- scripts/spotify-token-check.ts : outil de vérification réutilisable (VPS deploiement) — auth + recherche réelle « Fally Ipupa », exit codes distincts par panne
- Leçon d'ingénierie enregistrée : ne JAMAIS saisir un ID/secret depuis une capture d'écran (police Spotify : f/1, c/e, 6/d confondables) ; toujours copier-coller texte + rotation en cas de doute
