# `@ggui-ai/e2e-journeys`

End-to-end Playwright journeys for the **`ggui` OSS** product boundary
— a developer runs `npx ggui serve` on their own machine, with their own
LLM key, and nothing calls `api.ggui.ai` at any step. Every spec here
tests that surface.

> **Rename note (2026-05-24):** package renamed `@ggui-ai/e2e` →
> `@ggui-ai/e2e-journeys` so its name mirrors the directory's stable
> axis (journeys). The bare `@ggui-ai/e2e` name had become an axis-blind
> catch-all. Tracked in commit `d57231a02`.

## Axis — OSS product journey

This dir's organizing axis is **the OSS product boundary as journeys**:
one spec per end-to-end flow a self-hoster (or `npx`-driven trier) would
take. The OSS claim is enforced by the dep graph — no `aws-amplify`,
no `@aws-sdk/*`, no `@ggui-cloud/*`, no `@ggui-private/*` in the
`dependencies` or `devDependencies` of `package.json`. That negative
space is the contract; see
[OSS Purity](../../../docs/principles/oss-purity.md).

The hosted-product Playwright journeys live next door under
`cloud/e2e/tests/journeys/ggui/` (owned by `@ggui-private/e2e`).

## Hybrid runner — known axis violation

This package currently runs **two runners under one `package.json`**:

- **Playwright** (`*.spec.ts`) — the primary journey lane (24 specs).
- **vitest** — a single residue test `tarball-transitive-packages.test.ts`
  plus the `fixtures/mcps/**/*.test.ts` lane (Lane-3 stateful-MCP
  contract tests).

Per
[Test Placement § Mixing runners under one `package.json`](../../../docs/principles/test-placement.md#mixing-runners-under-one-packagejson),
this is an anti-pattern. The **full split is deferred** because the
vitest residue co-imports `tarball-install-harness.ts` with the
Playwright specs — splitting today would either duplicate the harness or
introduce a circular workspace dep. Tracked in commit `d57231a02`. The
rename above was the rename-only half of the work; the structural split
follows when the harness is refactored.

Until then: invoke each runner with its dedicated script (`test` for
Playwright, `test:mcp-fixtures` for vitest) — `pnpm test` does NOT pick
up the vitest residue.

## Where does a new test go?

1. **OSS journey (self-hoster running `ggui serve`)?** → append a new
   `<slug>.spec.ts` under `tests/`.
2. **Stateful MCP fixture (Lane 3 contract test)?** → under
   `tests/fixtures/mcps/<name>/<name>.test.ts` (the vitest residue).
3. **Hosted product journey (UI tied to api.ggui.ai)?** → not here. Use
   `cloud/e2e/tests/journeys/ggui/` with `@ggui-private/e2e`.
4. **Cross-host MCP wire scenario (numeric ordinal)?** → not here. Use
   [`oss/e2e/wire-scenarios/`](../wire-scenarios/README.md).

If unsure, walk the
[where-does-it-go decision tree](../../../docs/principles/test-placement.md#the-where-does-it-go-decision-tree).

## Running

```sh
# Full OSS journey suite (Playwright, project: journeys-ggui-oss)
pnpm --filter @ggui-ai/e2e-journeys test

# MCP fixture contract tests (vitest residue, Lane 3)
pnpm --filter @ggui-ai/e2e-journeys test:mcp-fixtures

# Typecheck
pnpm --filter @ggui-ai/e2e-journeys typecheck
```

`make test-journeys-ggui-oss` at the repo root calls through to this
package (target name unchanged for muscle-memory).

## Layout

```
oss/e2e/journeys/
├── package.json          — @ggui-ai/e2e-journeys
├── playwright.config.ts  — single project `journeys-ggui-oss`
├── vitest.config.ts      — Lane 3 MCP fixture contract tests
└── tests/
    ├── *.spec.ts                       — Playwright journeys (24)
    ├── tarball-transitive-packages.test.ts  — vitest residue (1)
    ├── ggui-serve-harness.ts           — shared boot helper
    ├── tarball-install-harness.ts      — shared install helper
    └── fixtures/
        ├── contract-kit/   — MCP Apps host fixtures
        └── mcps/           — stateful MCP fixtures (tasks/contacts/notes)
```

## What's NOT here (and why)

- Hosted sandbox fixtures (`amplify.ts`, `auth.ts`, `mcp.ts`) — those
  pull in `aws-amplify`; they live in `@ggui-private/e2e` (closed).
- The Tier-2 MCP host simulator — lives in
  [`oss/e2e/mcp-host-simulator/`](../mcp-host-simulator/README.md)
  as `@ggui-ai/e2e-mcp-host-simulator`.
- The clean-room consumer publish gate — lives in
  [`oss/e2e/clean-room-consumer/`](../clean-room-consumer/README.md).
