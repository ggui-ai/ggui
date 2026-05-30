# scaffold-render — sub-tier B container e2e

Boots the **scaffolded published app** and drives it with real behaviour
scenarios. This is the highest-fidelity gate in the OSS e2e landscape: it
exercises the **shipped `@ggui-ai/*` packages**, the **published
`create-agentic-app` scaffold**, and the app's own **`pnpm dev`** orchestrator —
not workspace source.

```
build @ggui-ai/* → Verdaccio (cohort) → npx create-agentic-app → pnpm install
  → pnpm dev (ggui 6781 · mcps 6782 · agent 6790 · web 6890) → scenarios
```

## What it proves

| Scenario      | Target                      | Asserts                                                                                                                                                            |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **render**    | web SPA (`localhost:6890`)  | a real prompt → agent → `ggui_render` → UI mounts; the requested item is visible through the double-iframe.                                                        |
| **cache-hit** | ggui MCP (`localhost:6781`) | cross-session blueprint reuse via the **latency channel** (turn-1 cold `>1s`, turn-2 hit `<10s`). `/r/<short>` is off the wire, so latency is the only observable. |

Sub-tier A (`../scaffold-resolution/`) already proves the scaffold **installs**
from the published cohort (keyless, deterministic). Sub-tier B proves it
**runs + renders + caches** (real LLM).

## Run it

Both paths need `ANTHROPIC_API_KEY` (drives the agent **and** ggui's UI
generation) and Docker.

```bash
# Container (the "on container" deliverable; browser-in-cell, all localhost):
ANTHROPIC_API_KEY=… make test-scaffold-render

# Host-side (faster iteration; Verdaccio in Docker, Playwright on the host).
# One app at a time — ensure ports 6781/6782/6790/6890 are free first.
ANTHROPIC_API_KEY=… make test-scaffold-render-host
```

First run is slow (~15–25 min): a full cohort build + publish + scaffold +
install + boot + the LLM render. It is a **nightly capstone**, not a fast gate —
CI runs it on a schedule + `workflow_dispatch` only, never per-PR.

## Landscape (where this sits)

| Suite                      | Subject                         | Proves                              | Speed   |
| -------------------------- | ------------------------------- | ----------------------------------- | ------- |
| `journeys/`                | workspace source                | behaviour, fast                     | minutes |
| `clean-room-consumer/`     | published packages (single npm) | `@ggui-ai/*` install + load         | minutes |
| `scaffold-resolution/` (A) | scaffolded template tree        | scaffold **installs** from cohort   | minutes |
| **`scaffold-render/` (B)** | **scaffolded + booted app**     | **app renders + caches (real LLM)** | nightly |

## Files

- `scripts/setup.sh` — build cohort → Verdaccio → publish → assemble templates → git-init. Shared by host + cell (`SKIP_VERDACCIO_BOOT=1` for the cell's sibling Verdaccio).
- `scripts/scaffold-and-boot.sh` — per-SDK: `create-agentic-app` (Verdaccio-pinned) → write `.env.local` → `pnpm install` → `pnpm dev` (foreground).
- `tests/scaffold-app-harness.ts` — `spawnScaffoldedApp({sdk})` → `ScaffoldAppHandle`; boots the script as a process group, waits for web-ready, tears the whole `pnpm dev` tree down cleanly (SIGTERM → dev.mjs drains its detached servers → SIGKILL backstop → ports freed).
- `tests/render.spec.ts` · `tests/cache-hit.spec.ts` — the two scenarios.
- `playwright.config.ts` — `workers:1`, `retries:1`, generous timeout; loads the root `.env.local`.
- `Dockerfile` · `docker-compose.yml` · `scripts/cell-entry.sh` — the cell (Playwright+Chromium baked, monorepo bind-mounted) + sibling Verdaccio.

## Status & caveats (read before the first container run)

- **All three SDKs are live** — `render.spec.ts` runs claude / openai / google,
  each its own describe, key-gated (ggui generation always needs
  `ANTHROPIC_API_KEY`; the agent needs its own `OPENAI_API_KEY` /
  `GEMINI_API_KEY`). The web SPA is pointed at the SDK's agent via a `?agent=`
  query param (App.tsx priority-1) because `dev:web` runs plain vite, which
  never reads the app-root `.env.local`. A missing key skips that SDK.
- **cache-hit is live** — proven: turn-1 cold ≈ 11.6s vs turn-2 ≈ 6ms (~1900×),
  so cross-session blueprint reuse is wired on this base. It's a real regression
  gate: if a change breaks reuse, turn-2 falls back to a cold gen and fails the
  `< 10s` budget. (The harness waits for ggui to be listening before the test
  fires its first MCP call, or the direct `:6781` hit would race the boot.)
- **LLM variance** — the render scenarios are non-deterministic; `retries:1`
  absorbs the occasional miss (observed: openai needed one retry). Expected for
  a real-LLM capstone.
- **Container build mount** — the cell bind-mounts the monorepo **read-write**
  to build + publish the cohort in place. In CI that is a fresh checkout (clean
  install). Locally it reuses your worktree's `node_modules`/`dist` (both
  gitignored, regenerable); files the cell writes may be root-owned.
- **Playwright browser version** — `cell-entry.sh` runs `playwright install
chromium` after `pnpm install` so the browser matches the resolved
  `@playwright/test` runner even if it differs from the baked image version.
