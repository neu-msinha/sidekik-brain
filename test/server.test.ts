import { STREAMS } from "@sidekik/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { SessionStore } from "../src/state.js";
import { ev, SID, silentLogger } from "./helpers.js";

const TOKEN = "test-internal-token-1234";
let close: (() => Promise<void>) | undefined;

function server(redisOk = true) {
  const store = new SessionStore();
  const app = buildServer({ version: "9.9.9", internalToken: TOKEN, store, logger: silentLogger(), checks: { redis: async () => redisOk } });
  close = () => app.close();
  return { app, store };
}

afterEach(async () => {
  await close?.();
});

describe("server", () => {
  it("GET /healthz reports ok with deps", async () => {
    const res = await server().app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "9.9.9", deps: { redis: "ok" } });
  });

  it("GET /healthz is 503 when a dependency is down", async () => {
    const res = await server(false).app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, deps: { redis: "down" } });
  });

  it("internal routes require X-Internal-Token", async () => {
    const { app, store } = server();
    store.applyLifecycle(ev(STREAMS.lifecycle, 0, { event: "started", kind: "capture", phase: "capture", workflow_id: "wf1", mode: "browser", language: "de" }));

    expect((await app.inject({ method: "GET", url: `/internal/sessions/${SID}/state` })).statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: `/internal/sessions/${SID}/state`, headers: { "x-internal-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ session_id: SID, phase: "capture" });
    const missing = await app.inject({ method: "GET", url: "/internal/sessions/nope/state", headers: { "x-internal-token": TOKEN } });
    expect(missing.statusCode).toBe(404);
  });
});
