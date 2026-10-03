import { internalAuth, type Logger } from "@sidekik/contracts";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerDecideRoute } from "./decide/endpoint.js";
import type { Decider } from "./decide/decider.js";
import type { SessionDirectory } from "./sessions.js";
import type { SessionStore } from "./state.js";

export type HealthCheck = () => Promise<boolean>;

export type ServerDeps = {
  version: string;
  internalToken: string;
  store: SessionStore;
  /** Named dependency checks reported by /healthz. */
  checks: Record<string, HealthCheck>;
  logger: Logger;
  /** Serves POST /internal/decide when set. */
  decide?: { decider: Decider; sessions: SessionDirectory; budgetMs?: number };
};

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app: FastifyInstance = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    // Health probes would flood the logs; every other request is logged.
    logController: new LogController({ disableRequestLogging: (req) => req.url === "/healthz" }),
  });

  app.get("/healthz", async (_req, reply) => {
    const entries = await Promise.all(
      Object.entries(deps.checks).map(async ([name, check]) => {
        const ok = await check().catch(() => false);
        return [name, ok ? "ok" : "down"] as const;
      }),
    );
    const ok = entries.every(([, status]) => status === "ok");
    return reply.code(ok ? 200 : 503).send({ ok, version: deps.version, deps: Object.fromEntries(entries) });
  });

  // Internal routes: private network + X-Internal-Token.
  app.register(
    async (internal) => {
      internal.addHook("preHandler", internalAuth(deps.internalToken));

      internal.get<{ Params: { id: string } }>("/sessions/:id/state", async (req, reply) => {
        const state = deps.store.get(req.params.id);
        if (!state) return reply.code(404).send({ error: "unknown session" });
        return state;
      });

      if (deps.decide) registerDecideRoute(internal, { ...deps.decide, log: deps.logger });
    },
    { prefix: "/internal" },
  );

  return app;
}
