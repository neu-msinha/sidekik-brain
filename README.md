# sidekik-brain

Sidekik's judgment layer: it decides when the expert has paused, which question is worth asking, and answers typed fuzzy decisions (D1–D12) through Jev. Spec: `docs/DESIGN.md`. System design: `docs/ARCHITECTURE.md`.

Private service, local port **8082**.

## Run

```sh
pnpm install
docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis
cp .env.example .env        # fill from the team vault
pnpm dev                    # watch mode
```

Run against recorded bus events, with no teammates' services and no `.env`:

```sh
pnpm dev:mock                          # ../sidekik-platform/dev/fixtures/capture_sabine.jsonl if present, else test/fixtures/capture_mini.jsonl
pnpm dev:mock path/to/x.jsonl --speed 1
pnpm dev:mock --keep                   # keep serving after the replay
```

Fixture lines are `{"stream": "sk:…", "ev": <Envelope>}`. Each replay gets fresh session and event ids, so it can run repeatedly.

## Test

```sh
pnpm typecheck
pnpm test        # app.test.ts needs Redis (DB 14; override with TEST_REDIS_URL)
```

## Layout

| File | Role |
|---|---|
| `src/main.ts` | Entry point: env, start, graceful shutdown |
| `src/app.ts` | `startBrain(env)`: wires logger, bus, session store, consumers and HTTP server |
| `src/env.ts` | zod env schema (extends `BaseServiceEnvSchema` from contracts) |
| `src/state.ts` | `SessionStore`: per-session lifecycle, speech/typing timers, recent screen events and turns |
| `src/consumers.ts` | Bus consumers for lifecycle, speech, screen and turns, plus `BrainHooks` for the capture loop |
| `src/server.ts` | Fastify: `GET /healthz`, `/internal/*` behind `X-Internal-Token` |
| `scripts/dev-mock.ts`, `scripts/replay.ts` | Fixture replay onto the bus |

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `GET /healthz` | none | `{ok, version, deps:{redis}}`, 503 if a dependency is down |
| `GET /internal/sessions/:id/state` | `X-Internal-Token` | Debug snapshot of a session's state |

## Behaviour so far

- Sessions start on lifecycle `started`. Sessions in `mode: "replay"` are ignored entirely.
- The capture loop is active only for `kind: capture` + `phase: capture` while on record.
- `offrecord_on` pauses it. `task_done`, a phase change away from capture, or `ended` stop it and fire `onCaptureStopped`.
- Events for sessions brain never saw start are dropped.
- Timers are in session time (`t_ms`), so replays behave like live sessions.
