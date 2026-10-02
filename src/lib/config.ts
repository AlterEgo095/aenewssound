// AENEWS SOUND — configuration runtime
// En production : AUTH_SECRET / SANDBOX_PROVIDER_SECRET via secrets manager (v1.1 §19).
// Sandbox : fallbacks de développement explicites.

export const AUTH_SECRET =
  process.env.AUTH_SECRET || "aenews-dev-secret-do-not-use-in-production-0001";

// Secret du gateway agrégateur sandbox (signe les webhooks de démonstration).
// En prod, chaque vrai provider a son propre secret (FLEXPAY_SECRET, etc.).
export const SANDBOX_PROVIDER_SECRET =
  process.env.SANDBOX_PROVIDER_SECRET || "aenews-sandbox-gateway-secret-0002";

// Règle v1.1 : une écoute comptabilisée = 30 s minimum, dédupliquée.
export const VALIDATION_THRESHOLD_SECONDS = 30;

// Taux de royaltie par écoute validée, en unités mineures (CDF : 1 = 1 franc).
// 20 FC/écoute : évite l'écrasement par division entière du split (70/30).
// En production : paramétré par période dans le back-office admin.
export const ROYALTY_RATE_MINOR_PER_STREAM = Number(
  process.env.ROYALTY_RATE_MINOR_PER_STREAM ?? 20
);

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 15; // 15 min
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 jours
export const STREAM_URL_TTL_SECONDS = 600; // URLs signées : expiration courte (v1.1 §19)
export const DOWNLOAD_URL_TTL_SECONDS = 3600;
export const PAYMENT_USSD_TIMEOUT_MINUTES = 15;
export const EVENTS_BATCH_MAX = 100;
export const FRAUD_VELOCITY_SESSIONS = 30; // sessions / 10 min
export const FRAUD_VELOCITY_WINDOW_MS = 10 * 60 * 1000;
