import { readFileSync } from "node:fs";
import { createBus, createLogger, type Bus, type Logger } from "@sidekik/contracts";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { assembleBrain, type BrainOverrides, type BrainParts } from "./brain.js";
import { wireConsumers } from "./consumers.js";
import type { BrainEnv } from "./env.js";
import { createJevRouter, type JevRouter } from "./jev/index.js";
import { buildServer } from "./server.js";
import { StoreFirstDirectory } from "./sessions.js";
import { SessionStore } from "./state.js";

export const VERSION = readVersion();

function readVersion(): string {
  // src/app.ts under tsx, dist/src/app.js when built.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

export type Brain = {
  app: FastifyInstance;
  bus: Bus;
  store: SessionStore;
  jev: JevRouter;
  parts: BrainParts;
  log: Logger;
  close(): Promise<void>;
};

export type StartOptions = { listen?: boolean; logger?: Logger; overrides?: BrainOverrides; jev?: JevRouter };

export async function startBrain(env: BrainEnv, opts: StartOptions = {}): Promise<Brain> {
  const log = opts.logger ?? createLogger("brain", { level: env.LOG_LEVEL });
  const store = new SessionStore();
  const bus = createBus(env.REDIS_URL, "brain", { logger: log });
  const health = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await health.connect();

  const jev = opts.jev ?? createJevRouter(env, { log, bus });
  const parts = assembleBrain(env, { store, bus, jev, log }, opts.overrides);
  parts.loop.start();

  const stopConsumers = wireConsumers(bus, store, log, parts.hooks);
  const app = buildServer({
    version: VERSION,
    internalToken: env.SK_INTERNAL_TOKEN,
    store,
    logger: log,
    decide: {
      decider: parts.decider,
      sessions: new StoreFirstDirectory(
        store,
        env.PERSISTENCE === "supabase" ? { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY } : undefined,
      ),
    },
    checks: { redis: async () => (await health.ping()) === "PONG" },
  });

  if (opts.listen ?? true) {
    await app.listen({ host: "::", port: env.PORT });
  } else {
    await app.ready();
  }

  return {
    app,
    bus,
    store,
    jev,
    parts,
    log,
    async close() {
      stopConsumers();
      parts.loop.stop();
      await parts.queue.idle();
      await app.close();
      await bus.close();
      await health.quit();
    },
  };
}
