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
# Container — ONE ephemeral container (docker run --rm; logs stream to your
# terminal; removed on exit). Everything runs in-cell on the container's own
# localhost: Verdaccio (a process), the cohort build/publish, the scaffolded
# app, and the browser. Builds the image once (cached after).
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GEMINI_API_KEY=… make test-scaffold-render

# Host-side (faster iteration; Verdaccio in Docker, Playwright on the host).
# One app at a time — ensure ports 6781/6782/6790/6890 are free first.
ANTHROPIC_API_KEY=… make test-scaffold-render-host
```

(Set `OPENAI_API_KEY` / `GEMINI_API_KEY` too to exercise those SDKs; a missing
key skips that SDK. `ANTHROPIC_API_KEY` is always required — it drives ggui's
UI generation for every SDK.)

The container run is slow cold (~30–40 min): it copies the repo in, does a fresh
full `pnpm install` + cohort build with no warm cache, then publishes, scaffolds,
boots, and runs the LLM renders. The host-side path reuses your warm
`node_modules` + turbo cache (~10 min). Both are **nightly capstones**, not fast
gates — CI runs the container on a schedule + `workflow_dispatch` only, never per-PR.

## Landscape (where this sits)

| Suite                      | Subject                         | Proves                              | Speed   |
| -------------------------- | ------------------------------- | ----------------------------------- | ------- |
| `journeys/`                | workspace source                | behaviour, fast                     | minutes |
| `clean-room-consumer/`     | published packages (single npm) | `@ggui-ai/*` install + load         | minutes |
| `scaffold-resolution/` (A) | scaffolded template tree        | scaffold **installs** from cohort   | minutes |
| **`scaffold-render/` (B)** | **scaffolded + booted app**     | **app renders + caches (real LLM)** | nightly |

## Files

- `scripts/setup.sh` — build cohort → Verdaccio → publish → assemble templates → git-init. Shared by host + cell (`SKIP_VERDACCIO_BOOT=1` when the cell already started Verdaccio as a process).
- `scripts/scaffold-and-boot.sh` — per-SDK: `create-agentic-app` (Verdaccio-pinned) → write `.env.local` → `pnpm install` → `pnpm dev` (foreground).
- `tests/scaffold-app-harness.ts` — `spawnScaffoldedApp({sdk})` → `ScaffoldAppHandle`; boots the script as a process group, waits for web-ready, tears the whole `pnpm dev` tree down cleanly (SIGTERM → dev.mjs drains its detached servers → SIGKILL backstop → ports freed).
- `tests/render.spec.ts` · `tests/cache-hit.spec.ts` — the two scenarios.
- `playwright.config.ts` — `workers:1`, `retries:1`, generous timeout; loads the root `.env.local`; `--no-sandbox` for in-container root Chromium.
- `Dockerfile` · `scripts/cell-entry.sh` — the single self-contained cell image (Playwright+Chromium + pnpm + Verdaccio-as-a-process). `cell-entry.sh` copies the RO-mounted repo into `/work`, starts Verdaccio, installs + builds, then runs Playwright — all in one `docker run --rm` container.

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
- **Container isolation** — the monorepo is bind-mounted **read-only** at
  `/repo`; `cell-entry.sh` copies it into the container's own `/work` (excluding
  `node_modules`/`.git`/`dist`/`.turbo`) and installs + builds there. So the
  cell's fresh install never mutates the host's `node_modules` (whose native-
  module ABI may differ from the image's Node). The container is fully ephemeral
  (`--rm`); nothing leaks back to the host.
- **Playwright browser version** — `cell-entry.sh` runs `playwright install
chromium` after `pnpm install` so the browser matches the resolved
  `@playwright/test` runner even if it differs from the baked image version.
