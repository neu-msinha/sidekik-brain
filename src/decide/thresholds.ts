import { z } from "zod";

/**
 * Confidence bands and action thresholds (DESIGN §3, §5). These are defaults;
 * calibration (scripts/calibrate.ts) tunes them per deployment via THRESHOLDS_JSON.
 */
export const ThresholdsSchema = z.object({
  /** Choice/score: act at or above. */
  choiceAct: z.number().min(0).max(1).default(0.8),
  /** Choice/score: escalate to the LLM at or above (and below choiceAct); below is the safe default. */
  choiceEscalate: z.number().min(0).max(1).default(0.55),
  /** Noul: act when p ≥ noulAct or p ≤ 1 − noulAct; between is escalated. */
  noulAct: z.number().min(0.5).max(1).default(0.85),
  /** D1: ask only when pause_now ≥ this. */
  pauseNow: z.number().min(0).max(1).default(0.85),
  /** D1: … and activity = finished_substep at ≥ this. */
  finishedSubstep: z.number().min(0).max(1).default(0.8),
  /** D2: judgment_call / exception_handling at ≥ this spawns candidates. */
  eventClass: z.number().min(0).max(1).default(0.8),
  /** D3: a candidate counts as unanswered when answered < this. */
  answeredMax: z.number().min(0).max(1).default(0.15),
  /** D5: extract a rule when has_numeric_or_date_condition ≥ this. */
  hasCondition: z.number().min(0).max(1).default(0.5),
  /** D7: off-record fires at ≥ this (deliberately low: missing a request is worse). */
  offRecord: z.number().min(0).max(1).default(0.5),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = ThresholdsSchema.parse({});

/** Parses THRESHOLDS_JSON (partial overrides on top of the defaults). */
export function parseThresholds(json: string | undefined): Thresholds {
  if (!json) return DEFAULT_THRESHOLDS;
  return ThresholdsSchema.parse(JSON.parse(json));
}
