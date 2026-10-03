import type { DecisionId, DecisionProvider, Logger } from "@sidekik/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** One `decisions_log` row (SCHEMA.md 0004_capture.sql, owned by brain). */
export type DecisionLogRow = {
  org_id: string;
  session_id: string | null;
  decision: DecisionId;
  provider: DecisionProvider;
  model: string;
  answer: Record<string, unknown>;
  confidence: number;
  escalated: boolean;
  latency_ms: number;
  input_tokens: number;
  cost_usd: number;
  counterfactual_usd: number;
};

export interface DecisionSink {
  write(rows: DecisionLogRow[]): Promise<void>;
}

export class SupabaseDecisionSink implements DecisionSink {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async write(rows: DecisionLogRow[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.db.from("decisions_log").insert(rows);
    if (error) throw new Error(`decisions_log insert failed: ${error.message}`);
  }
}

/** Logs rows instead of writing them (dev:mock and tests without Supabase). */
export class LogDecisionSink implements DecisionSink {
  constructor(private readonly log: Logger) {}

  async write(rows: DecisionLogRow[]): Promise<void> {
    for (const row of rows) this.log.debug({ ...row, answer: undefined }, "decisions_log row");
  }
}

export class MemoryDecisionSink implements DecisionSink {
  readonly rows: DecisionLogRow[] = [];

  async write(rows: DecisionLogRow[]): Promise<void> {
    this.rows.push(...rows);
  }
}
