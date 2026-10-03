import { questionName } from "./decide/specs.js";
import type { Thresholds } from "./decide/thresholds.js";
import type { JevAnswer } from "./jev/types.js";

/** One question's prediction from decisions_log, plus a human label (null until labelled). */
export type LabeledRow = {
  log_id?: string;
  session_id?: string | null;
  decision: string;
  question: string;
  predicted: string | number | boolean;
  confidence: number;
  provider?: string;
  label: string | number | boolean | null;
};

export const BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** Flattens a decisions_log row's `answer` jsonb into one row per question. */
export function flattenLogRow(row: { id?: string; session_id?: string | null; decision: string; provider?: string; answer: Record<string, JevAnswer> }): LabeledRow[] {
  return Object.entries(row.answer).map(([key, a]) => ({
    ...(row.id ? { log_id: row.id } : {}),
    session_id: row.session_id ?? null,
    decision: row.decision,
    question: questionName(key),
    predicted: a.type === "noul" ? a.p_true >= 0.5 : a.type === "choice" ? a.choice : a.level,
    confidence: a.confidence,
    ...(row.provider ? { provider: row.provider } : {}),
    label: null,
  }));
}

export type BucketStats = { from: number; to: number; n: number; correct: number; accuracy: number | null };
export type QuestionReport = { key: string; n: number; buckets: BucketStats[]; suggested: number | null };

/**
 * Accuracy per confidence bucket for each decision.question, and the lowest confidence floor at which
 * everything above it is at least `target` accurate (null when no floor reaches it, or too little data).
 */
export function report(rows: LabeledRow[], target = 0.9, minRows = 10): QuestionReport[] {
  const groups = new Map<string, LabeledRow[]>();
  for (const r of rows) {
    if (r.label === null || r.label === undefined) continue;
    const key = `${r.decision}.${r.question.replace(/_q\d+$/, "_qN")}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([key, rs]) => {
      const buckets = BUCKETS.map((from, i) => {
        const to = BUCKETS[i + 1] ?? 1.0001;
        const inB = rs.filter((r) => r.confidence >= from && r.confidence < to);
        const correct = inB.filter(isCorrect).length;
        return { from, to: Math.min(to, 1), n: inB.length, correct, accuracy: inB.length ? correct / inB.length : null };
      });
      // Walk floors downwards; a floor counts only if its own bucket has data (no extrapolating into empty buckets).
      let suggested: number | null = null;
      for (const b of [...buckets].reverse()) {
        if (b.n === 0) continue;
        const above = rs.filter((r) => r.confidence >= b.from);
        if (above.length < minRows) continue;
        if (above.filter(isCorrect).length / above.length >= target) suggested = b.from;
        else break;
      }
      return { key, n: rs.length, buckets, suggested };
    });
}

/** Maps per-question suggestions onto the Thresholds keys they calibrate. */
export function suggestThresholds(reports: QuestionReport[]): Partial<Thresholds> {
  const get = (k: string) => reports.find((r) => r.key === k)?.suggested ?? null;
  const out: Partial<Thresholds> = {};
  const set = <K extends keyof Thresholds>(key: K, v: number | null) => {
    if (v !== null) out[key] = v as Thresholds[K];
  };
  set("pauseNow", get("D1.pause_now"));
  set("finishedSubstep", get("D1.activity"));
  set("eventClass", get("D2.event_class"));
  const answered = get("D3.answered_qN");
  set("answeredMax", answered === null ? null : round(1 - answered));
  return out;
}

function isCorrect(r: LabeledRow): boolean {
  return String(r.label) === String(r.predicted);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
