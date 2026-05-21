# contract-kit

Protocol-conformance fixture catalog for the `<McpAppIframe>` + renderer bundle surface.

**This directory is the authoring surface of the Phase 3.1 conformance kit.** The JSON cases under `./cases/` and the TypeScript loader + types in this directory get **repackaged verbatim** into `@ggui-ai/protocol-conformance` when Phase 3.1 ships. Any change here is a breaking change to a published npm surface — treat the on-disk format the way you'd treat a `@ggui-ai/protocol` type declaration: additive, extensibly-closed, backwards-compatible.

> Plan pointer: `docs/plans/2026-04-23-slice-11.5-bar-revised.md#C10-—-Playwright-E2E-+-fixture-kit-seed-(Phase-3.1-format)` and `docs/plans/2026-04-23-protocol-bar-phase-3.md#Phase-3.1-—-Protocol-conformance-test-kit`.

---

## Layout

```
contract-kit/
├── README.md         — this file
├── types.ts          — TestCase + ExpectedBehavior + Setup/Teardown step unions
├── loader.ts         — loadFixture(name), listFixtures(), loadAllFixtures()
├── index.ts          — public entry
└── cases/
    ├── <fixture-name>.json
    └── …
```

Each fixture is one JSON file. The filename (minus `.json`) MUST equal the `name` field inside the JSON — the loader rejects mismatches.

## Fixture JSON shape

```jsonc
{
  "name": "wired-action-tool-not-found",
  "description": "…",
  "skipReason": null,

  "setup": [
    { "type": "create-session", "sessionId": "test-s1" },
    { "type": "register-tool", "toolName": "known-tool", "handler": "echo" },
  ],

  "inputEnvelope": {
    "type": "action",
    "channel": 0,
    "sessionId": "test-s1",
    "action": { "name": "does-not-exist", "data": {} },
  },

  "expectedBehavior": {
    "kind": "contract-error",
    "code": "TOOL_NOT_FOUND",
    "toolName": "does-not-exist",
    "observability": { "kind": "contract-error-emitted" },
  },

  "teardown": [{ "type": "close-session", "sessionId": "test-s1" }],
}
```

## Fields

| Field                   | Required | Meaning                                                                                                  |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `name`                  | yes      | Matches the filename (minus `.json`). Reporter identifier.                                               |
| `description`           | yes      | Human-readable intent — surfaces in reporter output.                                                     |
| `skipReason`            | yes      | `null` to run; a string to skip. Authored skips should explain WHY + POINT at the enabling work.         |
| `setup`                 | yes      | Array of directives the host interprets BEFORE `inputEnvelope`. May be `[]`.                             |
| `inputEnvelope`         | yes      | Opaque envelope the runner feeds to the host. Shape depends on transport.                                |
| `expectedBehavior`      | yes      | Discriminated union (`kind`). What the runner asserts post-dispatch.                                     |
| `expectedObservability` | no       | Independent observability-event assertions. Omit when `expectedBehavior.observability` is authoritative. |
| `teardown`              | yes      | Array of cleanup directives. May be `[]`.                                                                |

## Discriminators — extensibly closed

Every discriminator that could reasonably gain new members without a wire-version bump carries a `(string & {})` tail (see `types.ts`):

- `SetupStep['type']` — `'create-session' | 'register-tool' | 'emit-envelope' | 'seed-channel' | (string & {})`
- `TeardownStep['type']` — `'close-session' | 'unregister-tool' | (string & {})`
- `ExpectedBehavior['kind']` — `'contract-error' | 'stream-update' | 'observability-event' | 'bootstrap-failure' | 'bootstrap-success' | 'version-mismatch' | 'props-update' | 'no-op' | (string & {})`
- `ExpectedObservabilityEvent['kind']` — renderer's `ObservabilityEvent['kind']` set + `(string & {})`

Third-party conformance hosts MAY extend each vocabulary. Runners MUST skip unknown variants with a warning rather than failing loudly.

## Loader contract

```ts
import { loadFixture, listFixtures, loadAllFixtures } from "./index.js";

const names: readonly string[] = listFixtures(); // ['bootstrap-meta-missing', 'bootstrap-success', …]
const one = loadFixture("wired-action-success"); // TestCase
const all = loadAllFixtures(); // readonly TestCase[]
```

- Malformed JSON → `Error` with a filename-anchored message.
- Missing required field → `Error` identifying the field + fixture name.
- `name` field mismatch with filename → `Error`.
- Unknown `setup.type` / `expectedBehavior.kind` → loaded as-is (the runner owns the skip decision).

Pure — the loader reads from disk every call; no caching. Phase 3.1 may add LRU caching if benchmark data justifies it.

## Where fixtures run today vs tomorrow

Phase 2 (this slice) drives fixtures end-to-end through `ggui serve` + the `playground/` fixture + the existing `contract-probe` / `todo-list` blueprints in the live session viewer. The C10 spec can prove the happy-path `wired-action` dispatch + `TOOL_THREW` + `SCHEMA_VIOLATION` rows today. Fixtures in this catalog whose setup directives exceed what the Phase-2 harness can execute (e.g. arbitrary `register-tool` + `emit-envelope` without corresponding playground primitives) are authored with a non-null `skipReason` explaining the Phase-3.1 dependency.

**Phase 3.1** ships `@ggui-ai/protocol-conformance` — a packaged runner that implements a `ConformanceHost` interface. The `ConformanceHost` is the seam that interprets every `setup` / `teardown` directive against a real transport. When Phase 3.1 lands, authored-with-skip-reason fixtures un-skip.

Every fixture in this catalog — skipped or not — is **loadable today** via `loadFixture(name)` and **shape-valid** per `types.ts`.

## Repackaging boundary

When `@ggui-ai/protocol-conformance` ships:

- `./cases/*.json` moves verbatim into the package.
- `types.ts` becomes the package's `src/types.ts`.
- `loader.ts` becomes the package's `src/loader.ts` (or equivalent).
- `index.ts` becomes the package's main entry.

The Phase 3 plan item 3.1 (§3.1 Deliverable 4) names this directory as the authoring surface specifically so Phase 3.1's port is mechanical, not a rewrite.

**If you edit this directory without understanding the above, read `docs/plans/2026-04-23-protocol-bar-phase-3.md#Phase-3.1`.**
