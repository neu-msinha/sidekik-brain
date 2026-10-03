import { DECISION_SPECS, type DecisionId, type DecisionProvider } from "@sidekik/contracts";
import type { AskContext, JevRouter } from "../jev/router.js";
import type { JevAnswer, JevAsk } from "../jev/types.js";
import { buildAsk, questionName, type DecisionItem } from "./specs.js";
import type { Thresholds } from "./thresholds.js";

/** act: confident enough to use. escalate: mid band (before escalation). default: use the safe/conservative side. */
export type Band = "act" | "escalate" | "default";

export type QuestionOutcome = {
  type: JevAnswer["type"];
  /** boolean for noul (p_true ≥ 0.5), option for choice, most likely level for score. */
  answer: string | number | boolean;
  /** Noul only: probability of true. */
  p_true?: number;
  /** Score only: probability-weighted level. */
  score?: number;
  confidence: number;
  probabilities?: Record<string, number>;
  band: Band;
  provider: DecisionProvider;
  escalated: boolean;
};

export type DecisionOutcome = {
  id: DecisionId;
  /** Keyed by the spec's question name (e.g. "pause_now", "answered_q2"). */
  questions: Record<string, QuestionOutcome>;
  provider: DecisionProvider;
  escalated: boolean;
  latency_ms: number;
};

export type DecideContext = Omit<AskContext, "decisions">;
export type DecideOptions = {
  /** Re-ask mid-band answers on the LLM (DESIGN §5). Off for time-critical calls (D1/D3, /internal/decide). */
  escalate?: boolean;
  signal?: AbortSignal;
};

/** Decisions whose action rule is a fixed probability, never escalated (D7 fires at ≥ 0.5). */
const NEVER_ESCALATE = new Set<DecisionId>(["D7"]);

export class Decider {
  constructor(
    private readonly router: JevRouter,
    private readonly t: Thresholds,
  ) {}

  async decide(items: DecisionItem[], ctx: DecideContext, opts: DecideOptions = {}): Promise<Record<string, DecisionOutcome>> {
    const { ask, decisions } = buildAsk(items);
    const askOpts = opts.signal ? { signal: opts.signal } : {};
    const result = await this.router.ask(ask, { ...ctx, decisions }, askOpts);
    const answers: Record<string, { a: JevAnswer; provider: DecisionProvider; escalated: boolean }> = {};
    for (const [key, a] of Object.entries(result.answers)) answers[key] = { a, provider: result.provider, escalated: false };

    let escalatedLatency = 0;
    if (opts.escalate && this.router.llm) {
      const midKeys = decisions
        .filter((d) => !NEVER_ESCALATE.has(d.id))
        .flatMap((d) => d.questions)
        .filter((k) => this.band(result.answers[k]) === "escalate");
      if (midKeys.length > 0) {
        const sub: JevAsk = { state: ask.state, questions: Object.fromEntries(midKeys.map((k) => [k, ask.questions[k]!])) };
        const subDecisions = decisions
          .map((d) => ({ id: d.id, questions: d.questions.filter((k) => midKeys.includes(k)) }))
          .filter((d) => d.questions.length > 0);
        const esc = await this.router.escalate(sub, { ...ctx, decisions: subDecisions }, askOpts).catch(() => undefined);
        if (esc) {
          escalatedLatency = esc.latency_ms;
          for (const k of midKeys) {
            const a = esc.answers[k];
            if (a) answers[k] = { a, provider: esc.provider, escalated: true };
          }
        }
      }
    }

    const out: Record<string, DecisionOutcome> = {};
    for (const d of decisions) {
      const questions: Record<string, QuestionOutcome> = {};
      let escalated = false;
      for (const key of d.questions) {
        const entry = answers[key];
        if (!entry) continue;
        questions[questionName(key)] = this.outcome(d.id, entry.a, entry.provider, entry.escalated);
        escalated ||= entry.escalated;
      }
      out[d.id] = {
        id: d.id,
        questions,
        provider: escalated ? "llm" : result.provider,
        escalated,
        latency_ms: result.latency_ms + (escalated ? escalatedLatency : 0),
      };
    }
    return out;
  }

  /** DESIGN §5 band for one answer. After escalation, a remaining mid-band answer becomes "default". */
  band(a: JevAnswer | undefined): Band {
    if (!a) return "default";
    if (a.type === "noul") return a.p_true >= this.t.noulAct || a.p_true <= 1 - this.t.noulAct ? "act" : "escalate";
    if (a.confidence >= this.t.choiceAct) return "act";
    return a.confidence >= this.t.choiceEscalate ? "escalate" : "default";
  }

  private outcome(id: DecisionId, a: JevAnswer, provider: DecisionProvider, escalated: boolean): QuestionOutcome {
    let band = NEVER_ESCALATE.has(id) ? "act" : this.band(a);
    if (escalated && band === "escalate") band = "default";
    const base = { type: a.type, confidence: a.confidence, band, provider, escalated } as const;
    if (a.type === "noul") return { ...base, answer: a.p_true >= 0.5, p_true: a.p_true };
    if (a.type === "choice") return { ...base, answer: a.choice, probabilities: a.probabilities };
    return { ...base, answer: a.level, score: a.score, probabilities: a.probabilities };
  }
}

/** Spec option list for a choice question, for callers validating answers. */
export function optionsOf(id: DecisionId, question: string): readonly string[] | undefined {
  const q = (DECISION_SPECS[id].questions as Record<string, { type: string; options?: readonly string[] }>)[question];
  return q?.type === "choice" ? q.options : undefined;
}
