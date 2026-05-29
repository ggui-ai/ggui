# Reference — writing MCP tools (your app's tools)

> Local reference for the agent working in this template. ggui is "invisible
> infrastructure": you don't write UI — you expose **tools** and ggui renders
> the interface. Tools arrive as **MCP servers** under `servers/mcps/*`.

## Add a domain MCP (the worked path)

`servers/mcps/todo` is the reference implementation — a standalone
`@modelcontextprotocol/sdk` server over streamable HTTP, no `@ggui-ai/*` deps.
To make your own:

1. **Copy it:** `servers/mcps/todo` → `servers/mcps/<your-domain>`. Rename the
   package in its `package.json` (`@<scope>/mcp-<domain>`) and pick a free port.
2. **Implement tools** in `src/handlers.ts`. Each tool:
   ```ts
   server.registerTool(
     'menu_search',
     {
       title: 'Menu · Search',
       description: 'Search the menu. Use when the diner asks what is available.',
       inputSchema: { query: z.string().describe('Free-text dish search.') },
       outputSchema: { items: z.array(z.object({ id: z.string(), name: z.string(), priceCents: z.number() })) },
     },
     async (input) => {
       const items = store.search(String(input.query));
       return { structuredContent: { items }, content: [{ type: 'text', text: JSON.stringify({ items }) }] };
     },
   );
   ```
   - `inputSchema` / `outputSchema` are **plain maps of zod validators** (not
     `z.object(...)` at the top level).
   - Return `{ structuredContent, content:[{type:'text', text}] }`.
   - **Descriptions are the agent's API** — they ship to the LLM. Write them as
     user-facing guidance ("Use after the diner confirms…"), never internal notes.
   - Hold state however you like (the todo sample uses an in-memory store; a
     real app uses a DB).
3. **Register it with the agent** (see CLAUDE.md "Tools = MCP servers"):
   - **All SDKs:** just set `GGUI_<NAME>_MCP_URL` in `.env.example` / `.env.local`
     (e.g. `GGUI_ORDERS_MCP_URL=…`). The agent scans the env and auto-registers
     it as `<name>` — no `servers/agent/src/index.ts` edit needed (`ggui` is the
     one fixed endpoint; every other MCP is discovered this way).
   - **Claude SDK only:** also add the tool prefixes to `DEFAULT_ALLOWED_TOOLS`
     in `servers/agent/src/agent.ts` (e.g. `mcp__<name>__menu_search`). The
     OpenAI + Google agents have no allowlist — the env var is enough.
4. **Run it:** nothing to wire — `pnpm dev` starts every `servers/mcps/*`
   automatically (the `dev:mcps` script globs the directory, so the folder _is_
   the list). To run just yours: `pnpm --filter ./servers/mcps/<your-domain> dev`.

## The render side (you don't write this — the agent does it)

After your tool returns data, the agent calls `ggui_render` describing the UI in
natural language; ggui generates it. You never build the component. See
`.reference/ggui-tools.md` for the render tools and `.reference/ggui-json.md`
for theming the result.

## Keep it principle-clean

- A **commit** (submit, add, update-status) is an action that drives the next
  turn. **Live draft state** (a quantity being stepped, a selection before
  commit) is observed state. Steppers, animations, and trackers are
  component behavior ggui generates — not tool inputs/outputs.
- Tools return **data**; they never render UI or call `ggui_*`.
