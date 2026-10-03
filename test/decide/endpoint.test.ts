import { DecisionResponseSchema, STREAMS } from "@sidekik/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Decider } from "../../src/decide/decider.js";
import { DEFAULT_THRESHOLDS } from "../../src/decide/thresholds.js";
import { buildServer } from "../../src/server.js";
import { StoreFirstDirectory } from "../../src/sessions.js";
import { SessionStore } from "../../src/state.js";
import { JevError, type JevAsk, type JevClient, type JevResult } from "../../src/jev/types.js";
import { ev, ORG, silentLogger } from "../helpers.js";
import { choice, noul, routerWith, score, ScriptedClient } from "../support.js";

const TOKEN = "test-internal-token-1234";
const headers = { "x-internal-token": TOKEN };
let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

function server(client: JevClient, opts: { budgetMs?: number } = {}) {
  const { router, sink } = routerWith(client);
  const store = new SessionStore();
  store.applyLifecycle(ev(STREAMS.lifecycle, 0, { event: "started", kind: "capture", phase: "debrief", workflow_id: "wf", mode: "browser", language: "de" }, "sess-debrief"));
  const app = buildServer({
    version: "t",
    internalToken: TOKEN,
    store,
    logger: silentLogger(),
    checks: {},
    decide: { decider: new Decider(router, DEFAULT_THRESHOLDS), sessions: new StoreFirstDirectory(store), ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}) },
  });
  close = () => app.close();
  return { app, sink };
}

const jev = () =>
  new ScriptedClient("jev", "jev-1.13.0", (q) =>
    ({
      teachback_reply: choice("confirmed", 0.91),
      specificity: score(1, 0.82),
      refers_to_unknown_entity: noul(0.9),
      expert_signals_done: noul(0.2),
    })[q],
  );

describe("POST /internal/decide", () => {
  it("answers several decisions in one Jev call, in request order", async () => {
    const client = jev();
    const { app, sink } = server(client);
    const res = await app.inject({
      method: "POST",
      url: "/internal/decide",
      headers,
      payload: {
        session_id: "sess-debrief",
        decisions: [
          { id: "D8", state: { teachback: "…", reply: "Ja, genau so." } },
          { id: "D6", state: { explanation: "Das macht man halt so, frag den Peter." } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = DecisionResponseSchema.parse(res.json());
    expect(body.results.map((r) => r.id)).toEqual(["D8", "D6"]);
    expect(body.results[0]).toMatchObject({ answer: "confirmed", confidence: 0.91, provider: "jev", escalated: false });
    expect(body.results[1]).toMatchObject({
      answer: 1,
      answers: { specificity: { answer: 1, score: 1 }, refers_to_unknown_entity: { answer: true, p_true: 0.9 } },
    });
    expect(client.asks).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.rows.map((r) => [r.decision, r.org_id])).toEqual([
      ["D8", ORG],
      ["D6", ORG],
    ]);
  });

  it("needs the internal token", async () => {
    const res = await server(jev()).app.inject({ method: "POST", url: "/internal/decide", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid requests, D3 and duplicate ids", async () => {
    const { app } = server(jev());
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/internal/decide", headers, payload: payload as object });
    expect((await post({ session_id: "s", decisions: [] })).statusCode).toBe(400);
    expect((await post({ session_id: "s", decisions: [{ id: "D99", state: {} }] })).statusCode).toBe(400);
    expect((await post({ session_id: "s", decisions: [{ id: "D3", state: {} }] })).json()).toMatchObject({ error: /D3/ });
    expect((await post({ session_id: "s", decisions: [{ id: "D8", state: 1 }, { id: "D8", state: 2 }] })).statusCode).toBe(400);
  });

  it("returns 503 when providers fail or the 600 ms budget runs out", async () => {
    const down: JevClient = {
      provider: "jev",
      model: "j",
      ask: async () => {
        throw new JevError("unavailable", "jev", "down");
      },
    };
    const res = await server(down).app.inject({ method: "POST", url: "/internal/decide", headers, payload: { session_id: "s", decisions: [{ id: "D12", state: {} }] } });
    expect(res.statusCode).toBe(503);

    const slow: JevClient = {
      provider: "jev",
      model: "j",
      ask: (_req: JevAsk, opts) =>
        new Promise<JevResult>((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new JevError("timeout", "jev", "aborted")))),
    };
    const started = Date.now();
    const timed = await server(slow, { budgetMs: 50 }).app.inject({ method: "POST", url: "/internal/decide", headers, payload: { session_id: "s", decisions: [{ id: "D12", state: {} }] } });
    expect(timed.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("decides for sessions brain hasn't seen, without logging rows it can't attribute", async () => {
    const { app, sink } = server(jev());
    const res = await app.inject({ method: "POST", url: "/internal/decide", headers, payload: { session_id: "unknown", decisions: [{ id: "D12", state: {} }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ id: "D12", answer: false });
    expect(sink.rows).toHaveLength(0);
  });
});
