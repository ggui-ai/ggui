# `@ggui-private/e2e-oss`

Dedicated E2E harness for the **`ggui` OSS** product boundary —
Phase 5 per
[`docs/plans/2026-04-21-oss-split-e2e-phases.md`](../../docs/plans/2026-04-21-oss-split-e2e-phases.md).

Scope lock: **this package proves the OSS claim**. A developer runs
`npx ggui serve` on their own machine, with their own LLM key, and
nothing calls `api.ggui.ai` at any step. Every spec here tests
that surface. No sandbox deploys, no Cognito auth fixtures, no
`aws-amplify` — by design.

## Why this is a separate package

The `@ggui-private` scope is monorepo-only dev-infra per
CLAUDE.md Tier 4 — E2E packages don't publish to npm. The "OSS"
claim lives in the **dep graph**: this package's `devDependencies`
contain zero references to any other `@ggui-private/*` package,
no hosted-cloud SDK (`aws-amplify`, `@aws-sdk/*`,
`@ggui-cloud/*`), and no hosted-bridge client. That negative
space is the contract.

The hosted E2E harness still lives at
[`@ggui-private/e2e`](../). It runs everything except the
`journeys-ggui-oss` project.

## Running

```sh
# Full OSS journey suite (default Playwright project =
# `journeys-ggui-oss`, so no `--project` flag needed)
pnpm --filter @ggui-private/e2e-oss test

# MCP fixture contract tests (vitest, Lane 3 per stateful-MCP
# strategy §4.3)
pnpm --filter @ggui-private/e2e-oss test:mcp-fixtures

# Typecheck
pnpm --filter @ggui-private/e2e-oss typecheck
```

The `make test-journeys-ggui-oss` target at the repo root calls
through to this package — unchanged name, new filter underneath.

## Layout

```
e2e/oss/
├── package.json          — @ggui-private/e2e-oss
├── playwright.config.ts  — single project `journeys-ggui-oss`
├── vitest.config.ts      — Lane 3 fixture contract tests
├── tsconfig.json         — extends ../../tsconfig.base.json
└── tests/
    ├── pair-flow.spec.ts
    ├── manifest-capabilities.spec.ts
    ├── npx-bootstrap.spec.ts
    ├── tarball-smoke.spec.ts
    ├── chat-page.spec.ts
    ├── provisional-preview.spec.ts
    ├── live-generation.spec.ts
    ├── ggui-serve-harness.ts
    ├── tarball-install-harness.ts
    └── fixtures/
        ├── manifest-capabilities/  — ggui.json + blueprint fixture
        └── mcps/                   — stateful MCP fixtures (tasks/...)
```

## What's NOT here (and why)

- `fixtures/amplify.ts`, `fixtures/auth.ts`, `fixtures/mcp.ts` —
  hosted sandbox fixtures, not needed here.
- `global-setup.ts` / `global-teardown.ts` — hosted's shared Docker
  UI-generator container; OSS specs spawn `ggui serve` directly per
  test.

## Relationship to the hosted package

| Concern                          | Home                                       |
| -------------------------------- | ------------------------------------------ |
| Phase 5 OSS journey              | **This package** (`@ggui-private/e2e-oss`) |
| Phase 6 hosted journeys          | `@ggui-private/e2e` at `../`               |
| Contract tests (mcp/render/auth) | `@ggui-private/e2e`                        |
| Ops + quality projects           | `@ggui-private/e2e`                        |
| Docker UI-generator suite        | `@ggui-private/e2e`                        |
| MCP fixture contract tests       | **This package** (Lane 3 vitest)           |
