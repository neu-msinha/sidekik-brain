import type { QType } from "@sidekik/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** `questions` row (SCHEMA 0004, owned by brain). Ids are generated here so memory and Supabase agree. */
export type QuestionRow = {
  id: string;
  org_id: string;
  session_id: string;
  phase: "capture" | "debrief";
  qtype: QType;
  text: string;
  anchor_event_ids: string[];
  status: "candidate" | "asked" | "answered" | "expired";
  created_t_ms: number;
  asked_t_ms?: number | null;
  jev_scores?: Record<string, unknown> | null;
};

/** `answers` row (SCHEMA 0004, owned by brain). */
export type AnswerRow = {
  org_id: string;
  session_id: string;
  question_id: string;
  turn_ids: string[];
  content_class: string;
  quote: string;
  quote_en?: string | null;
  has_condition: boolean;
  extracted_rule?: string | null;
};

/** Brain's writes for the capture loop. Every call is safe to repeat. */
export interface CaptureRepo {
  insertQuestion(row: QuestionRow): Promise<void>;
  markAsked(id: string, asked_t_ms: number, jev_scores: Record<string, unknown>): Promise<void>;
  setStatus(ids: string[], status: "answered" | "expired"): Promise<void>;
  insertAnswer(row: AnswerRow): Promise<void>;
  /** D2 result on perception's row: the one shared-write exception (SCHEMA 0004 note). */
  setEventClass(event_id: string, event_class: string): Promise<void>;
}

export class SupabaseCaptureRepo implements CaptureRepo {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async insertQuestion(row: QuestionRow): Promise<void> {
    check(await this.db.from("questions").upsert(row, { onConflict: "id", ignoreDuplicates: true }), "insert question");
  }

  async markAsked(id: string, asked_t_ms: number, jev_scores: Record<string, unknown>): Promise<void> {
    check(await this.db.from("questions").update({ status: "asked", asked_t_ms, jev_scores }).eq("id", id), "mark asked");
  }

  async setStatus(ids: string[], status: "answered" | "expired"): Promise<void> {
    if (ids.length === 0) return;
    check(await this.db.from("questions").update({ status }).in("id", ids), `set ${status}`);
  }

  async insertAnswer(row: AnswerRow): Promise<void> {
    check(await this.db.from("answers").insert(row), "insert answer");
  }

  async setEventClass(event_id: string, event_class: string): Promise<void> {
    check(await this.db.from("screen_events").update({ event_class }).eq("event_id", event_id), "set event_class");
  }
}

function check(res: { error: { message: string } | null }, what: string): void {
  if (res.error) throw new Error(`${what} failed: ${res.error.message}`);
}

/** In-memory repo for tests and dev:mock without a database. */
export class MemoryCaptureRepo implements CaptureRepo {
  readonly questions = new Map<string, QuestionRow>();
  readonly answers: AnswerRow[] = [];
  readonly eventClasses = new Map<string, string>();

  async insertQuestion(row: QuestionRow): Promise<void> {
    if (!this.questions.has(row.id)) this.questions.set(row.id, { ...row });
  }

  async markAsked(id: string, asked_t_ms: number, jev_scores: Record<string, unknown>): Promise<void> {
    const q = this.questions.get(id);
    if (q) Object.assign(q, { status: "asked", asked_t_ms, jev_scores });
  }

  async setStatus(ids: string[], status: "answered" | "expired"): Promise<void> {
    for (const id of ids) {
      const q = this.questions.get(id);
      if (q) q.status = status;
    }
  }

  async insertAnswer(row: AnswerRow): Promise<void> {
    this.answers.push({ ...row });
  }

  async setEventClass(event_id: string, event_class: string): Promise<void> {
    this.eventClasses.set(event_id, event_class);
  }
}
