import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFixture, replayFixture } from "../scripts/replay.js";
import { startBrain, type Brain } from "../src/app.js";
import { loadBrainEnv } from "../src/env.js";
import { silentLogger } from "./helpers.js";

// End-to-end over real Redis (dev/docker-compose.yml). DB 14 keeps it away from dev data.
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/14";
const FIXTURE = fileURLToPath(new URL("./fixtures/capture_mini.jsonl", import.meta.url));

let brain: Brain;

beforeAll(async () => {
  const admin = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await admin.connect();
    await admin.flushdb();
  } catch {
    throw new Error(`Redis not reachable at ${REDIS_URL}. Run: docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis`);
  } finally {
    admin.disconnect();
  }
  const env = loadBrainEnv({
    PORT: "18082",
    REDIS_URL,
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    SK_INTERNAL_TOKEN: "test-internal-token-1234",
    GATEWAY_INTERNAL_URL: "http://localhost:8080",
    PERSISTENCE: "memory",
  });
  brain = await startBrain(env, { listen: false, logger: silentLogger() });
});

afterAll(async () => {
  await brain?.close();
});

describe("brain over the bus", () => {
  it("replaying the capture fixture builds session state", async () => {
    await new Promise((r) => setTimeout(r, 200)); // consumer groups created
    const sessions = await replayFixture(brain.bus, readFixture(FIXTURE), { speed: Infinity, sessionPrefix: "test" });
    const sid = [...sessions.values()][0]!;

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (brain.store.get(sid)?.lastT ?? 0) < 10_500) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const s = brain.store.get(sid)!;
    expect(s).toBeDefined();
    expect(s.lastT).toBe(10_500);
    expect(s.speech).toMatchObject({ userSpeaking: false, lastUserSpeechEndT: 8250, lastTypingT: 5000 });
    expect(s.screen.lastChangeT).toBe(6400);
    expect(s.screen.recent.map((e) => e.event_id)).toEqual(["se1", "se2", "se3"]);
    expect(s.turns.map((t) => t.turn_id)).toEqual(["t1", "t2"]);
  });

  it("healthz is green against real Redis", async () => {
    const res = await brain.app.inject({ method: "GET", url: "/healthz" });
    expect(res.json()).toMatchObject({ ok: true, deps: { redis: "ok" } });
  });
});
