# Sample ggui — `default`

Baseline ggui-serving operator configuration. **Zero customization.** Pure `ggui serve` defaults — every optional field on `ggui.json` left absent so the bundled defaults apply.

Use as:

- The control variant in the end-to-end suite (every other `gguis/*` sample adds one operator-config dimension on top of this baseline).
- The smallest possible reference for "how do I run my own ggui MCP server."

## What's in here

```
ggui.json          minimal: schema + protocol + app identity
package.json       declares `start` script that runs `ggui serve --mcp-only`
```

That's it. No `blueprints/`, no `theme.css`, no custom gadgets — those land in the sibling `gguis/*` samples.

## Running standalone

```bash
pnpm --filter @ggui-samples/ggui-default start
# → ggui MCP server on http://localhost:6781
# → mcp endpoint at http://localhost:6781/mcp
```

Set `PORT=NNNN` to override.

## Pair with an agent

In another terminal:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter @ggui-samples/agent-claude-sdk start
# → chat UI at http://localhost:6790
```

The chat UI's iframe will render whatever UI the LLM emits via `ggui_render`.

## Used by

The end-to-end suite exercises this sample as the baseline control, pairing it with `@ggui-samples/agent-claude-sdk` to verify the protocol end-to-end with no operator customization in the loop.
