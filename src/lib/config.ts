// AENEWS SOUND — configuration runtime
// En production : AUTH_SECRET / SANDBOX_PROVIDER_SECRET via secrets manager (v1.1 §19).
// Sandbox : fallbacks de développement explicites, JAMAIS utilisés en production
// (fail-fast : l'application refuse de démarrer sans secret en production).

const DEV_AUTH_SECRET = "aenews-dev-secret-do-not-use-in-production-0001";
const DEV_SANDBOX_SECRET = "aenews-sandbox-gateway-secret-0002";

const isProduction = process.env.NODE_ENV === "production";

// Fail-fast (v1.1 §19) : les fallbacks de dev sont publics (repo) — ils ne
// doivent JAMAIS signer des JWT, des URLs signées ou des tokens chiffrés en prod.
const AUTH_SECRET_VALUE =
  process.env.AUTH_SECRET ?? (isProduction ? undefined : DEV_AUTH_SECRET);
if (!AUTH_SECRET_VALUE) {
  throw new Error(
    "AUTH_SECRET manquant — refus de démarrer en production (v1.1 §19 : secrets manager obligatoire)"
  );
}
export const AUTH_SECRET: string = AUTH_SECRET_VALUE;

// Secret de la passerelle SANDBOX (webhooks de démonstration). En production il
// est optionnel : la passerelle sandbox est désactivée et secretFor() échoue
// fermé si un callback SANDBOX arrivait malgré tout.
export const SANDBOX_PROVIDER_SECRET =
  process.env.SANDBOX_PROVIDER_SECRET ?? (isProduction ? undefined : DEV_SANDBOX_SECRET);

// Règle v1.1 : une écoute comptabilisée = 30 s minimum, dédupliquée.
export const VALIDATION_THRESHOLD_SECONDS = 30;

// Taux de royaltie par écoute validée, en unités mineures (CDF : 1 = 1 franc).
// 20 FC/écoute : évite l'écrasement par division entière du split (70/30).
// Validé : une valeur env non numérique ou négative retombe sur le défaut
// (sinon BigInt(NaN) ferait planter tout calcul de royaltie).
const RAW_ROYALTY_RATE = Number(process.env.ROYALTY_RATE_MINOR_PER_STREAM ?? 20);
export const ROYALTY_RATE_MINOR_PER_STREAM =
  Number.isFinite(RAW_ROYALTY_RATE) && RAW_ROYALTY_RATE > 0 ? Math.round(RAW_ROYALTY_RATE) : 20;

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 15; // 15 min
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 jours
export const STREAM_URL_TTL_SECONDS = 600; // URLs signées : expiration courte (v1.1 §19)
export const DOWNLOAD_URL_TTL_SECONDS = 3600;
export const PAYMENT_USSD_TIMEOUT_MINUTES = 15;
export const EVENTS_BATCH_MAX = 100;
export const FRAUD_VELOCITY_SESSIONS = 30; // sessions / 10 min
export const FRAUD_VELOCITY_WINDOW_MS = 10 * 60 * 1000;

// Tolérance d'horloge client acceptée sur les événements de lecture (au-delà,
// l'horodatage client est ignoré et remplacé par l'horloge serveur — la période
// de royaltie et les fenêtres de fraude ne doivent JAMAIS dépendre du client).
export const EVENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
