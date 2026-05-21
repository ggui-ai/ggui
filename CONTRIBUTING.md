# Contributing to ggui

Thanks for your interest in contributing!

## Setup

```bash
git clone https://github.com/ggui-ai/ggui.git
cd ggui
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

## Questions?

Open a [Discussion](https://github.com/ggui-ai/ggui/discussions) or [Issue](https://github.com/ggui-ai/ggui/issues).
