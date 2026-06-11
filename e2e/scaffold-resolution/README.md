# Scaffold-Resolution Gate

> **Sub-tier A.** Proves a freshly-assembled agentic-app template **installs**
> from the about-to-ship `@ggui-ai/*` cohort (published version ranges) —
> catching the version-range-resolution class (the `@ggui-ai/protocol@0.2.0`-not-found
> incident) that workspace-linked tests cannot see. Deterministic, keyless: no
> LLM, no agent boot, no Playwright.

```bash
make test-scaffold-resolution
```

```bash
# Falsification — poisons one version range to ^99.0.0; MUST fail.
SELFTEST=1 make test-scaffold-resolution
```

---

## Axis — template install gate

This gate sits at the intersection of **packaging correctness** and
**template assembly**: it asks "does a project scaffolded from the current
cohort actually `pnpm install` cleanly?". The clean-room-consumer gate proves
published packages load; this gate proves a scaffolded _project_ can resolve
and install them from published version ranges.

See [Test Placement](../../../docs/principles/test-placement.md).

---

## Landscape

| Gate                              | Tests                                                                 | Keyless? |
| --------------------------------- | --------------------------------------------------------------------- | -------- |
| **`clean-room-consumer/`**        | Do published `@ggui-ai/*` packages install and import in isolation?   | Yes      |
| **`scaffold-resolution/`** (this) | Does a scaffolded template project install from the published cohort? | Yes      |
| Sub-tier B (planned)              | Does the assembled app render with a real LLM?                        | No       |

The first two are complementary and both keyless. `clean-room-consumer` catches
broken `files[]`/`exports`/`main`/`deps` per-package; `scaffold-resolution`
catches version-range mismatches across the assembled project graph that only
appear once the template is scaffolded with published ranges instead of
workspace symlinks.

---

## How it works

Five stages, orchestrated by `scripts/run.sh`, run **on the host** (not inside
a clean-room container — the template assembler `oss/scripts/build-templates.mjs`
is monorepo-rooted and must run in the monorepo tree):

### [1/5] Build

```
pnpm build   (repo-root)
```

Builds every `@ggui-ai/*` package so dist exists before publishing. Required
because `publish-all.sh` publishes built tarballs.

### [2/5] Start throwaway Verdaccio

A single `docker run` starts `verdaccio/verdaccio:5` on **port 4874** (not
4873, to avoid colliding with `make registry` / `ggui-verdaccio-smoke` during
development). The gate's own `verdaccio.yaml` is bind-mounted; it raises
`max_body_size` to `50mb` because `@ggui-ai/ui-gen` packs to ~18 MB (the
default 10 MB limit would reject it). `@ggui-ai/*` packages are served locally
only; every other package is proxied to npmjs.

The gate polls `/-/ping` for up to 30 s, then fails hard if Verdaccio is
unreachable.

### [3/5] Publish

Reuses `oss/e2e/clean-room-consumer/scripts/publish-all.sh` to publish the
full `@ggui-ai/*` graph to Verdaccio **leaf-first** (dependency order computed
from the live dep graph by `compute-order.mjs` — no hand-kept list).

### [4/5] Assemble templates

```
node oss/scripts/build-templates.mjs --all --out-base=<tmpdir>/templates-src
```

Runs the monorepo's template assembler in **published-version-range** mode
(real `^x.y.z` ranges, not workspace links). If `SELFTEST=1`, rewrites every
`"@ggui-ai/protocol"` range to `"^99.0.0"` before git-committing the
assembled tree — the poisoned range must cause `pnpm install` to fail in
stage 5.

The assembled tree is `git init` + committed so `create-agentic-app`'s git
clone path works against it.

### [5/5] Scaffold + install (3 SDKs)

For each of `claude-agent-sdk`, `openai-agents-sdk`, `google-adk`:

1. `npx @ggui-ai/create-agentic-app` is invoked with `GGUI_TEMPLATES_REPO_URL`
   pointing at the locally assembled git repo (step 4) and
   `npm_config_registry` pointing at Verdaccio — so `create-agentic-app`
   itself is fetched from Verdaccio. The `--no-git` and no-`--install` flags
   are used so the gate controls the registry of the install step.

2. A project-level `.npmrc` is written into the scaffolded app directory:

   ```
   registry=http://localhost:4874/
   //localhost:4874/:_authToken=scaffold-gate-token
   cache-dir=<tmpdir>/pnpm-cache
   store-dir=<tmpdir>/pnpm-store
   ```

   A project `.npmrc` is the strongest registry signal pnpm honors across
   every nested workspace package. Per-run `cache-dir` and `store-dir` are
   required to prevent a shared pnpm store from carrying a prior run's
   integrity hash and rejecting the newly-published tarball with
   `ERR_PNPM_TARBALL_INTEGRITY` on the second run.

3. `pnpm install` runs from the scaffolded app root.

4. **Resolution proof** (see below).

---

## The resolution proof

The template range `^0.2.0-alpha.1` is satisfied by both the local stable base
(`0.2.0`, published to Verdaccio) and the npmjs prereleases (`0.2.0-alpha.N`).
A silent leak to npmjs would still `pnpm install` successfully — so passing
install is not sufficient proof of Verdaccio sourcing.

The gate discriminates by the **exact installed version**: after `pnpm
install`, it reads the installed `@ggui-ai/protocol` version from pnpm's
virtual store at `node_modules/.pnpm/@ggui-ai+protocol@<version>/` and compares
it against the committed stable base read from
`oss/packages/protocol/package.json`.

- **Verdaccio path** → installed version == local stable base (e.g. `0.2.0`).
  npmjs does NOT have the stable base — only `-alpha.N` prereleases exist
  there — so a match proves the install resolved from Verdaccio.
- **npmjs leak** → installed version is a prerelease (`0.2.0-alpha.N`). The
  gate fails with `RESOLUTION LEAK`.

If `@ggui-ai/protocol` is absent from the virtual store entirely, the gate
also fails hard.

---

## Files

```
oss/e2e/scaffold-resolution/
├── README.md          — this file
├── verdaccio.yaml     — gate-specific config (max_body_size: 50mb, port 4873 in container, host-mapped to 4874)
└── scripts/
    └── run.sh         — 5-stage orchestrator (build → Verdaccio → publish → assemble → scaffold+install)
```

Shared with clean-room-consumer:

```
oss/e2e/clean-room-consumer/scripts/
├── publish-all.sh     — pnpm publish loop → Verdaccio, leaf-first
└── compute-order.mjs  — topo-sort of the @ggui-ai/* dep graph
```

---

## Running it

```bash
make test-scaffold-resolution          # full gate, all 3 SDKs
SELFTEST=1 make test-scaffold-resolution  # falsification — MUST exit non-zero
```

The gate is slow (full `pnpm build` + Verdaccio publish of ~33 packages + 3
scaffold installs). Cold runs are typically 15–25 min. It is deterministic and
keyless — safe to run in any environment with Docker and pnpm available.
