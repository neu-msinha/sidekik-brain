/**
 * Runs brain against a recorded bus fixture, with no teammates' services.
 *
 *   pnpm dev:mock                                  # default fixture, 10x speed
 *   pnpm dev:mock path/to/fixture.jsonl --speed 1  # real time
 *   pnpm dev:mock --keep                           # keep serving after the replay
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
const LOCAL_FIXTURE = fileURLToPath(new URL("../test/fixtures/capture_mini.jsonl", import.meta.url));

// Local defaults so dev:mock boots without a filled-in .env. Real values win.
const DEV_DEFAULTS: Record<string, string> = {
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "dev-mock",
  SK_INTERNAL_TOKEN: "dev-mock-internal-token",
  GATEWAY_INTERNAL_URL: "http://localhost:8080",
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { speed: { type: "string", default: "10" }, keep: { type: "boolean", default: false } },
});

const fixturePath = positionals[0] ?? (existsSync(PLATFORM_FIXTURE) ? PLATFORM_FIXTURE : LOCAL_FIXTURE);
const env = loadBrainEnv({ ...DEV_DEFAULTS, ...stripEmpty(process.env) });
const brain = await startBrain(env);
const { log } = brain;

const lines = readFixture(fixturePath);
log.info({ fixture: fixturePath, events: lines.length, speed: Number(values.speed) }, "dev:mock replaying");
// Let consumer groups get created before the first publish.
await new Promise((r) => setTimeout(r, 300));
const sessions = await replayFixture(brain.bus, lines, { speed: Number(values.speed) });
await new Promise((r) => setTimeout(r, 500));

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
