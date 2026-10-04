import type { Bus, Logger } from "@sidekik/contracts";
import type { BrainEnv } from "../env.js";
import { CircuitBreaker, DEFAULT_BREAKER } from "./breaker.js";
import { TtlLru } from "./cache.js";
import { RateLimiter } from "./limiter.js";
import { LLMDecider } from "./llm.js";
import { OpenRouterJev } from "./openrouter.js";
import { JevRouter } from "./router.js";
import { LogDecisionSink, SupabaseDecisionSink, type DecisionSink } from "./sink.js";
import { TypeSafeJev } from "./typesafe.js";
import { HeuristicJev } from "../dev/fakes.js";
import type { JevClient, JevResult } from "./types.js";

export * from "./types.js";
export { JevRouter, type AskContext } from "./router.js";

/** LLM calls get more time than Jev; Haiku's structured output takes longer than a Jev decision. */
const LLM_TIMEOUT_MS = 5000;

/** Builds the router from env. Providers without a key are skipped; with none at all, every ask fails fast. */
export function createJevRouter(env: BrainEnv, deps: { log: Logger; bus?: Bus; sink?: DecisionSink }): JevRouter {
  const primary: JevClient | undefined = env.FAKE_VENDORS
    ? new HeuristicJev()
    : env.TYPESAFE_API_KEY
    ? new TypeSafeJev({ apiKey: env.TYPESAFE_API_KEY, model: env.JEV_MODEL, timeoutMs: env.JEV_TIMEOUT_MS })
    : undefined;
  const fallbacks: JevClient[] = [];
  if (env.OPENROUTER_API_KEY && !env.FAKE_VENDORS) {
    fallbacks.push(
      new OpenRouterJev({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_JEV_MODEL,
        timeoutMs: env.JEV_TIMEOUT_MS,
        url: env.OPENROUTER_DECISIONS_URL,
      }),
    );
  }
  if (env.ANTHROPIC_API_KEY && !env.FAKE_VENDORS) {
    fallbacks.push(new LLMDecider({ apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_FALLBACK_MODEL, timeoutMs: LLM_TIMEOUT_MS }));
  }

  const sink =
    deps.sink ??
    (env.PERSISTENCE === "supabase"
      ? new SupabaseDecisionSink(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      : new LogDecisionSink(deps.log));

  const router = new JevRouter({
    ...(primary ? { primary } : {}),
    fallbacks,
    breaker: new CircuitBreaker({ ...DEFAULT_BREAKER, slowCallMs: env.JEV_TIMEOUT_MS }),
    limiter: new RateLimiter(env.JEV_RPS, env.JEV_TPS),
    cache: new TtlLru<JevResult>(500, 60_000),
    sink,
    ...(deps.bus ? { bus: deps.bus } : {}),
    log: deps.log,
    cacheModel: env.JEV_MODEL,
  });
  if (router.providers.length === 0) deps.log.warn("no decision providers configured (TYPESAFE/OPENROUTER/ANTHROPIC keys all empty)");
  else deps.log.info({ providers: router.providers }, "decision providers");
  return router;
}
