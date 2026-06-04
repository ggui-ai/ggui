# OSS E2E Lane Taxonomy

> **Scope.** This doc is the canonical mapping between every spec in
> `e2e/ggui-oss/tests/` and the 4-lane OSS gating taxonomy locked in
> [`docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md`](../../docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md)
> §4. It is **orthogonal to** `e2e/TAXONOMY.md` (the four structural
> buckets: journey / contract / ops / quality) — that doc says
> _where_ a spec lives in the tree; this one says _when it runs_ and
> _what happens on failure_.

## The four lanes (one-line summary)

| Lane                          | What                                                                                  | Key gate                                            | Runtime budget                | LLM?                                               | Status on failure                                    |
| ----------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| **Lane 1** — OSS-core E2E     | Playwright specs that boot `ggui serve` and prove product claims without any LLM call | Blocking every PR                                   | <60s per spec                 | No                                                 | PR fails                                             |
| **Lane 2** — OSS-live-gen E2E | Playwright specs that call a real LLM to exercise generation                          | **Subset blocking**, rest advisory/nightly          | ~60s blocking, ~3min advisory | Yes (BYOK)                                         | Blocking subset fails PR; advisory rest reports only |
| **Lane 3** — OSS-contract     | Vitest at package level; no browser, no full-server boot                              | Blocking every PR                                   | <30s per package              | No (blocking); optional integration smoke with key | PR fails                                             |
| **Lane 4** — OSS-perf         | Latency measurement + threshold/trend gates                                           | Threshold violation blocks; trend drift is advisory | Nightly (~5min)               | Provider-dependent                                 | Threshold: PR fails. Trend: humans decide.           |

Full lane semantics (artifacts-on-fail, assertion shape, retry policy, blocking rationale) live in the strategy doc §4.1–4.4.

## Lane 2 scenario lock (canonical 4 blocking + advisory rest)

Strategy doc §4.2 locks the blocking LLM subset to **four** scenarios. Memory had previously recorded "5-scenario blocking subset" — that was incorrect; this doc supersedes it.

| Scenario                                            | Strategy name | Spec                                       | Status                                                         |
| --------------------------------------------------- | ------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Tasks happy path (render → UI from Tasks MCP)       | **T1**        | `tasks-backed-generation.spec.ts`          | ✅ Shipped                                                     |
| Notes happy path (render → UI from Notes MCP)       | **N1**        | `notes-backed-generation.spec.ts`          | ✅ Shipped (advisory-gated; blocking flip is CI config change) |
| Contacts happy path (render → UI from Contacts MCP) | **C1**        | `contacts-backed-generation.spec.ts`       | ✅ Shipped (advisory-gated; blocking flip is CI config change) |
| Tasks + Contacts composition (assignee ↔ task)      | **P1**        | `tasks-contacts-backed-generation.spec.ts` | ✅ Shipped                                                     |

### Additional Lane 2 specs beyond the strategy's blocking four

Two Lane 2 specs ship today that aren't in the blocking-four lock. They cover orthogonal user-stories (Q2, Q3 per strategy §5) and run advisory today:

| Spec                      | User-story                                          | Lane 2 sub-shape                                            |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `chat-generation.spec.ts` | Q2 — chat on dev page (ChatShell-with-UI, Slice 8b) | Blocking on presence of `ANTHROPIC_API_KEY`; skip otherwise |
| `live-generation.spec.ts` | Q3 — weather / generic render (Slice 4 follow-on)   | Blocking on presence of key; skip otherwise                 |

### Advisory / nightly scope (not blocking, not shipped as standalone)

Per strategy §4.2, the following expand Lane 2 in the advisory / nightly lane but are not blocking subsets:

- **P2–P5**: further 2-MCP compositions beyond Tasks+Contacts (e.g., Tasks+Notes, Contacts+Notes).
- **X1–X4**: all 3-MCP compositions.
- **Multi-turn cache extension** (>2 turns): covered by unit tests today; not a standalone Lane 2 spec.

## Gating discipline (all Lane 2 specs)

Every Lane 2 spec follows the **advisory-skip envelope** pattern via the canonical `shouldSkipLane2Advisory({specLabel?})` helper in `ggui-serve-harness.ts`. All six Lane 2 specs call the helper (the former duplicated inline pattern was factored out 2026-04-24).

1. `@ggui-ai/cli` dist missing → **skip** with build hint.
2. `@ggui-ai/console` dist missing → **skip** with build hint.
3. `GGUI_OSS_LIVE_BYOK=0` → **skip** (explicit operator opt-out).
4. `ANTHROPIC_API_KEY` unset or empty → **skip** (clean CI without secrets).
5. Otherwise → run with `test.setTimeout(TEST_TIMEOUT_MS)`, attach perf recorder + network gate, assert `structuredContent.cache` / browser DOM per spec contract.

CI policy today: Lane 2 runs when `ANTHROPIC_API_KEY` is present in the environment. No key → all six specs skip cleanly. This is the correct posture — the lane's purpose is validating LLM-backed generation paths, not arguing with operators about secret availability.

## Assertion shape — all Lane 2 specs

Per strategy §4.2 + CLAUDE.md "Testing LLM-Generated UI":

- **Semantic** DOM match, not strict selectors. Use `evaluateRendering()` / `discoverFormElements()` helpers when available, or assert structural invariants (`data-ggui-code-ready="true"` handoff, `ggui-rcr-*` scope mount, non-empty child count).
- **Blueprint-class match**: assert the generator picked `form` vs `list` vs `detail` — not exact markup.
- **Cache marker match**: assert the structured `cache.hit` / `cache.llmCallsAvoided` fields — not latency alone.
- **`retries: 1` allowed** for LLM nondeterminism.

## Lane 1 inventory (reference)

Specs that MUST pass every PR with no LLM call. Every one of these boots `ggui serve` in a clean-room subprocess and asserts a product claim end-to-end:

`blueprint-viewer` · `blueprints-page` · `chat-page` · `config-page` · `contacts-mount-via-serve` · `create-ggui-server` · `manifest-capabilities` · `mcp-app-iframe` · `mcp-inspector` · `notes-mount-via-serve` · `npx-bootstrap` · `pair-flow` · `provisional-preview` · `render-inspector` · `renders-page` · `revoke-flow` · `runtime-contract` · `sqlite-storage` · `tarball-smoke` · `tasks-contacts-compose-via-serve` · `tasks-mount-via-serve`

Several Lane 1 specs reference `ANTHROPIC_API_KEY` for _describe-block-internal_ Lane 2 sub-cases but keep their default blocking assertions free of any LLM call (e.g., `npx-bootstrap` + `render-inspector` run Lane 1 by default; their gated sub-blocks are Lane 2 advisory). Mixed-lane files are acceptable when the gating is clean; the surface-level lane assignment is driven by the default (un-gated) tests.

## Lane 3 inventory (reference, abbreviated)

Pure vitest tests under `packages/*/src/**/*.test.ts`. Strategy-owned blocking contracts:

- Provider adapters (Anthropic / Google / OpenAI / OpenRouter HTTP contracts)
- Negotiator decision logic (incl. `cache-backed-negotiator.test.ts` + `handshake-cache-integration.test.ts`)
- Vector store contract tests
- Blueprint registry API (Slice 9 admin route)
- Schema + tool-declaration lint
- Failure-mode contracts (no-key / bad-key / generation-invalid / rate-limited)

Also Lane 3: `packages/mcp-server-handlers/src/renders/*.test.ts` — all handler contract tests.

## Lane 4 inventory (reference)

Latency / benchmark specs. Thresholds defined inline per spec via `perf-recorder.ts::recordBlocking()` calls:

- `tasks-backed-generation.spec.ts` + `live-generation.spec.ts` — real-LLM turn floor (>1s catches stub regressions)

No dedicated nightly perf suite exists today. When one lands it belongs under a separate Playwright project (e.g., `perf-ggui-oss`) so threshold / trend gates don't pollute the blocking run.

## Gaps surfaced by this taxonomy lock

1. ~~**N1 + C1 Lane 2 specs are missing**~~ — **closed 2026-04-24** by shipping `notes-backed-generation.spec.ts` + `contacts-backed-generation.spec.ts`. Both use the canonical `spawnGguiServeInCwd` pattern against the existing Slice 6.2 / 6.3 mount-via-serve fixtures — real `ggui serve` CLI binary, no dedicated launchers. All seven Lane 2 specs now ship; the strategy's blocking four is structurally complete in the advisory lane.
2. ~~**`shouldSkipAdvisory()` helper is duplicated inline**~~ — **closed 2026-04-24** by factoring into `ggui-serve-harness.ts::shouldSkipLane2Advisory({specLabel?})`. All seven Lane 2 specs now call the canonical helper; the 4-check precondition order (CLI dist → console dist → opt-out → BYOK key) is frozen in one place. New Lane 2 scenarios added by any future contributor inherit the exact same gating semantics by default.
3. **No nightly Playwright project for Lane 4** — today perf assertions inline in Lane 2 specs. When Lane 2 scenario count grows, a separate project makes the threshold / trend shape explicit. (Unchanged.)
4. **Blocking flip pending** — the strategy doc §4.2 locks T1/N1/C1/P1 into the blocking-four subset, but all four ship advisory today (skip on absent `ANTHROPIC_API_KEY`). Flipping to blocking is a CI config change: provision a BYOK key for CI + remove the absent-key skip path. Shape-wise no test changes required.

None are launch-blocking. Lane 2 now has coverage of all four strategy-locked blocking scenarios (T1/N1/C1/P1) plus three orthogonal user-story specs (Q2/Q3/Q5 = chat/live/cache). The remaining items are CI-policy + developer-ergonomics polish.

## References

- Lane discipline source of truth: [`docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md`](../../docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md) §3.3 (Q1–Q7), §4.1–4.4 (lane definitions), §5 (user-story → lane table)
- Bucket taxonomy (journey / contract / ops / quality): [`e2e/TAXONOMY.md`](../TAXONOMY.md)
- OSS split plan: [`docs/plans/2026-04-21-oss-split-e2e-phases.md`](../../docs/plans/2026-04-21-oss-split-e2e-phases.md)
- 18-slice port plan + status: [`docs/plans/2026-04-21-oss-full-generation-port.md`](../../docs/plans/2026-04-21-oss-full-generation-port.md)
- CLAUDE.md "Testing LLM-Generated UI": [`../../CLAUDE.md`](../../CLAUDE.md#testing-llm-generated-ui)
