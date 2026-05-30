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

- **cache-hit is `test.fixme`** — cross-session blueprint reuse is being
  (re)implemented in a separate slice and is not yet on this test base. The
  scenario is behaviour-based (turn-2 fast = reuse), so it activates by
  un-`fixme`-ing the test once the cache lands on the test base. The render
  scenario is fully live.
- **SDK matrix** — the scenarios currently target **claude-agent-sdk** (the
  key-available, proven path). The harness is SDK-parametric
  (`spawnScaffoldedApp({sdk})`) and `scaffold-and-boot.sh` forwards
  `OPENAI_API_KEY` / `GOOGLE_API_KEY` when present; extending to the other two
  SDKs is a matter of supplying their agent keys + flipping the scenario's
  `sdk`. ggui's own generation always needs `ANTHROPIC_API_KEY`.
- **Container build mount** — the cell bind-mounts the monorepo **read-write**
  to build + publish the cohort in place. In CI that is a fresh checkout (clean
  install). Locally it reuses your worktree's `node_modules`/`dist` (both
  gitignored, regenerable); files the cell writes may be root-owned.
- **Playwright browser version** — `cell-entry.sh` runs `playwright install
chromium` after `pnpm install` so the browser matches the resolved
  `@playwright/test` runner even if it differs from the baked image version.
