import type { DecisionProvider, QuestionSpec } from "@sidekik/contracts";

/** Questions keyed by name, in the shape of `DECISION_SPECS` (scores are 1-based). */
export type JevQuestions = Record<string, QuestionSpec>;

export type JevAsk = {
  /** Filtered JSON state. Raw screen text belongs only in `untrusted_screen_text`. */
  state: unknown;
  questions: JevQuestions;
};

/** Answers normalized across providers. Scores and score probabilities are 1-based like DECISION_SPECS. */
export type NoulAnswer = { type: "noul"; p_true: number; confidence: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = {
  type: "score";
  /** Probability-weighted level, may fall between levels. */
  score: number;
  /** Most likely level. */
  level: number;
  confidence: number;
  probabilities: Record<string, number>;
};
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type JevUsage = {
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported cost in USD, when the provider returns one (OpenRouter). */
  cost_usd?: number;
};

export type JevResult = {
  provider: DecisionProvider;
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  latency_ms: number;
  cached?: boolean;
};

export type AskOptions = { signal?: AbortSignal };

export interface JevClient {
  readonly provider: DecisionProvider;
  readonly model: string;
  ask(req: JevAsk, opts?: AskOptions): Promise<JevResult>;
}

/** Provider-agnostic failure classes the circuit breaker understands. */
export type JevErrorKind = "rate_limit" | "timeout" | "unavailable" | "bad_request";

export class JevError extends Error {
  override name = "JevError";
  constructor(
    readonly kind: JevErrorKind,
    readonly provider: DecisionProvider,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${provider}: ${message}`, options);
  }
}
