import type { DecisionProvider } from "@sidekik/contracts";
import type { JevUsage } from "./types.js";

/**
 * USD per token, as of 2026-10-03.
 * Jev: docs.typesafe.ai/models ($0.042 per Mtok input, output free).
 * Claude Haiku 4.5: $1 / $5 per Mtok in/out.
 */
export const PRICES = {
  jev: { in: 0.042 / 1e6, out: 0 },
  haiku: { in: 1 / 1e6, out: 5 / 1e6 },
} as const;

/** Output tokens Haiku spends per question for `{answer, probability}` (used for the counterfactual). */
export const HAIKU_OUTPUT_TOKENS_PER_QUESTION = 20;

export function costUsd(provider: DecisionProvider, usage: JevUsage): number {
  if (usage.cost_usd !== undefined) return usage.cost_usd;
  const p = provider === "llm" ? PRICES.haiku : PRICES.jev;
  return usage.input_tokens * p.in + usage.output_tokens * p.out;
}

/** The same decision priced on Haiku 4.5: the input tokens plus a short JSON answer per question. */
export function counterfactualUsd(provider: DecisionProvider, usage: JevUsage, questionCount: number): number {
  if (provider === "llm") return costUsd(provider, usage);
  return usage.input_tokens * PRICES.haiku.in + questionCount * HAIKU_OUTPUT_TOKENS_PER_QUESTION * PRICES.haiku.out;
}
