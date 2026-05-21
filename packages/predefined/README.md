# @ggui-ai/predefined

ggui's official reference design package — primitives, components, composites, and blueprints the UI generator consults on its predefined-match path. Ships pure data + reference React TSX, no JavaScript entry point, no runtime imports.

## What this package is for

When the UI generator receives a request, it first checks whether the user is asking for something the ggui registry already knows how to render — a login form, a kanban board, a settings page. If a predefined component matches, the generator skips full generation and emits an import that points the runtime at the corresponding TSX in this package.

Two things must stay aligned for that pipeline to work:

1. Every component declares **what it is** in `spec.json` — name, level, prop interface, the prompts it should match, the design tokens it uses.
2. Every component ships **how it looks** in `component.tsx` — a single React default export with the same name as `spec.json#name`.

The ggui generation runtime loads this package at runtime and resolves it by package path (`@ggui-ai/predefined/package.json`). It carries no build step and exports nothing executable — consumers read the files directly.

## Layout

```
packages/predefined/
├── blueprints/   ← page-level layouts (Dashboard, ListDetail, KanbanBoard, …)
├── composites/   ← multi-component compositions (LoginForm, PricingCards, …)
├── components/   ← single-purpose components (FormField, SearchField)
├── schema/
│   └── component-spec.schema.json   ← JSON Schema for spec.json files
├── tokens/
│   └── base.tokens.json             ← W3C DTCG design tokens
└── tests/
    └── validate.test.ts             ← integrity gate (run via `pnpm test`)
```

The four component levels (in increasing order of complexity) are: `primitive` → `component` → `composite` → `blueprint`. Primitives don't live here — they ship from `@ggui-ai/design/primitives`. This package starts at `component`.

## Adding a new component

1. Pick the right level subdirectory.
2. Create a slug-kebab-case directory under it (e.g. `composites/notification-toast/`).
3. Write `component.tsx` with a single `export default function NotificationToast(...)` matching the directory.
4. Write `spec.json` declaring the component (see schema below).
5. Run `pnpm --filter @ggui-ai/predefined test` — the integrity tests fail loudly on any drift.

## `spec.json` contract

The full schema is in `schema/component-spec.schema.json`. Required fields:

| Field         | Purpose                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | PascalCase identifier — **must** match the `export default` name in `component.tsx`. The runtime registry uses this to mint import paths for LLM-generated code.         |
| `level`       | One of `primitive` \| `component` \| `composite` \| `blueprint`. Determines the import root (`@ggui-ai/design/primitives` for primitives, `@predefined/{level}s` else).  |
| `category`    | A grouping within the level (`forms`, `navigation`, `feedback`, `data-display`, …). Free-form.                                                                           |
| `description` | One sentence describing what the component does.                                                                                                                         |
| `visual`      | `{ description, layout, tokens[] }` — visual hints the LLM consults during generation; every token path must resolve in `tokens/base.tokens.json`.                       |
| `interface`   | `{ props[], callbacks[], slots[] }` — props use the type enum `string \| number \| boolean \| function \| object \| array`; richer types go in the prop's `description`. |
| `examples`    | An array of `{ prompt, match }` pairs — example user phrases the registry's matcher should resolve to this component, with confidence scores.                            |

Optional:

- `id` — stable slug for the blueprint ID. If omitted, the ID is derived from `name`; renaming `name` rotates the ID and invalidates any agent-side caches keyed off the old value. Set `id` for stability.
- `tags` — search hints for the registry.
- `dependencies` — names of other predefined components this one composes with. Validated against the on-disk set.
- `stream` — `ggui_emit` data spec describing what real-time events the component accepts.

## Design tokens

`tokens/base.tokens.json` follows the [W3C DTCG format](https://design-tokens.github.io/community-group/format/) — every leaf node carries a `$value` and the parent group carries a `$type`. Token paths in `spec.json#visual.tokens` are dot-separated and refer to the leaf, e.g. `color.primary.600` or `spacing.4`.

When you reference a token in `spec.json`, the integrity tests assert the path resolves to a `$value` leaf. Inventing a path that doesn't exist is a build break.

## Integrity tests

`pnpm --filter @ggui-ai/predefined test` runs `tests/validate.test.ts`, which enforces six invariants for every component on disk:

1. `spec.json` validates against `schema/component-spec.schema.json` (via ajv).
2. `spec.json#name` equals the `export default` name in `component.tsx`.
3. Every `visual.tokens` path resolves to a `$value` leaf in `tokens/base.tokens.json`.
4. Every `dependencies[]` entry exists as another component on disk.
5. `component.tsx` compiles cleanly with esbuild (TSX → ESM).
6. `component.tsx` only imports from the runtime allow-list: `react`, `@ggui-ai/design/primitives`, `@predefined/*`. The runtime hoists predefined imports through `esbuild.transform` (not `build`), so any bare specifier outside this list survives into the browser and fails to resolve — there's no importmap or bundler downstream.

The package's `pnpm test` is wired into the workspace's `make test-unit`, so these tests gate every CI run alongside the rest of the unit suite.

## Versioning + publish

`@ggui-ai/predefined` is part of the open `@ggui-ai/*` npm scope and projects to `github.com/ggui-ai/ggui` via the OSS subtree split. It carries no JS entry point and no runtime API surface, so its semver risk surface is the data shapes, not types or functions:

- **Patch** — fix a typo, replace a token path, retune a match score, fix a broken `${1}Blueprint`.
- **Minor** — add a new component, add a new optional field to `spec.json` (and update `schema/`).
- **Major** — remove or rename a component, remove a required `spec.json` field, change a token path that downstream specs reference.

Don't rename a component without bumping. Agents can cache blueprint IDs derived from `name`; if the ID rotates, their cached references go cold.
