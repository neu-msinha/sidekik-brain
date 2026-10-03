/**
 * Threshold calibration on rehearsal data (DESIGN ticket 10).
 *
 *   pnpm calibrate export [--session <id>] [--since <iso>] > rows.jsonl   # decisions_log → one row per question, label: null
 *   # …fill in "label" with the correct answer (true/false, the option, or the level)…
 *   pnpm calibrate report rows.jsonl [--target 0.9] [--min 10]           # accuracy per confidence bucket + THRESHOLDS_JSON
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { BUCKETS, flattenLogRow, report, suggestThresholds, type LabeledRow } from "../src/calibrate.js";
import type { JevAnswer } from "../src/jev/types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" },
    since: { type: "string" },
    target: { type: "string", default: "0.9" },
    min: { type: "string", default: "10" },
  },
});
const [mode, file] = positionals;

if (mode === "export") {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for export");
  const db = createClient(url, key, { auth: { persistSession: false } });
  let q = db.from("decisions_log").select("id, session_id, decision, provider, answer").order("created_at");
  if (values.session) q = q.eq("session_id", values.session);
  if (values.since) q = q.gte("created_at", values.since);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  for (const row of data as { id: string; session_id: string | null; decision: string; provider: string; answer: Record<string, JevAnswer> }[]) {
    for (const r of flattenLogRow(row)) process.stdout.write(`${JSON.stringify(r)}\n`);
  }
} else if (mode === "report" && file) {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LabeledRow);
  const reports = report(rows, Number(values.target), Number(values.min));
  const header = ["question", "n", ...BUCKETS.map((b) => `≥${b}`), "suggested"];
  console.log(header.join("\t"));
  for (const r of reports) {
    const cells = r.buckets.map((b) => (b.n ? `${Math.round((b.accuracy ?? 0) * 100)}% (${b.n})` : "-"));
    console.log([r.key, r.n, ...cells, r.suggested ?? "-"].join("\t"));
  }
  console.log(`\nTHRESHOLDS_JSON=${JSON.stringify(suggestThresholds(reports))}`);
} else {
  console.error("usage: pnpm calibrate export [--session id] [--since iso] > rows.jsonl\n       pnpm calibrate report rows.jsonl [--target 0.9] [--min 10]");
  process.exit(2);
}
