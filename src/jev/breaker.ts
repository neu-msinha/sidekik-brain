import type { JevErrorKind } from "./types.js";

export type BreakerOptions = {
  /** Rate-limit (or unavailable) failures within `windowMs` that open the breaker. */
  failureTrips: number;
  windowMs: number;
  /** A successful call slower than this opens the breaker. */
  slowCallMs: number;
  /** How long the breaker stays open (traffic goes to the fallback). */
  openMs: number;
  now?: () => number;
};

export const DEFAULT_BREAKER: BreakerOptions = { failureTrips: 2, windowMs: 60_000, slowCallMs: 1500, openMs: 60_000 };

/** DESIGN §5: after two 429s or one call over 1.5 s, switch to the fallback for 60 s. */
export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions = DEFAULT_BREAKER) {
    this.now = opts.now ?? Date.now;
  }

  isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  recordSuccess(latencyMs: number): void {
    if (latencyMs > this.opts.slowCallMs) this.trip();
  }

  /** Returns true when this failure opened the breaker. */
  recordFailure(kind: JevErrorKind): boolean {
    if (kind === "bad_request") return false;
    if (kind === "timeout") {
      this.trip();
      return true;
    }
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < this.opts.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.opts.failureTrips) {
      this.trip();
      return true;
    }
    return false;
  }

  private trip(): void {
    this.openUntil = this.now() + this.opts.openMs;
    this.failures = [];
  }
}
