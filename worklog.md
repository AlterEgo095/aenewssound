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

---
Task ID: 5
Agent: main (Z.ai Code)
Task: Déploiement du code sur github.com/AlterEgo095/aenewssound avec protocole anti-fuite de secrets

Work Log:
- Audit pré-push : découvert que .env (creds Spotify), db/custom.db, db/storage (audio/artworks), 4 captures d'écran upload/ (dont une avec secret affiché) et tool-results/ étaient TRACKÉS — le .gitignore ne s'applique pas aux fichiers déjà committs
- Décisif : git log -S a trouvé le secret Spotify ACTIF (dd4a8f2a…) dans l'historique local (commits f241b49, 6e201de) — un push direct l'aurait livré à GitHub
- Protocole appliqué : untrack (.env, db/, upload/, download/, tool-results/) → .gitignore étendu → vérification git grep --cached (0 secret dans l'arbre) → commit ORPHAN unique (history UUID du sandbox écartée) → force-push → reflog expire + gc --prune=now (purge locale définitive)
- Vérifié : ls-remote HEAD = local HEAD = c520aca ; origin configuré SANS token ; token GitHub utilisé inline uniquement (jamais écrit sur disque)

Stage Summary:
- github.com/AlterEgo095/aenewssound = 1 commit propre (c520aca), ~136 fichiers, zéro secret, zéro binaire runtime
- Recommandations transmises : rotation du PAT GitHub (passé en clair dans le chat), rotation du secret Spotify en hygiène (visible sur capture du chat mais jamais poussé)
- Déploiement VPS possible : git clone du repo + .env à recréer (jamais dans Git, par design)

---
Task ID: 6
Agent: main (Z.ai Code)
Task: README de dépôt + vérification exhaustive de la synchronisation GitHub

Work Log:
- Inventaire des variables d'environnement réellement utilisées (grep process.env) pour documenter avec exactitude : DATABASE_URL, AUTH_SECRET, SANDBOX_PROVIDER_SECRET, ROYALTY_RATE_MINOR_PER_STREAM, SPOTIFY_CLIENT_ID/SECRET/REDIRECT_URI
- README.md écrit (français) : deux règles d'or, tableau des fonctionnalités par domaine, stack, arborescence annotée, démarrage, env vars (sans valeurs), comptes démo, scripts ops, intégration Spotify multi-fournisseurs, tableau sandbox↔production, invariants de sécurité, feuille de route cochable
- Commit e21a7d5 poussé ; vérification : arbre propre, 179 fichiers trackés = 179 dans HEAD, hash local == hash distant (égalité de hash git = contenu identique garanti)

Stage Summary:
- Le dépôt github.com/AlterEgo095/aenewssound est la référence documentée du projet (README à jour de l'état réel, y compris le blocage Premium Spotify)
- Méthode de vérification réutilisable : rev-parse HEAD vs ls-remote (égalité de commit = preuve crypto du contenu identique)

---
Task ID: 7
Agent: main (Z.ai Code)
Task: AUDIT COMPLET pré-déploiement VPS (6 domaines, 15 105 lignes) + correction de l'intégralité des CRITIQUES et MAJEURS + revalidation E2E

Work Log:
- Audit statique : lint 0 erreur, tsc 0 erreur (après exclusion examples/skills hors produit — bloquait le build VPS), volume 15 105 lignes TS/TSX
- 6 audits parallèles (agents Explore) : money path 6.5/10, auth 7/10, royalties 5.5/10, external 8/10, frontend 7.5/10, cohérence 7/10 — 2 CRITIQUES, ~20 MAJEURS, ~40 MINEURS
- CRITIQUES corrigés : (C1) occurredAt 100 % client sur /events/batch → clamp ±5 min + horloge serveur pour période/fenêtres fraude ; (C2) validation instantanée → plausibilité horloge murale (occurredAt-startedAt ≥ seuil-5s) + IMPOSSIBLE_PLAYBACK élargi à toutes sessions chevauchantes (la spec dit « même user ») ; (F1-cohérence) Caddyfile sandbox = SSRF d'ingress → deploy/Caddyfile.prod sans XTransformPort + TLS + headers sécurité
- MONEY PATH durci : secretFor FAIL-CLOSED (503 si secret provider absent — plus jamais le secret sandbox public en fallback) ; signature AVANT dédoublonnage webhook (l'attaque « pré-enregistrer un eventId pour ignorer le vrai callback » est morte) ; transition SUCCEEDED conditionnelle ATOMIQUE (updateMany count===1) + grantEntitlement dans la MÊME $transaction (double entitlement impossible) ; REFUNDED→SUCCEEDED interdit ; contrôle de MONTANT du callback (409 si divergence) ; types inconnus → IGNORED ; refund TRANSACTIONNEL (payment+entitlements+downloads) ; withIdempotency : scope user+endpoint+expiry, claim atomique PROCESSING, libération sur échec
- PASSERELLE SANDBOX : kill-switch production (404), propriétaire du paiement requis (403), secret centralisé config
- AUTH durci : scrypt versionné scrypt$N$r$p$salt$hash (N=2^15, maxmem 64 Mo — bug params dépassement découvert au smoke test) + vérif legacy ; AUTH_SECRET fail-fast en production ; JWT alg figé HS256 ; refresh : rate limit 10/min + consommation conditionnelle (race → 409 propre) + audit reuse_detected/login/refresh ; anti-énumération timing (hash factice) ; rate limiter : purge sélective (plus de clear() destructeur) ; db log queries dev-only
- ROYALTIES intègres : CALCULATE + CREATE_PAYOUTS verrous ATOMIQUES (updateMany conditionnel) avec libération sur crash ; répartition splits PLUS FORT RESTE (Σnet === gross, réconciliation testée : 20/20) ; RETRY FAILED→PENDING (plus d'argent bloqué) ; agrégation par BÉNÉFICIAIRE (un payee multi-artistes = un payout + un statement, plus de crash @@unique) ; transitions payout verrou optimiste ; action admin CREATE_PERIOD (opérabilité) ; STATEMENT_URL corrigé (par payout, plus de filtre incohérent) ; scripts/royalty-reset.ts SUPPRIMÉ (détruisait le ledger)
- EVENTS/BATCH : $transaction + createMany atomiques, clientBatchId idempotent (rejeu réseau sans doublon), trackId validé (PUBLISHED), validationErrors RETOURNÉS, rate limits batch(30/min)+sessions(30/min) ; favoris/playlists : PUBLISHED requis ; fraud catch P2002-only
- EXTERNAL : import CREATE garde anti-doublon 409 + $transaction (plus d'entités orphelines) ; OAuth state lié à la session (cookie HttpOnly nonce + comparaison timing-safe, usage unique) ; TokenBucketLimiter sans fuite (purge des entrées abandonnées, réveil sans double consommation) ; ExternalProviderError mappée dans handle() (503/404/429 sémantiques)
- STREAMING : createReadStream borné au Range (plus de lecture complète par chunk), suffix range correct, no-store sur 206 ; artwork route standardisée handle()+contentTypeForKey+CSP
- FRONTEND : /me rechargé après login (deps accessToken) ; session close au skip (flush → PUT ordre strict) ; flush timer stoppé au démontage ; plus de perte d'events entre pistes ; toast d'erreur de lecture (fini le silent fail) ; MediaSession setPositionState (verrouillage) ; MiniPlayer sticky au-dessus de la nav (persistant au scroll, vérifié 390px) ; AlertDialogs de confirmation sur Rembourser/Bloquer/Suspendre/Confirmer payout ; clé d'idempotence stable par intention (retry réseau sans double push USSD, régénérée après paiement terminal) ; DEMO_ACCOUNTS absents du bundle prod ; refresh 5xx ne purge plus la session ; onError systématiques (library/detail) ; lang fr + favicon local ; boutons morts corrigés
- INFRA VPS : contrat PostgreSQL aligné (4 modèles External + enums PG + Json — prisma validate 🚀, 47 modèles) ; deploy/Caddyfile.prod (TLS auto, HSTS, webhook/stream flush) ; package.json rebrand aenews-sound 1.1.0 + postinstall prisma generate + db:seed ; next.config ignoreBuildErrors:false + strict mode ; robots.txt Disallow /api ; untrack .zscripts/examples/tests/mini-services (hors produit, gardés sur disque)
- Revalidation E2E curl : login (scrypt N=2^15) → rotation → réutilisation→401+révocation → home/search → initiate idempotent (rejeu même paiement) → clé réutilisée autre corps 409 → gateway→webhook→entitlement isPremium → signature invalide 401 → montant divergent 409 → validation instantanée REFUSÉE → écoute réelle 26s VALIDÉE → sessions parallèles IMPOSSIBLE_PLAYBACK → CALCULATE (réconciliation Σnet=gross) → premium download READY ; navigateur : login→home→lecture→miniplayer sticky scroll→390px→0 erreur console ; bugs découverts par le runtime corrigés au passage (scrypt maxmem, SQLite audit-tx deadlock P2028, secretFor source)

---
Task ID: 8
Agent: main (Z.ai Code)
Task: Décision produit « voie B » — lecteur YouTube PRIVÉ intégré (métadonnées Spotify + audio via lecteur officiel YouTube), usage strictement personnel ; activation fail-closed via YOUTUBE_API_KEY

Work Log:
- Contexte décisionnel : analyse du guide « Spotify metadata + YouTube audio » (clone gratuit) → 3 étages de risque juridique identifiés (CGU YouTube, extraction de flux, droits musicaux) → inutilisable en commercial, toléré en usage STRICTEMENT privé → l'utilisateur a confirmé « plateforme pour moi seul » puis choisi la voie B
- Backend src/lib/external/youtube/api.ts : client YouTube Data API v3 réel (search.list videoCategoryId=10 + videoEmbeddable=true, videos.list contentDetails pour durées ISO-8601 → filtrage lives), timeout 10s, retry 429/5xx, TokenBucketLimiter, cache mémoire 30 min (quota Google 10k/jour = ~100 recherches), erreur 403/400/404 avec hint actionnable, pages HTML d'erreur Google jamais exposées telles quelles
- Backend src/lib/external/youtube/private-player.ts : service LECTEUR PRIVÉ — getLinkedVideo (identité YOUTUBE_MUSIC/TRACK), resolveForTrack (lien mémorisé → sinon recherche « {artiste} {titre} audio »), linkVideo via attachIdentity EXISTANT (anti-doublon DB + audit EXTERNAL_IDENTITY_ATTACH + metadata purpose:PRIVATE_PLAYBACK), unlinkVideo (dissociation sans destruction), searchByQuery ; échec fermé 503 sans clé (aucune donnée simulée)
- Registry : YOUTUBE_MUSIC = rôle PRIVATE_PLAYBACK (activé ssi YOUTUBE_API_KEY, statut reflété idempotent à chaque démarrage), retiré de la liste des catalogue-providers en attente ; getCatalogProvider(YOUTUBE_MUSIC) → 501 avec message dédié (pas un fournisseur de catalogue)
- Routes : GET /api/external/youtube/search (auth, 10/min), GET resolve (auth, 20/min, mode LINKED|CANDIDATES|UNAVAILABLE), POST/DELETE link (requireAdmin, validation videoId ^[A-Za-z0-9_-]{6,20}$)
- Frontend src/lib/youtube-store.ts : store dédié (playTrack/playQuery/pick/close), mutual exclusion bidirectionnelle avec le lecteur AENEWS (pause getAudio() ↔ pauseVideo()), lien auto du premier candidat silencieux (échec 403 non-admin → lecture éphémère quand même)
- Frontend src/components/app/youtube-player.tsx : lecteur OFFICIEL YouTube (Iframe API chargée singleton, typage YT minimal sans dépendance), TOUJOURS VISIBLE (conformité CGU — jamais masqué), vignette agrandissable w-40↔w-64, sélecteur de version (candidats + recherche libre), erreurs YT 100/101/150 → toast + ouverture picker, destroy propre
- Entrées UI : TrackRow dropdown « Écouter sur YouTube (privé) » ; bouton YouTube sur les TITRES des résultats Spotify (playQuery éphémère sans lien) ; panneau ancré au-dessus du MiniPlayer dans le bloc sticky unique
- README : section « Mode privé — lecteur YouTube » (cadre légal binaire privé/public, fonctionnement, limites, procédure clé API + restriction IP), env var YOUTUBE_API_KEY, arborescence, feuille de route ; COMPTES DÉMO : mots de passe RETIRÉS du README public (connus du seed → consigne changement immédiat sur VPS) ; .env : bloc YOUTUBE_API_KEY commenté + procédure Google Cloud
- Bugs trouvés et corrigés : (1) relation Prisma Track.mainArtist (pas artist) ; (2) CRASH préexistant search-view `t.linkedAenews!.entityType` évalué pendant le rendu sur résultat TITRE non lié → null-safe (révélé par le test Spotify réel) ; (3) vignette en erreur affichait un spinner trompeur → icône neutre + line-clamp-3
- E2E curl : resolve→UNAVAILABLE avec raison, search→503 explicite, link→503 (provider désactivé), 401 sans auth, 403 non-admin, clé FAUSE → erreur Google réelle propagée avec hint, retour fail-closed après retrait ; navigateur (agent-browser) : login → dropdown → panneau erreur propre → admin Sources externes « YouTube (lecteur privé) INACTIF » → recherche Spotify fally → bouton YouTube → panneau → 390px (footer/lecteurs/nav sans overlap) + 1280px vérifiés → console sans erreur, lint 0, tsc 0
- Seed rejoué (base vide après protocole anti-fuite Git)

Stage Summary:
- La voie B est opérationnelle et JAMAIS déguisée : sans clé, tout échoue explicitement (503 + raison affichée dans l'UI) ; avec clé, aucune ligne de code ne change
- Invariants respectés : l'écoute YouTube ne génère AUCUN PlaybackEvent/ValidatedListening/RoyaltyLine (ledger intègre), aucun flux extrait (lecteur officiel visible uniquement), le lien titre→vidéo est une identité externe auditable et dissociable, le catalogue AENEWS reste la source propriétaire
- POUR ACTIVER : console.cloud.google.com → projet → YouTube Data API v3 → clé API (restriction API + IP VPS) → YOUTUBE_API_KEY dans .env → redémarrer ; quota ~100 recherches/jour (cache 30 min intégré)
- Limite documentée : la validité du mode privé est binaire (0 utilisateur tiers) — tout partage d'URL ou compte supplémentaire réimpose le régime commercial complet
