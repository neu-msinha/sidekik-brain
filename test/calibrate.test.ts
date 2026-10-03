import { describe, expect, it } from "vitest";
import { flattenLogRow, report, suggestThresholds, type LabeledRow } from "../src/calibrate.js";
import { parseThresholds } from "../src/decide/thresholds.js";

const rows = (decision: string, question: string, spec: [confidence: number, correct: boolean][]): LabeledRow[] =>
  spec.map(([confidence, correct]) => ({ decision, question, predicted: true, confidence, label: correct }));

describe("calibration", () => {
  it("flattens a decisions_log row into one row per question", () => {
    const out = flattenLogRow({
      id: "log1",
      session_id: "s",
      decision: "D1",
      provider: "jev",
      answer: {
        D1__pause_now: { type: "noul", p_true: 0.2, confidence: 0.8 },
        D1__activity: { type: "choice", choice: "typing", confidence: 0.9, probabilities: {} },
      },
    });
    expect(out).toEqual([
      { log_id: "log1", session_id: "s", decision: "D1", question: "pause_now", predicted: false, confidence: 0.8, provider: "jev", label: null },
      { log_id: "log1", session_id: "s", decision: "D1", question: "activity", predicted: "typing", confidence: 0.9, provider: "jev", label: null },
    ]);
  });

  it("buckets accuracy and suggests the lowest floor that stays above target", () => {
    const data = [
      ...rows("D1", "pause_now", Array.from({ length: 10 }, () => [0.95, true] as [number, boolean])),
      ...rows("D1", "pause_now", [...Array.from({ length: 9 }, () => [0.85, true] as [number, boolean]), [0.85, false]]),
      ...rows("D1", "pause_now", [...Array.from({ length: 5 }, () => [0.75, true] as [number, boolean]), ...Array.from({ length: 5 }, () => [0.75, false] as [number, boolean])]),
      { decision: "D1", question: "pause_now", predicted: true, confidence: 0.99, label: null },
    ];
    const [r] = report(data, 0.9, 10);
    expect(r!.key).toBe("D1.pause_now");
    expect(r!.n).toBe(30);
    expect(r!.buckets.find((b) => b.from === 0.8)).toMatchObject({ n: 10, correct: 9, accuracy: 0.9 });
    expect(r!.suggested).toBe(0.8); // ≥0.8 is 19/20 correct; ≥0.7 is 24/30
    expect(suggestThresholds([r!])).toEqual({ pauseNow: 0.8 });
  });

  it("groups D3 candidates and maps answered to answeredMax", () => {
    const data = rows("D3", "answered_q1", Array.from({ length: 6 }, () => [0.9, true] as [number, boolean])).concat(
      rows("D3", "answered_q2", Array.from({ length: 6 }, () => [0.92, true] as [number, boolean])),
    );
    const reports = report(data, 0.9, 10);
    expect(reports.map((r) => r.key)).toEqual(["D3.answered_qN"]);
    expect(suggestThresholds(reports)).toEqual({ answeredMax: 0.1 });
  });

  it("suggested JSON round-trips through THRESHOLDS_JSON", () => {
    expect(parseThresholds(JSON.stringify({ pauseNow: 0.8 }))).toMatchObject({ pauseNow: 0.8, choiceAct: 0.8, offRecord: 0.5 });
    expect(() => parseThresholds(JSON.stringify({ pauseNow: 3 }))).toThrow();
  });
});
