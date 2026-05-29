# `.reference/` — local GGUI reference for this template

These are distilled, authoritative notes about **ggui** for the agent (and you)
working in this scaffolded app. The Claude Code instance here can't read the ggui
source — so this folder is its local source of truth, alongside the live
`ggui-docs` MCP (`.mcp.json`) and https://docs.ggui.ai.

`CLAUDE.md` is the map; read these for depth.

| Doc | When to read |
| --- | ------------ |
| [`ggui-overview.md`](./ggui-overview.md) | What ggui is, the render loop, "you only build tools." Start here. |
| [`ggui-tools.md`](./ggui-tools.md) | The `ggui_*` render tools the agent calls (handshake/render/consume/…). |
| [`writing-mcp-tools.md`](./writing-mcp-tools.md) | Author your own domain MCP (copy `todo` → your tools → register per SDK). |
| [`ggui-json.md`](./ggui-json.md) | The `servers/ggui/ggui.json` server config (model, theme, gadgets). |
| [`theming.md`](./theming.md) | Presets + authoring a custom DTCG brand theme. |
| [`theme.example.json`](./theme.example.json) | A schema-valid starter theme — copy, edit `color.primary`, validate. |

Not exhaustive — for protocol internals (the four specs, blueprints, gadgets),
query the `ggui-docs` MCP or the docs site.
