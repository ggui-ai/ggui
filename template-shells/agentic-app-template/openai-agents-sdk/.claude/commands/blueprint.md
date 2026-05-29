---
description: Scaffold and author a ggui blueprint — a cached, reusable UI pattern
---

Help the developer author a **ggui blueprint**.

## What a blueprint is

A blueprint is a cached UI template for a **recurring UI pattern** — a login
screen, an order summary, a settings page. ggui renders UIs in two stages: a
fast blueprint match, and — only on a miss — a full LLM generation. A blueprint
turns a known screen into the fast path: cheaper, quicker, and visually
consistent every time.

Reach for one when the same kind of screen recurs. One-off UIs don't need a
blueprint — let the generator handle them.

## Steps

### 1. Gather inputs

Ask the developer:
- **Scope** — their npm-style scope, e.g. `@acme`.
- **Name** — kebab-case, e.g. `order-summary`.
- **The pattern** — what screen is this, and what data does it render?

### 2. Scaffold

Create a `blueprints/` directory if absent, then scaffold inside it:

```
ggui blueprint create @<scope>/<name>
```

`ggui` is the `@ggui-ai/cli` binary. If it is not on `PATH`, use
`pnpm --filter ./servers/ggui exec ggui …`.

### 3. Read what was generated

Open the scaffolded files — the `ggui.blueprint.json` manifest, the TSX
component, and the contract stub — and work with their actual shape.

### 4. Author the component

Implement the blueprint as a **single default-exported React component** (TSX).
It must render from props alone — no data fetching inside.

### 5. Fill the manifest

Key fields in `ggui.blueprint.json`:
- `description` + `tags` — how the matcher finds this blueprint. Write them to
  describe *when* the pattern applies.
- `visibility` — `public` or `private`.
- `contract` (optional) — the prop/action shape the matcher keys on.
- `fixtureProps` (optional) — sample props for the conformance probe.
- `variance` (optional) — persona / aesthetic / context hints.

### 6. Validate, then publish

```
ggui blueprint publish --dry-run               # conformance gate, no upload
ggui blueprint publish                         # build, sign, push to a registry
ggui blueprint install @<scope>/<name>         # use it
```

For local-only use you can also declare the blueprint in
`servers/ggui/ggui.json` instead of publishing — publish is for sharing it via
a registry.
