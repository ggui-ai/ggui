# samples-render (sub-tier B, samples-compose harness)

Container e2e proving the **shipped** `@ggui-ai/*` cohort works end-to-end
through a real agentic app — with **no scaffolder in the loop**. The harness
composes the app **directly from the canonical samples** (successor to the
retired `create-agentic-app`-based scaffold-render harness):

```
samples/agents/<sdk>/        → servers/agent/
samples/gguis/default/       → servers/ggui/
samples/mcp-servers/todo/    → servers/mcps/todo/
samples/apps/ggui-basic-web/ → apps/web/
app-shell/                   → the root (workspace wrapper + 4-server `pnpm dev`)
```

`compose-app.mjs` performs the merge and rewrites every `@ggui-ai/*`
`workspace:*` dep to the prerelease-inclusive caret range
(`^<base>-alpha.0`), so the composed app installs the **published** cohort
from a throwaway Verdaccio — keeping the version-range-resolution failure
class observable (an unsatisfiable range fails the install loudly).

## Scenarios

| Spec                      | Proves                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `render.spec.ts`          | Full agent loop per SDK (render → click → reload/rehydrate) through the double-iframe         |
| `cache-hit.spec.ts`       | Cross-render blueprint reuse by blueprintId identity (exact, relaxed, variance V1–V3, quirky) |
| `seed-pool-reuse.spec.ts` | Cross-deployment reuse via `ggui serve --seed-pool` (sqlite export → fresh deployment seeded) |

Real LLM → cost + non-determinism → **nightly + manual only, never per-PR**
(`.github/workflows/samples-render.yml`).

## Running

```bash
make test-samples-render        # container (browser-in-cell) — the CI path
make test-samples-render-host   # host-side Playwright, Verdaccio via Docker
```

Needs `ANTHROPIC_API_KEY` (always — the claude-sdk lanes generate with
Claude); `OPENAI_API_KEY` / `GEMINI_API_KEY` enable the other SDK render
scenarios (absent ⇒ skipped).

## Layout

- `app-shell/` — harness-owned workspace wrapper (root package.json,
  pnpm-workspace.yaml, `dev.mjs` 4-server orchestrator + `stop-dev.mjs`).
  What the retired template _shell_ used to provide, minus the publish/DX
  artifacts (README, railway.toml, `.claude/`, `.reference/`).
- `scripts/compose-app.mjs` — the samples merge (see above).
- `scripts/setup.sh` — build the cohort + publish to Verdaccio + seed
  upstream-pinned `@ggui-ai/*` versions (once/run).
- `scripts/seed-upstream-pins.mjs` — the with-guuey compose installs
  published `@guuey/*` packages from real npm, and those pin `@ggui-ai/*`
  deps EXACTLY; once the local cohort bumps past a pin, the exact version
  would 404 against the local-only `@ggui-ai/*` block (a harness artifact —
  real npm always has it). Seeds those exact versions from real npm into the
  run's Verdaccio instead of adding an uplink proxy, which would false-green
  ANY missing local package. Loud both ways; no-op while cohort == all pins.
  Pure decision function self-tested per-PR (`--self-test`,
  samples-render.yml).
- `scripts/compose-and-boot.sh` — per-SDK compose → `.npmrc` (Verdaccio pin)
  → `.env.local` → `pnpm install` → foreground `pnpm dev`.
- `scripts/cell-entry.sh` + `Dockerfile` — the browser-in-cell container.
- `tests/composed-app-harness.ts` — `spawnComposedApp()` boot/teardown.

The browserless MCP turn-driver lives in the shared fixtures home
(`oss/e2e/fixtures/mcp-turn/`) — it is also consumed by the cloud
scaffold-persist / scaffold-cloud-render scenarios.
