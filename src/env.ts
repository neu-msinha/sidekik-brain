import { BaseServiceEnvSchema, loadEnv } from "@sidekik/contracts";
import { z } from "zod";

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

export const BrainEnvSchema = BaseServiceEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(8082),
  // Vendor keys are optional at boot; each client checks for its key when it is created.
  TYPESAFE_API_KEY: optionalSecret,
  JEV_MODEL: z.string().min(1).default("jev-1.13.0"),
  OPENROUTER_API_KEY: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  LLM_FALLBACK_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  OPENROUTER_JEV_MODEL: z.string().min(1).default("typesafe/jev-1.13"),
  /** Per-call Jev timeout; also the breaker's slow-call threshold (DESIGN §5: 1.5 s). */
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  /** Claude model that drafts questions and extracts rules (DESIGN §3: Haiku 4.5). */
  PLANNER_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  /** Where brain's rows go: Supabase, or memory + log (dev:mock without a database). */
  PERSISTENCE: z.enum(["supabase", "memory"]).default("supabase"),
  /** Offline rule-based Jev and planner (dev:mock without keys). Never in production. */
  FAKE_VENDORS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Partial JSON overrides for decide/thresholds.ts (from scripts/calibrate.ts). */
  THRESHOLDS_JSON: z.string().optional(),
  GATEWAY_INTERNAL_URL: z.url(),
  JEV_RPS: z.coerce.number().positive().default(30),
  JEV_TPS: z.coerce.number().positive().default(80_000),
});
export type BrainEnv = z.infer<typeof BrainEnvSchema>;

export function loadBrainEnv(source: Record<string, string | undefined> = process.env): BrainEnv {
  return loadEnv(BrainEnvSchema, source);
}
