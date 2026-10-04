/**
 * Calls each configured decision provider once with the Appendix A D1 example and prints
 * answers, latency and cost. Needs real keys in .env (TYPESAFE / OPENROUTER / ANTHROPIC).
 *
 *   pnpm jev:smoke
 */
import { createLogger, DECISION_SPECS } from "@sidekik/contracts";
import { loadBrainEnv } from "../src/env.js";
import { LLMDecider } from "../src/jev/llm.js";
import { OpenRouterJev } from "../src/jev/openrouter.js";
import { costUsd } from "../src/jev/pricing.js";
import { TypeSafeJev } from "../src/jev/typesafe.js";
import type { JevAsk, JevClient } from "../src/jev/types.js";

const env = loadBrainEnv({
  REDIS_URL: "redis://localhost:6379",
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "smoke",
  SK_INTERNAL_TOKEN: "smoke-internal-token",
  GATEWAY_INTERNAL_URL: "http://localhost:8080",
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => !!e[1])),
});
const log = createLogger("brain", { level: "info" });

const ask: JevAsk = {
  state: {
    features: { ms_since_speech_end: 1850, ms_since_screen_change: 2400, last_vision_event: "field_changed cost_center 4711→0400", questions_last_10min: 1 },
    last_utterance: "…und dann geht die auf 0400.",
    recent_events: ["03:12 field_changed cost_center 4711→0400"],
  },
  questions: DECISION_SPECS.D1.questions,
};

const clients: JevClient[] = [];
if (env.TYPESAFE_API_KEY) clients.push(new TypeSafeJev({ apiKey: env.TYPESAFE_API_KEY, model: env.JEV_MODEL, timeoutMs: 5000 }));
if (env.OPENROUTER_API_KEY) clients.push(new OpenRouterJev({ apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_JEV_MODEL, timeoutMs: 5000, url: env.OPENROUTER_DECISIONS_URL }));
if (env.ANTHROPIC_API_KEY) clients.push(new LLMDecider({ apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_FALLBACK_MODEL, timeoutMs: 10_000 }));
if (clients.length === 0) {
  log.error("no provider keys set; fill TYPESAFE_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

let failed = false;
for (const c of clients) {
  try {
    const r = await c.ask(ask);
    log.info({ provider: c.provider, model: r.model, latency_ms: r.latency_ms, usage: r.usage, cost_usd: costUsd(r.provider, r.usage), answers: r.answers }, "ok");
  } catch (err) {
    failed = true;
    log.error({ provider: c.provider, err }, "failed");
  }
}
process.exit(failed ? 1 : 0);
