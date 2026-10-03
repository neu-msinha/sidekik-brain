/**
 * Runs brain against a recorded bus fixture, with no teammates' services.
 *
 *   pnpm dev:mock                                  # default fixture, 20x speed
 *   pnpm dev:mock path/to/fixture.jsonl --speed 1  # real time
 *   pnpm dev:mock --keep                           # keep serving after the replay
 *   pnpm dev:mock --fake                           # offline Jev/planner even when keys are set
 *
 * Without TYPESAFE/OPENROUTER/ANTHROPIC keys it runs on the offline fakes (src/dev/fakes.ts).
 *
 * Needs Redis: docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startBrain } from "../src/app.js";
import { loadBrainEnv } from "../src/env.js";
import { readFixture, replayFixture } from "./replay.js";

const PLATFORM_FIXTURE = fileURLToPath(new URL("../../sidekik-platform/dev/fixtures/capture_sabine.jsonl", import.meta.url));
const LOCAL_FIXTURE = fileURLToPath(new URL("../test/fixtures/capture_sabine_mock.jsonl", import.meta.url));

// Local defaults so dev:mock boots without a filled-in .env. Real values win.
const DEV_DEFAULTS: Record<string, string> = {
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "dev-mock",
  SK_INTERNAL_TOKEN: "dev-mock-internal-token",
  GATEWAY_INTERNAL_URL: "http://localhost:8080",
  PERSISTENCE: "memory",
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    speed: { type: "string", default: "20" },
    keep: { type: "boolean", default: false },
    fake: { type: "boolean", default: false },
  },
});

const fixturePath = positionals[0] ?? (existsSync(PLATFORM_FIXTURE) ? PLATFORM_FIXTURE : LOCAL_FIXTURE);
const real = stripEmpty(process.env);
const hasKeys = !!(real.TYPESAFE_API_KEY || real.OPENROUTER_API_KEY || real.ANTHROPIC_API_KEY);
const env = loadBrainEnv({ ...DEV_DEFAULTS, ...real, ...(values.fake || !hasKeys ? { FAKE_VENDORS: "true" } : {}) });
const brain = await startBrain(env);
const { log } = brain;

const lines = readFixture(fixturePath);
log.info({ fixture: fixturePath, events: lines.length, speed: Number(values.speed), fake_vendors: env.FAKE_VENDORS }, "dev:mock replaying");
// Let consumer groups get created before the first publish.
await new Promise((r) => setTimeout(r, 300));
const sessions = await replayFixture(brain.bus, lines, { speed: Number(values.speed) });
await new Promise((r) => setTimeout(r, 500));

const asks = await readAsks(env.REDIS_URL, [...sessions.values()]);
for (const a of asks) log.info(a, "dev:mock ask");
log.info({ asks: asks.length, guardrail_asks: asks.filter((a) => a.qtype === "limit" || a.qtype === "stop_and_ask").length }, "dev:mock summary");

for (const sid of sessions.values()) {
  const s = brain.store.get(sid);
  log.info(
    s
      ? {
          session_id: sid,
          phase: s.phase,
          last_t_ms: s.lastT,
          speech: s.speech,
          screen_last_change_t: s.screen.lastChangeT,
          screen_events: s.screen.recent.length,
          turns: s.turns.length,
          candidates: s.capture.candidates.length,
          asked: s.capture.asked.length,
        }
      : { session_id: sid },
    s ? "dev:mock session state" : "dev:mock session no longer tracked",
  );
}

if (values.keep) {
  log.info(`dev:mock done; still serving on :${env.PORT} (Ctrl+C to stop)`);
} else {
  await brain.close();
}

function stripEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((e): e is [string, string] => !!e[1]));
}

/** Reads the ask commands brain published for these sessions back off the bus stream. */
async function readAsks(redisUrl: string, sessionIds: string[]) {
  const { Redis } = await import("ioredis");
  const r = new Redis(redisUrl);
  try {
    const entries = await r.xrange("sk:agent.commands", "-", "+");
    return entries
      .map(([, fields]) => JSON.parse(fields[fields.indexOf("ev") + 1] ?? "null") as { session_id: string; t_ms: number; data: { type: string; qtype?: string; text?: string } })
      .filter((e) => e && sessionIds.includes(e.session_id) && e.data.type === "ask")
      .map((e) => ({ t_s: e.t_ms / 1000, qtype: e.data.qtype, text: e.data.text }));
  } finally {
    r.disconnect();
  }
}
