# OSS E2E Lane Taxonomy

> **Scope.** Canonical mapping between every spec in this package and the
> 4-lane OSS gating taxonomy locked in
> [`docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md`](../../docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md)
> §4. It is **orthogonal to** `e2e/TAXONOMY.md` (the four structural
> buckets: journey / contract / ops / quality) — that doc says
> _where_ a spec lives in the tree; this one says _when it runs_ and
> _what happens on failure_.
>
> **Rewritten 2026-07-26 (e2e re-architecture Phase 3)** to match the
> tree: commit `bd6115ccf` (2026-06-06) deleted every Lane-2 live-LLM
> spec together with the `/s/<shortCode>` session viewer, which left this
> doc describing a lane that no longer existed. The suite is **keyless
> today** — that is what qualified it for the per-PR keyless tier
> (`ci.yml` job `oss-journeys`).

## The four lanes (one-line summary)

| Lane                          | What                                                                                  | Key gate          | Status today                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| **Lane 1** — OSS-core E2E     | Playwright specs that boot `ggui serve` and prove product claims without any LLM call | Blocking (per-PR) | **The whole suite** — 14 specs, keyless                                                                       |
| **Lane 2** — OSS-live-gen E2E | Playwright specs that call a real LLM to exercise generation                          | —                 | **Empty since `bd6115ccf`** — see "Where live-gen coverage lives now" below                                   |
| **Lane 3** — OSS-contract     | Vitest at package level; no browser, no full-server boot                              | Blocking (per-PR) | MCP fixture contract tests (`fixtures/mcps/**`) + `tarball-transitive-packages` — run via `test:mcp-fixtures` |
| **Lane 4** — OSS-perf         | Latency measurement + threshold/trend gates                                           | —                 | No dedicated suite; perf gates live in `oss/misc/benchmark` + T5 (cloud)                                      |

Full lane semantics (artifacts-on-fail, assertion shape, retry policy,
blocking rationale) live in the strategy doc §4.1–4.4.

## Lane 1 inventory (the suite, complete)

Every spec boots `ggui serve` (or the built CLI/console dists) in a
clean-room subprocess and asserts a product claim end-to-end, with zero
LLM calls and zero `api.ggui.ai` traffic — the executable proof of the
OSS "runs entirely on your machine" claim:

`blueprint-viewer` · `blueprints-page` · `config-page` ·
`contacts-mount-via-serve` · `mcp-inspector` · `notes-mount-via-serve` ·
`npx-bootstrap` · `pair-flow` · `renders-page` · `revoke-flow` ·
`sqlite-storage` · `tarball-smoke` · `tasks-contacts-compose-via-serve` ·
`tasks-mount-via-serve`

Prerequisites: built `@ggui-ai/cli` + `@ggui-ai/console` dists (specs
self-skip per-spec when missing — CI builds the closure first so the lane
can never go hollow that way), Chromium, network to npmjs only for the
tarball specs' 404 guard.

## Lane 3 inventory (this package's share)

`fixtures/mcps/{tasks,contacts,notes}/*.test.ts` (Lane-3 MCP fixture
contract tests) + `tests/tarball-transitive-packages.test.ts` — vitest,
run via `pnpm --filter @ggui-ai/e2e-journeys run test:mcp-fixtures`
(`make test-mcp-fixtures`). The plain `pnpm test` (Playwright) does NOT
pick these up; CI runs both runners explicitly.

## Where live-gen coverage lives now

The deleted Lane-2 specs' concern — real-LLM generation through the full
product — did not vanish; it moved to purpose-built suites:

- **`oss/e2e/wire-scenarios/`** (per-PR + nightly `oss-e2e-matrix.yml`) —
  provider-matrix live generation at the wire-contract level.
- **`oss/e2e/samples-render/`** (nightly `samples-render.yml`) — full
  agent-loop browser journeys against the composed samples app, all three
  agent SDKs, real LLM.

A future Lane-2 revival inside this package should resurrect the
`shouldSkipLane2Advisory` gating pattern from git history (`bd6115ccf^`)
rather than reinventing it.

## References

- Lane discipline source of truth: [`docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md`](../../docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md) §3.3 (Q1–Q7), §4.1–4.4 (lane definitions), §5 (user-story → lane table)
- Bucket taxonomy (journey / contract / ops / quality): [`e2e/TAXONOMY.md`](../TAXONOMY.md)
- Evidence tiers (what a green proves): [`docs/testing.md`](../../../docs/testing.md)
- CLAUDE.md "Testing LLM-Generated UI": [`../../../CLAUDE.md`](../../../CLAUDE.md#testing-llm-generated-ui)
