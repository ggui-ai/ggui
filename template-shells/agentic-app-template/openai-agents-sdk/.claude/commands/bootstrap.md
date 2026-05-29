---
description: Tailor this freshly-scaffolded template into the user's own project
---

Help the user finish setting up their project. The `npx @ggui-ai/create-agentic-app`
tool has already done the mechanical scaffolding (laid down the file tree,
renamed packages to the chosen scope, seeded `.env.local`, optionally
installed). This command does the **prose** half — the parts that need
judgement.

## 1. Check state

Read the root `package.json`. If its `name` is still `agentic-app-template`,
the user ran `create-agentic-app` without `--name` and `--scope`, so the
mechanical renames have not happened. Run them now:

- Ask for **project name** (kebab-case, e.g. `my-agentic-app`) and
  **npm scope** (lowercase, no `@`, e.g. `acme`).
- Update root `package.json` `name` to the project name.
- Update each of `servers/agent/package.json`, `servers/mcp-todo/package.json`,
  `servers/ggui/package.json`: change `@agentic-app-template/<leaf>` to
  `@<scope>/<leaf>`.

If the name is anything else, skip this step — the user already did it.

## 2. Tailor the docs

- Rewrite `README.md` for the new project: drop the "use the create tool"
  framing and the template framing. Keep a short quick start and the
  architecture pointer.
- In `CLAUDE.md`, delete the block delimited by `<!-- BOOTSTRAP:START -->` and
  `<!-- BOOTSTRAP:END -->` (inclusive of both comment lines).

## 3. Remove template-only scaffolding

Delete this file: `.claude/commands/bootstrap.md`.

(`.claude/commands/blueprint.md` and `.claude/commands/gadget.md` stay — they
are ongoing authoring tools, not template-only.)

## 4. Report

Summarize what changed, then give next steps:

1. Confirm `ANTHROPIC_API_KEY` is in `.env.local` (if not already set).
2. Run the demo — `pnpm dev:ggui`, `pnpm dev:todo`, `pnpm dev:agent` in three
   terminals (see CLAUDE.md "Running locally").
3. Build your app — see CLAUDE.md "Building your app". The `/blueprint` and
   `/gadget` commands stay available for authoring cached UI patterns and
   client-side library wrappers.
