---
description: Guided first-run onboarding for a freshly-scaffolded ggui agentic-app — show it working, help pick what to build, scaffold the first tool, make it theirs.
---

You are onboarding a developer who just scaffolded this ggui agentic-app
template. This is an **experience, not an env-setup script**: take them from
"just cloned, no idea what this is" to "my own first tool is rendering — and it
looks like mine."

**Principle: SHOW first, TELL second. Build momentum, not completeness.**

Work the four beats below as a conversation — adapt to their answers, ask ONE
question at a time, and only ask for what you genuinely cannot resolve yourself.

## Beat 1 — Show it working first

1. **Quietly check the environment** (don't narrate a checklist):
   - Detect which framework this template is — read `servers/agent/package.json`
     / this repo's `CLAUDE.md` (Claude Agent SDK / OpenAI Agents SDK / Google
     ADK). Never ask; detect it.
   - Verify Node ≥ 20, deps installed (`pnpm install` if `node_modules` is
     missing), `.env.local` present (copy from `.env.example` if not), and the
     LLM API key(s) filled in. The ggui server config is `servers/ggui/ggui.json`.
   - Fix what you can. Only ask the user for what you truly can't resolve (e.g. a
     missing API key) — one ask at a time, with the exact value to paste where.
2. **Boot the stack and fire ONE example prompt** against the bundled to-do MCP
   so they SEE a generative UI actually render — *before* any explanation. Start
   `pnpm dev:ggui`, `pnpm dev:todo`, `pnpm dev:agent`, `pnpm dev:web`, open the
   web URL, and send something like *"show my to-dos and let me add one."*
3. **Land the key message** (the bridge to Beat 2):
   > "Notice — nobody designed that UI. We only gave the agent a **tool**; ggui
   > rendered the interface from it. So the only thing you build is tools."

## Beat 2 — Decide what to build, then make the first tool

1. Ask: **"What kind of agentic app do you want to build?"**
2. If they're stuck, offer example verticals (table ordering, reservations, an
   internal admin dashboard, support triage, …) — **coach, don't decide for them.**
3. Keep scope realistic for a hackathon: aim for **3–5 tools, not 30.**
4. Briefly map their idea to the judging rubric so they build toward points:
   **generative-UI usage · multi-turn consistency · MCP tool use · idea & polish.**
5. **Scaffold their FIRST tool for them:** copy `servers/mcps/todo` →
   `servers/mcps/<their-domain>`, rename the package, replace the to-do tools
   with one tool of *their* domain (a real input schema + a handler returning
   structured data), and register it with the agent — see CLAUDE.md
   "Tools = MCP servers" (and `.reference/writing-mcp-tools.md`) for the exact
   wiring for THIS SDK. By the end of this beat it's THEIR idea on screen, not
   the sample.

## Beat 3 — Let them confirm it

Run their new tool end to end (restart the affected servers, fire a prompt that
exercises it) so they SEE their OWN generative UI render. Name the moment —
that's their app working.

## Beat 4 — Make it theirs (theme)

1. Offer: **"Want it to look like your app? Let's set a theme."**
2. Apply a theme in `servers/ggui/ggui.json` (a brand accent + light/dark; maybe
   typography) and re-render the SAME surface so they SEE it instantly restyled.
3. Point out the payoff: **they never touched UI code** — the agent-rendered UI
   just adopted their brand. That's the ownership moment.
4. Keep it light: one or two choices with a sensible default. Not a design session.

## Handoff

- Short "what's next" checklist: add more tools, add a **write** action (change
  state, not just read), test **multi-turn** consistency, deepen the theme,
  deploy with `pnpm deploy:railway`.
- Point them at **https://docs.ggui.ai** and remind them of the rubric.
- Mark onboarding done: remove the block between `<!-- bootstrap:onboarding -->`
  and `<!-- /bootstrap:onboarding -->` in `CLAUDE.md` (inclusive) so it stops
  nagging. Leave `/blueprint` and `/gadget` — they're ongoing authoring tools.

## Design rules

- **Show > Tell** — demonstrate working output before explaining.
- **One question at a time**; adapt. If the framework is already chosen, don't ask.
- **Idempotent** — detect state; don't redo finished steps. If the project is
  already renamed and has a custom MCP, skip to where they left off.
- **Momentum over completeness** — the goal is "first tool works + looks theirs,"
  not "understood everything."
- **Fail gracefully** — if the ggui server is down or a key is missing, say
  exactly what to do; never leave them guessing.

## Avoid

- Dumping docs or making them read the whole codebase.
- Deciding the idea for them (coach, don't dictate).
- Turning the theme step into a full design session.
- Installing or running anything irreversible without consent.
