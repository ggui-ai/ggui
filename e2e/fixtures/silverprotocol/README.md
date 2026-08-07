# silverprotocol corpus fixtures (pinned)

Pinned consumption of the [silverprotocol/typescript-sdk](https://github.com/silverprotocol/typescript-sdk)
cassette corpus: **real captured agent-framework wire** (Claude Agent SDK / ADK / OpenAI streams) with a
ggui render riding through it — cache-marker in `structuredContent`, `_meta.ui.resourceUri`, streaming
partials. Recorded once upstream with real keys; replayed here forever, keyless and deterministic.

`fetch-fixtures.mjs` downloads the repo tarball at the SHA in `fixtures.lock.json`, extracts only the
locked legs into the gitignored `.cache/`, and verifies a content checksum. `--verify-only` never touches
the network. A valid cache is a no-network no-op.

**Refresh ritual:** edit `fixtures.lock.json` (new commit SHA) in a reviewed PR, run
`node fetch-fixtures.mjs --update-lock`, and commit the rewritten lock. Never refresh silently; never
hand-edit a cassette (upstream's capture ritual is the only source).

**Assertion contract** — `FIXTURES.md` in the pinned tree, quoted:

> - **Stable** (safe to assert on): event _types_ and their ordering, tool names, scenario intent (which
>   tools get called, roughly how many turns), the structural shape of the folded `reduce()` result.
> - **Incidental** (never assert on): model prose, message/tool-call/response ids, token counts and usage
>   numbers, timestamps, per-run metadata.

**Banned seed:** `corpus/app-spec/` is STALE at this pin (`capturedAt: null`, sdk 0.2.141 vs current
0.3.221, golden truncated at `turn.abort`) — do not add it to the lock. The four locked legs are the
live captures. Design: `docs/superpowers/specs/2026-08-07-cassette-contract-tier-design.md`.
