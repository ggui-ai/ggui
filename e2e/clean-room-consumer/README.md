# Clean-room Consumer

> **The release blocker.** Verifies every `@ggui-ai/*` package actually
> works when installed from a registry — exactly as an external npm
> consumer gets it — _before_ the immutable npm publish.

```bash
make test-clean-room-consumer
```

Exit 0 → safe to publish. Non-zero → **do not publish**, something is
broken in a way the monorepo can't see.

---

## Why this exists

Inside the monorepo, `@ggui-ai/*` packages resolve to each other via
pnpm `workspace:*` symlinks pointing straight at **TypeScript source**.
That masks an entire class of bugs that only appear once a package is
_published_:

- a missing `files[]` entry → `dist/` never ships
- a wrong `exports` / `main` / `types` map → `import` resolves to nothing
- a dependency declared as `devDependency` → consumer install is broken
- `dist/` not built, stale `.d.ts`, broken subpath exports

`pnpm typecheck` and `pnpm build` are both green when these bugs exist.
The only thing that catches them is a **real registry round-trip**:
`pnpm publish` → `npm install @ggui-ai/x` from a registry → import + run.

This gate does that round-trip in Docker, against a throwaway
[Verdaccio](https://verdaccio.org/) registry, with **zero workspace
linkage** — the consumer project literally cannot see the monorepo.

A failed gate costs a re-run. A bad publish costs a **burned package
name** (npm blocks re-publishing a version, and unpublish is locked
after 72h). The gate runs _before_ that point of no return.

---

## Which e2e do I run? — the landscape

The repo has three e2e surfaces. They are **not interchangeable**:

| Surface                        | Package                 | Tests                                                             | When to run                                                                                                                                                                         |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`e2e/`**                     | `@ggui-private/e2e`     | ggui.ai hosted journeys, MCP/render/oauth contracts, ops, quality | You changed the **hosted product** (console, api.ggui.ai, render endpoint). Needs a deployed Amplify sandbox.                                                                       |
| **`e2e/oss/`**                 | `@ggui-private/e2e-oss` | Solo-builder OSS flows — `ggui serve`, generation, pairing        | You changed **OSS CLI / server / SDK behavior**. Runs against **workspace** packages.                                                                                               |
| **`e2e/clean-room-consumer/`** | _(this)_                | Every `@ggui-ai/*` package installs + runs from a registry        | You changed **anything that affects packaging** — `package.json` `files`/`exports`/`main`/`deps`, or you're about to **npm publish**. Runs against **registry-installed** packages. |

Rule of thumb:

- **`e2e/oss/` answers** "does the code behave correctly?"
- **`e2e/clean-room-consumer/` answers** "do the _published artifacts_ even load?"

They are complementary. `e2e/oss/` can be 100% green while the gate
fails — that is precisely the bug class the gate exists for.

---

## How it works

```
            docker compose
   ┌───────────────────────────────────────────────────┐
   │                                                   │
   │   verdaccio          gate-runner                  │
   │   (registry)         (build → publish → consume)  │
   │      ▲                     │                      │
   │      │  publish all        │                      │
   │      └─────────────────────┘                      │
   │      │  npm install                               │
   │      └────────────►  /tmp/consumer  (clean room)  │
   │                          │                        │
   │                          └──►  smokes             │
   └───────────────────────────────────────────────────┘
```

Five stages, orchestrated by `scripts/run-gate.sh`:

1. **Wait** — block until Verdaccio is healthy.
2. **Publish** — `pnpm publish` every publishable `@ggui-ai/*` package
   to Verdaccio, **leaf-first** (a package is published only after
   everything it depends on). The order is computed from the live
   dependency graph by `scripts/compute-order.mjs` — no hand-kept list.
3. **Consume** — in a fresh dir with no monorepo ancestry, generate a
   consumer `package.json` listing every package, then `npm install`
   (registry pinned to Verdaccio). `npm`, not `pnpm` — pnpm has
   workspace-rescue paths that would hide publish-shape breakage.
4. **Packaging + CLI smokes** — `import-smoke` + `cli-smoke`.
5. **Serve smoke** — boot the `ggui` binary as a real server.

### What the smokes assert

| Smoke              | Hard gate                                                                                                                                                                                            | Advisory                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `import-smoke.mjs` | every package installed; each package with a `.` entry loads via ESM `import()`                                                                                                                      | bin/app/asset packages (no `.` entry) are install-checked only; DOM/RN packages may throw in plain Node → warning |
| `cli-smoke.mjs`    | every `ggui` subcommand — `--version`, `--help`, `gadget create`, `blueprint create`, `login`, `whoami`, `keys list` (cloud + `--keys-file`), `logout` — exits 0; `dev` loads without a module crash | —                                                                                                                 |
| `serve-smoke.mjs`  | `ggui serve --mcp-only` binds its port, logs a listening banner, and shuts down cleanly on SIGTERM                                                                                                   | HTTP probes of `/health` + `/mcp` (routes vary by mode)                                                           |

The auth commands run against an in-process **mock auth server**
(`mock-auth-server.mjs`) with an isolated `HOME`, so `login` / `whoami`
/ `keys` are fully hermetic and non-interactive — no live ggui.ai, no
device-flow browser step. (The real device flow is exercised by
`e2e/`'s hosted-journeys suite.)

The `npm install` in stage 3 is itself a hard gate: it proves every
tarball is fetchable and every declared dependency resolves.

---

## Files

```
e2e/clean-room-consumer/
├── README.md             — this file
├── docker-compose.yml    — verdaccio + gate-runner services
├── Dockerfile            — gate-runner image (builds every package)
├── verdaccio/
│   └── config.yaml       — throwaway registry config
├── scripts/
│   ├── compute-order.mjs — leaf-first topo sort of the dep graph
│   ├── publish-all.sh    — pnpm publish loop → Verdaccio
│   └── run-gate.sh       — 5-stage orchestrator
└── consumer/             — clean-room consumer template
    ├── npmrc             — registry pin (copied to .npmrc at runtime)
    └── smoke/
        ├── import-smoke.mjs       — install + ESM-import every package
        ├── cli-smoke.mjs          — every `ggui` subcommand
        ├── mock-auth-server.mjs   — hermetic fake of api.ggui.ai auth
        └── serve-smoke.mjs        — boot `ggui serve` for real
```

`packages/.dockerignore` keeps host `node_modules` / `dist` out of the
build context so the image build is hermetic.

---

## Running it

```bash
make test-clean-room-consumer
```

This will `docker compose build` (fresh build of every package), `up`
both services, run the gate, and `down -v` to wipe the Verdaccio
volume. The make target's exit code is the gate-runner's exit code —
wire it into a release checklist and a non-zero result blocks.

To iterate on the gate scripts themselves, `scripts/` and `consumer/`
are bind-mounted — edit and re-run `docker compose up` without a
rebuild. Editing **package source** does require a rebuild (the build
is baked into the image).

### During active refactoring

The image build runs `pnpm install --frozen-lockfile` by default — a
publish should never happen off a lockfile that has drifted from the
`package.json`s. While `packages/` is mid-refactor and the lockfile is
intentionally stale, override it:

```bash
PNPM_INSTALL_FLAGS=--no-frozen-lockfile make test-clean-room-consumer
```

Switch back to the default (frozen) before treating a gate run as a
real release sign-off.

---

## Roadmap

The gate is fast, deterministic, and keyless. Done so far: packaging +
import smokes, full per-subcommand CLI coverage, the `ggui serve` boot
smoke, and a hermetic mock auth server. Still planned:

1. **MCP `initialize` handshake** — promote the serve smoke's `/mcp`
   probe from informational to a hard assertion (parse the
   StreamableHTTP / SSE response).
2. **Wire the `e2e/oss/` packaging-shape subset** — the deterministic,
   no-LLM specs, re-pointed at the consumer install. (Live-generation
   specs stay in `e2e/oss/` — they need `ANTHROPIC_API_KEY` and are
   non-deterministic; not gate material.)
3. **Fold into `release.yml`** — once the gate has been green twice on
   real release candidates, add it as a required `preflight` job and
   replace that workflow's hand-maintained `ORDER` array with
   `compute-order.mjs`.
