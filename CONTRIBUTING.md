# Contributing to ggui

Thanks for your interest in contributing!

## Prerequisites

- **Node.js** `>= 20.0.0` (LTS recommended; CI uses 22)
- **pnpm** `9.x` — the repo pins via the `packageManager` field. Run `corepack enable` once and pnpm will use the right version automatically.
- A **C/C++ toolchain** for `better-sqlite3`'s native build. On Debian/Ubuntu: `sudo apt install build-essential python3`; on macOS: `xcode-select --install`.

## Setup

```bash
git clone https://github.com/ggui-ai/ggui.git
cd ggui
corepack enable                 # selects the pinned pnpm version
pnpm install
pnpm build
```

## Development

```bash
pnpm build        # Build all packages
pnpm typecheck    # Type check all packages
pnpm test         # Run all tests
```

## Making Changes

1. Create a branch: `git checkout -b my-feature`
2. Make your changes
3. Add a changeset: `pnpm changeset`
4. Commit and push
5. Open a Pull Request

## Changesets

We use [changesets](https://github.com/changesets/changesets) for versioning. When you make a change that should be released, run:

```bash
pnpm changeset
```

This creates a file describing your change. Commit it with your PR.

## Package Structure

Each subdirectory is a workspace package. The consumer-facing surface:

| Package             | Published name          | Description                        |
| ------------------- | ----------------------- | ---------------------------------- |
| `protocol`          | `@ggui-ai/protocol`     | Wire protocol types                |
| `ggui-cli`          | `@ggui-ai/cli`          | The `ggui` binary                  |
| `mcp-server`        | `@ggui-ai/mcp-server`   | Reference OSS server               |
| `ggui-react`        | `@ggui-ai/react`        | React embedding components         |
| `ggui-react-native` | `@ggui-ai/react-native` | React Native embedding components  |
| `gadgets`           | `@ggui-ai/gadgets`      | Author wrappers for 3rd-party libs |
| `ui-gen`            | `@ggui-ai/ui-gen`       | UI-generation harness              |

The remaining directories are supporting runtime, registry, and tooling
packages. See each subdirectory's `package.json` for the full picture.

## Code Style

- TypeScript strict mode
- ESLint + Prettier (run automatically on commit)
- Prefer small, focused PRs

### Claims about browser behaviour

A comment or docstring that says how a browser behaves ships with the package as fact. It is costly to test, so it
rarely is, and a reader of the source has no way to challenge it. When you write one:

1. **Prefer a runtime feature test to a version claim.** `@supports (color: color-mix(in srgb, red, blue))` can't go
   stale, but "Safari < 16.2" can. Where a feature test exists, the version sentence is a note, not a dependency
   (`packages/design/src/rendering/css-tokens.ts` is the pattern).
2. **A claim with no feature test carries its bound and its date:** what was observed, in which browser at which
   version, and when (`packages/protocol/src/integrations/mcp-apps.ts`, the `background` option's receipt).
3. **Point at the observation; don't restate the conclusion.** When the claim is needed in another package, link the
   measurement (a test, a commit, an issue) rather than copying the sentence. The copy is where a dated observation
   turns into a timeless fact.
4. **Say what would retire it.** If nobody can re-check what triggers a workaround, nobody can ever remove it.

When reviewing a claim like this that justifies a default, ask what would falsify it and where that was last checked.

## Questions?

Open a [Discussion](https://github.com/ggui-ai/ggui/discussions) or [Issue](https://github.com/ggui-ai/ggui/issues).
