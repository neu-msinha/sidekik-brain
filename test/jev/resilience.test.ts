import { describe, expect, it } from "vitest";
import { CircuitBreaker, DEFAULT_BREAKER } from "../../src/jev/breaker.js";
import { cacheKey, TtlLru } from "../../src/jev/cache.js";
import { RateLimiter, type Clock } from "../../src/jev/limiter.js";

function fakeClock(): Clock & { t: number; slept: number[] } {
  const c = {
    t: 0,
    slept: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
    },
  };
  return c;
}

describe("RateLimiter", () => {
  it("lets a burst through up to the request budget, then waits", async () => {
    const clock = fakeClock();
    const lim = new RateLimiter(3, 1_000_000, clock);
    for (let i = 0; i < 3; i++) await lim.acquire(10);
    expect(clock.slept).toEqual([]);
    await lim.acquire(10);
    expect(clock.t).toBeGreaterThanOrEqual(333);
  });

  it("waits for the token budget", async () => {
    const clock = fakeClock();
    const lim = new RateLimiter(100, 1000, clock);
    await lim.acquire(900);
    await lim.acquire(500); // needs 400 more tokens at 1000/s
    expect(clock.t).toBeGreaterThanOrEqual(400);
  });

  it("caps a single oversized call at the bucket size instead of waiting forever", async () => {
    const clock = fakeClock();
    const lim = new RateLimiter(10, 1000, clock);
    await lim.acquire(50_000);
    expect(clock.slept).toEqual([]);
  });
});

describe("CircuitBreaker", () => {
  const mk = () => {
    let now = 0;
    const b = new CircuitBreaker({ ...DEFAULT_BREAKER, now: () => now });
    return { b, at: (t: number) => (now = t) };
  };

  it("opens after two rate limits within the window, for 60 s", () => {
    const { b, at } = mk();
    expect(b.recordFailure("rate_limit")).toBe(false);
    at(10_000);
    expect(b.recordFailure("rate_limit")).toBe(true);
    expect(b.isOpen()).toBe(true);
    at(69_999);
    expect(b.isOpen()).toBe(true);
    at(70_000);
    expect(b.isOpen()).toBe(false);
  });

  it("doesn't count rate limits that are further apart than the window", () => {
    const { b, at } = mk();
    b.recordFailure("rate_limit");
    at(61_000);
    expect(b.recordFailure("rate_limit")).toBe(false);
  });

  it("opens on one timeout or one slow success; ignores bad requests", () => {
    const a = mk();
    a.b.recordFailure("timeout");
    expect(a.b.isOpen()).toBe(true);

    const s = mk();
    s.b.recordSuccess(1400);
    expect(s.b.isOpen()).toBe(false);
    s.b.recordSuccess(1600);
    expect(s.b.isOpen()).toBe(true);

    const r = mk();
    r.b.recordFailure("bad_request");
    r.b.recordFailure("bad_request");
    expect(r.b.isOpen()).toBe(false);
  });
});

describe("cache", () => {
  it("keys ignore object key order", () => {
    expect(cacheKey({ a: 1, b: { c: 2, d: 3 } }, "m")).toBe(cacheKey({ b: { d: 3, c: 2 }, a: 1 }, "m"));
    expect(cacheKey({ a: 1 }, "m")).not.toBe(cacheKey({ a: 1 }, "other-model"));
  });

  it("expires entries after the TTL and evicts the least recently used", () => {
    let now = 0;
    const lru = new TtlLru<string>(2, 60_000, () => now);
    lru.set("a", "A");
    lru.set("b", "B");
    lru.get("a"); // a is now most recent
    lru.set("c", "C"); // evicts b
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe("A");
    now = 60_000;
    expect(lru.get("a")).toBeUndefined();
  });
});
