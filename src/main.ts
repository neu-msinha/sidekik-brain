import { startBrain } from "./app.js";
import { loadBrainEnv } from "./env.js";

const env = loadBrainEnv();
const brain = await startBrain(env);
brain.log.info({ port: env.PORT }, "brain listening");

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    brain.log.info({ signal }, "shutting down");
    brain
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        brain.log.error({ err }, "shutdown failed");
        process.exit(1);
      });
  });
}
