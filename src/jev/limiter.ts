export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: () => performance.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Global token bucket on two axes: requests/s and tokens/s (DESIGN §5: 30 req/s, 80k tok/s).
 * `acquire` waits until both buckets can cover the call. Callers are served in order.
 */
export class RateLimiter {
  private reqs: number;
  private toks: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rps: number,
    private readonly tps: number,
    private readonly clock: Clock = realClock,
  ) {
    this.reqs = rps;
    this.toks = tps;
    this.last = clock.now();
  }

  acquire(tokens: number): Promise<void> {
    const need = Math.min(Math.max(tokens, 0), this.tps);
    const turn = this.queue.then(() => this.take(need));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async take(need: number): Promise<void> {
    for (;;) {
      this.refill();
      if (this.reqs >= 1 && this.toks >= need) {
        this.reqs -= 1;
        this.toks -= need;
        return;
      }
      const waitReq = this.reqs >= 1 ? 0 : ((1 - this.reqs) / this.rps) * 1000;
      const waitTok = this.toks >= need ? 0 : ((need - this.toks) / this.tps) * 1000;
      await this.clock.sleep(Math.max(1, Math.ceil(Math.max(waitReq, waitTok))));
    }
  }

  private refill(): void {
    const now = this.clock.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    this.reqs = Math.min(this.rps, this.reqs + dt * this.rps);
    this.toks = Math.min(this.tps, this.toks + dt * this.tps);
  }
}

/** Rough token estimate for a JSON payload (~4 chars per token). */
export function estimateTokens(payload: unknown): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}
