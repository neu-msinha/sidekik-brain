import type { Bus, Logger } from "@sidekik/contracts";
import { AnswerHandler } from "./capture/answers.js";
import { HttpGatewayClient, type GatewayClient } from "./capture/gateway.js";
import { CaptureLoop } from "./capture/loop.js";
import { OffRecordWatcher } from "./capture/offrecord.js";
import { SessionQueue } from "./capture/queue.js";
import { MemoryCaptureRepo, SupabaseCaptureRepo, type CaptureRepo } from "./capture/repo.js";
import type { BrainHooks } from "./consumers.js";
import { Decider } from "./decide/decider.js";
import { parseThresholds, type Thresholds } from "./decide/thresholds.js";
import type { BrainEnv } from "./env.js";
import type { JevRouter } from "./jev/index.js";
import { EchoRuleExtractor, TemplatePlanner } from "./dev/fakes.js";
import { DEFAULT_PAUSE } from "./pause.js";
import { HaikuPlanner, type QuestionPlanner } from "./planner.js";
import { HaikuRuleExtractor, type RuleExtractor } from "./rules.js";
import type { SessionState, SessionStore } from "./state.js";

export type BrainParts = {
  decider: Decider;
  thresholds: Thresholds;
  repo: CaptureRepo;
  gateway: GatewayClient;
  queue: SessionQueue;
  loop: CaptureLoop;
  hooks: BrainHooks;
};

export type BrainOverrides = Partial<{
  planner: QuestionPlanner;
  rules: RuleExtractor;
  repo: CaptureRepo;
  gateway: GatewayClient;
  /** Session clock for the capture loop (replay tests run on simulated time). */
  now: (s: SessionState) => number;
}>;

/** Builds the capture loop, answer handling and off-record watcher and joins them into bus hooks. */
export function assembleBrain(env: BrainEnv, deps: { store: SessionStore; bus: Bus; jev: JevRouter; log: Logger }, o: BrainOverrides = {}): BrainParts {
  const { store, bus, jev, log } = deps;
  const thresholds = parseThresholds(env.THRESHOLDS_JSON);
  const decider = new Decider(jev, thresholds);
  const repo = o.repo ?? (env.PERSISTENCE === "supabase" ? new SupabaseCaptureRepo(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) : new MemoryCaptureRepo());
  const gateway = o.gateway ?? new HttpGatewayClient(env.GATEWAY_INTERNAL_URL, env.SK_INTERNAL_TOKEN);
  const planner =
    o.planner ??
    (env.FAKE_VENDORS ? new TemplatePlanner() : env.ANTHROPIC_API_KEY ? new HaikuPlanner({ apiKey: env.ANTHROPIC_API_KEY, model: env.PLANNER_MODEL }) : undefined);
  const rules =
    o.rules ??
    (env.FAKE_VENDORS ? new EchoRuleExtractor() : env.ANTHROPIC_API_KEY ? new HaikuRuleExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: env.PLANNER_MODEL }) : undefined);
  const queue = new SessionQueue((session_id, err) => log.error({ session_id, err }, "session task failed"));

  const loop = new CaptureLoop({ store, decider, ...(planner ? { planner } : {}), repo, bus, queue, log, thresholds, pause: DEFAULT_PAUSE, ...(o.now ? { now: o.now } : {}) });
  const answers = new AnswerHandler({ decider, ...(rules ? { rules } : {}), repo, queue, log, thresholds });
  const offRecord = new OffRecordWatcher({ decider, gateway, log, thresholds });

  const hooks: BrainHooks = {
    onScreenEvent: (s, ev) => loop.onScreenEvent(s, ev),
    onCaptureStopped: (s) => loop.onCaptureStopped(s),
    onTurn: async (s, ev) => {
      await offRecord.onTurn(s, ev).catch((err: unknown) => log.error({ session_id: s.session_id, org_id: s.org_id, err }, "off-record check failed"));
      await answers.onTurn(s, ev);
    },
    onSpeech: async (s) => loop.tick(s),
  };
  return { decider, thresholds, repo, gateway, queue, loop, hooks };
}
