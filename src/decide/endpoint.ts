import {
  DecisionRequestSchema,
  DECISION_SPECS,
  type DecisionId,
  type DecisionResult,
  type DecisionSpec,
  type Logger,
  type QuestionAnswer,
} from "@sidekik/contracts";
import type { FastifyInstance } from "fastify";
import { JevError } from "../jev/types.js";
import type { SessionDirectory } from "../sessions.js";
import type { DecisionOutcome, Decider, QuestionOutcome } from "./decider.js";

/** ARCHITECTURE §4.3: mapper/tutor → brain budget is 600 ms; keep headroom for the network. */
export const DECIDE_BUDGET_MS = 550;

/** Per-candidate decisions need brain's own candidate list, so callers can't request them. */
const NOT_SERVED = new Set<DecisionId>(["D3"]);

export type DecideRouteDeps = { decider: Decider; sessions: SessionDirectory; log: Logger; budgetMs?: number };

/** `POST /internal/decide`: DecisionRequest → {results: DecisionResult[]}, all decisions in one Jev call, no escalation. */
export function registerDecideRoute(app: FastifyInstance, d: DecideRouteDeps): void {
  app.post("/decide", async (req, reply) => {
    const parsed = DecisionRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid DecisionRequest", issues: parsed.error.issues });
    const { session_id, decisions } = parsed.data;

    const refused = decisions.filter((x) => NOT_SERVED.has(x.id)).map((x) => x.id);
    if (refused.length > 0) return reply.code(400).send({ error: `not served by /internal/decide: ${refused.join(", ")}` });
    if (new Set(decisions.map((x) => x.id)).size !== decisions.length) {
      return reply.code(400).send({ error: "each decision id may appear once per request" });
    }

    const org_id = await d.sessions.orgOf(session_id).catch(() => undefined);
    const log = d.log.child({ session_id, org_id });
    const started = performance.now();
    try {
      const out = await d.decider.decide(
        decisions.map((x) => ({ id: x.id, state: x.state })),
        { session_id, ...(org_id ? { org_id } : {}) },
        { signal: AbortSignal.timeout(d.budgetMs ?? DECIDE_BUDGET_MS) },
      );
      const results = decisions.map((x) => toResult(out[x.id]!));
      log.info({ decisions: decisions.map((x) => x.id), latency_ms: Math.round(performance.now() - started) }, "decide");
      return { results };
    } catch (err) {
      const kind = err instanceof JevError ? err.kind : "unavailable";
      log.error({ err, kind, latency_ms: Math.round(performance.now() - started) }, "decide failed");
      return reply.code(kind === "bad_request" ? 400 : 503).send({ error: "decision providers unavailable", kind });
    }
  });
}

export function toResult(o: DecisionOutcome): DecisionResult {
  const spec: DecisionSpec = DECISION_SPECS[o.id];
  const first = Object.keys(spec.questions)[0]!;
  const primary = o.questions[first] ?? Object.values(o.questions)[0];
  if (!primary) throw new JevError("unavailable", o.provider, `no answers for ${o.id}`);
  const answers: Record<string, QuestionAnswer> = {};
  for (const [name, q] of Object.entries(o.questions)) answers[name] = toAnswer(q);
  return {
    id: o.id,
    answer: primary.answer,
    ...(primary.probabilities ? { probabilities: primary.probabilities } : {}),
    confidence: primary.confidence,
    provider: o.provider,
    escalated: o.escalated,
    latency_ms: o.latency_ms,
    answers,
  };
}

function toAnswer(q: QuestionOutcome): QuestionAnswer {
  return {
    answer: q.answer,
    confidence: q.confidence,
    ...(q.probabilities ? { probabilities: q.probabilities } : {}),
    ...(q.p_true !== undefined ? { p_true: q.p_true } : {}),
    ...(q.score !== undefined ? { score: q.score } : {}),
  };
}
