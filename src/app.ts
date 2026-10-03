import { readFileSync } from "node:fs";
import { createBus, createLogger, type Bus, type Logger } from "@sidekik/contracts";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { wireConsumers, type BrainHooks } from "./consumers.js";
import type { BrainEnv } from "./env.js";
import { buildServer } from "./server.js";
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
  log: Logger;
  close(): Promise<void>;
};

export type StartOptions = { listen?: boolean; hooks?: BrainHooks; logger?: Logger };

export async function startBrain(env: BrainEnv, opts: StartOptions = {}): Promise<Brain> {
  const log = opts.logger ?? createLogger("brain", { level: env.LOG_LEVEL });
  const store = new SessionStore();
  const bus = createBus(env.REDIS_URL, "brain", { logger: log });
  const health = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await health.connect();

  const stopConsumers = wireConsumers(bus, store, log, opts.hooks);
  const app = buildServer({
    version: VERSION,
    internalToken: env.SK_INTERNAL_TOKEN,
    store,
    logger: log,
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
    log,
    async close() {
      stopConsumers();
      await app.close();
      await bus.close();
      await health.quit();
    },
  };
}
