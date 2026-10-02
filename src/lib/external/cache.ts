// ============================================================================
// Cache provider externe — mémoire par instance (production : Redis même
// interface, v1.1 §10). TTL différenciés : artiste > album > titre > recherche.
// Objectifs : réduire les appels API, la latence, et respecter les limites.
// ============================================================================

type Entry = { value: unknown; expiresAt: number };

const store = new Map<string, Entry>();
const MAX_ENTRIES = 5_000;

export const DEFAULT_TTL_SECONDS: Record<string, number> = {
  ARTIST: 24 * 3600, // biographie/genres bougent peu
  ALBUM: 12 * 3600,
  TRACK: 6 * 3600,
  SEARCH: 5 * 60, // résultats de recherche volatils
};

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (store.size >= MAX_ENTRIES) {
    // évince d'abord les expirés, sinon le plus ancien
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt < now) store.delete(k);
      if (store.size < MAX_ENTRIES) break;
    }
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const entry of store.values()) if (entry.expiresAt >= now) live += 1;
  return { size: store.size, live };
}

/** Wrapper « get-or-fetch » — évite les appels identiques répétés. */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await fetcher();
  cacheSet(key, value, ttlSeconds);
  return value;
}
