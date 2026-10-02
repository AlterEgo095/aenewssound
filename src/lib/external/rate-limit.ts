// ============================================================================
// Rate limiter client pour API externes — seau à jetons asynchrone.
// Spotify (prod) : ~10 req/s max par application côté serveur ; on reste sous
// la limite avec une marge et on respecte Retry-After sur 429.
//
// Sans fuite (audit v1.1) : chaque attente pousse UNE entrée {resolve, timer,
// active} ; les entrées abandonnées (timer de secours) sont purgées de la file
// au lieu de s'accumuler, et le réveil par refill ne consomme pas de jeton
// (le waiter réveillés retente tryAcquire lui-même — pas de double consommation).
// ============================================================================

type QueueEntry = {
  resolve: () => void;
  timer: NodeJS.Timeout;
  active: boolean;
};

export class TokenBucketLimiter {
  private tokens: number;
  private lastRefill: number;
  private waiters: QueueEntry[] = [];

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
      this.lastRefill = now;
    }
    // Un jeton disponible réveille UN waiter actif — il retente tryAcquire
    // lui-même (le réveil ne consomme rien).
    if (this.tokens >= 1) {
      this.wakeOne();
    }
  }

  private wakeOne() {
    while (this.waiters.length > 0) {
      const entry = this.waiters.shift()!;
      if (entry.active) {
        clearTimeout(entry.timer);
        entry.active = false;
        entry.resolve();
        return;
      }
      // entrée abandonnée (timer de secours déjà passé) : purgée, on continue
    }
  }

  /** Attend qu'un jeton soit disponible puis le consomme. */
  async acquire(): Promise<void> {
    for (;;) {
      if (this.tryAcquire()) return;
      await new Promise<void>((resolve) => {
        const entry: QueueEntry = {
          resolve,
          timer: setTimeout(() => {
            // Garde-fou anti-famine : abandon silencieux, la boucle retentera.
            entry.active = false;
            resolve();
          }, 250),
          active: true,
        };
        this.waiters.push(entry);
      });
    }
  }

  private tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  get stats() {
    return { tokens: Math.floor(this.tokens), queued: this.waiters.filter((w) => w.active).length };
  }
}
