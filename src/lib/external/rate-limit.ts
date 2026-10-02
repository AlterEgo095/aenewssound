// ============================================================================
// Rate limiter client pour API externes — seau à jetons asynchrone.
// Spotify (prod) : ~10 req/s max par application côté serveur ; on reste sous
// la limite avec une marge et on respecte Retry-After sur 429.
// ============================================================================

export class TokenBucketLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];

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
  }

  /** Attend qu'un jeton soit disponible puis le consomme. */
  async acquire(): Promise<void> {
    for (;;) {
      if (this.tryAcquire()) return;
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
        setTimeout(resolve, 250); // garde-fou anti-famine
      });
    }
  }

  private tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next?.();
      }
      return true;
    }
    return false;
  }

  get stats() {
    return { tokens: Math.floor(this.tokens), queued: this.queue.length };
  }
}
