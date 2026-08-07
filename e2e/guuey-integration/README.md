# @ggui-ai/e2e-guuey-integration

Standing, keyless interop proof for the ggui × guuey render channel
(ggui#429): ggui's card surfaces consumed through guuey's **published**
SDK — `@guuey/threads` + `@guuey/agent-client` at **exact** pins — with
zero hosted infrastructure.

## The matrix

1. **Live mount** — a real `createGguiServer` on an ephemeral port,
   driven over the real MCP Streamable-HTTP wire; the `ggui_render`
   result folds through the real `@silverprotocol/core` `Reducer`
   (whose `_meta` carriage is what makes ggui cards mountable) into
   guuey's `toolResultCardMount`. The mounted shell's inlined
   `__GGUI_META__` envelope must equal — verbatim — what ggui's own
   protocol host-helper (`toolResultGguiRender`, ggui#427) narrows from
   the same wire result: the two products' render channel cannot drift.
2. **Persist → rehydrate** — the same fold through guuey's extracted
   `ThreadStore` (`InMemoryThreadPersistence`) and back out via the card
   projection; an inline mcp-ui resource must mount identically live
   and rehydrated.
3. **provider-raw channel** — a `ui://` resource degraded into a
   `provider-raw` content part mounts on both arms.
4. **ggui-channel snapshot honesty** — pins the current deliberate
   behavior: persisted ggui bootstraps are not remountable (a stored
   `wsToken` is expired by construction), so the card projection
   persists nothing for them. The re-mint design (persist the locator,
   re-fetch via `resources/read`) is tracked on ggui#429.

## Pinning policy

`@guuey/*` versions are exact, not ranges: the suite tests ggui HEAD
(`workspace:*`) against the versions guuey actually shipped. Bumping the
pin is a deliberate act that re-runs the matrix against the new
contract. The pins are dev-side test harness only — no published
`@ggui-ai/*` package depends on anything above MCP.

## Running

```bash
pnpm --filter @ggui-ai/e2e-guuey-integration test
```

Keyless, in-process, no browser, no network beyond `127.0.0.1` — runs
anywhere `pnpm install` does (build the workspace packages first:
`pnpm exec turbo build --filter='./oss/packages/*'` from the monorepo,
or the equivalent in the standalone checkout).
