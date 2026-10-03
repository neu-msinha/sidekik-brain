import { z } from "zod";
import type { QuestionSpec } from "@sidekik/contracts";
import type { JevAnswer, JevQuestions } from "./types.js";

/**
 * Wire format shared by TypeSafe `/v1/systemone` and OpenRouter `/api/alpha/decisions`.
 * Score criteria are an array indexed from 0; DECISION_SPECS scores are 1-based.
 */
export type WireQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export function toWireQuestions(questions: JevQuestions): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (const [name, q] of Object.entries(questions)) out[name] = toWireQuestion(q);
  return out;
}

function toWireQuestion(q: QuestionSpec): WireQuestion {
  switch (q.type) {
    case "noul":
      return { type: "noul", instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } };
    case "choice": {
      // Build criteria in the spec's fixed option order; never trust object key order.
      const criteria: Record<string, string> = {};
      for (const option of q.options) criteria[option] = (q.criteria as Record<string, string>)[option] ?? "";
      return { type: "choice", instructions: q.instructions, criteria };
    }
    case "score": {
      const criteria: string[] = [];
      for (let level = q.min; level <= q.max; level++) criteria.push(q.criteria[String(level) as keyof typeof q.criteria]);
      return { type: "score", instructions: q.instructions, criteria };
    }
  }
}

const Prob = z.number().min(0).max(1);
const WireAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: Prob }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: Prob.optional(),
    probabilities: z.record(z.string(), Prob).optional(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    confidence: Prob.optional(),
    probabilities: z.record(z.string(), Prob).optional(),
  }),
]);

export const WireResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), WireAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});
export type WireResponse = z.infer<typeof WireResponseSchema>;

/** Converts provider answers to 1-based, provider-agnostic answers. Throws if an answer is missing or mistyped. */
export function fromWireAnswers(questions: JevQuestions, answers: WireResponse["answers"]): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a) throw new Error(`missing answer for ${name}`);
    if (a.type !== q.type) throw new Error(`answer for ${name} is ${a.type}, expected ${q.type}`);

    if (a.type === "noul") {
      out[name] = noulAnswer(a.noul);
    } else if (a.type === "choice") {
      if (q.type === "choice" && !q.options.includes(a.choice)) throw new Error(`answer for ${name} is unknown option ${a.choice}`);
      const probabilities = a.probabilities ?? { [a.choice]: a.confidence ?? 0 };
      out[name] = { type: "choice", choice: a.choice, confidence: a.confidence ?? probabilities[a.choice] ?? 0, probabilities };
    } else {
      const probabilities: Record<string, number> = {};
      for (const [k, p] of Object.entries(a.probabilities ?? {})) probabilities[String(Number(k) + 1)] = p;
      const level = argmaxLevel(probabilities) ?? Math.round(a.score) + 1;
      out[name] = { type: "score", score: a.score + 1, level, confidence: a.confidence ?? probabilities[String(level)] ?? 0, probabilities };
    }
  }
  return out;
}

export function noulAnswer(pTrue: number): JevAnswer {
  return { type: "noul", p_true: pTrue, confidence: Math.max(pTrue, 1 - pTrue) };
}

function argmaxLevel(probabilities: Record<string, number>): number | undefined {
  let best: [string, number] | undefined;
  for (const entry of Object.entries(probabilities)) if (!best || entry[1] > best[1]) best = entry;
  return best ? Number(best[0]) : undefined;
}
