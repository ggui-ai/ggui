# @ggui-ai/create-agentic-app

Scaffold a [ggui](https://github.com/ggui-ai/ggui) agentic app from one of
the three official templates.

## Usage

```bash
npx @ggui-ai/create-agentic-app                  # fully interactive
npx @ggui-ai/create-agentic-app my-app           # name from positional
npx @ggui-ai/create-agentic-app \
  --name my-app \
  --scope acme \
  --agent claude-agent-sdk \
  --install
```

## Agent SDKs

Pick one at scaffold time:

| `--agent`           | LLM              | Port |
| ------------------- | ---------------- | ---- |
| `claude-agent-sdk`  | Anthropic Claude | 6790 |
| `openai-agents-sdk` | OpenAI           | 6791 |
| `google-adk`        | Google Gemini    | 6792 |

`npx @ggui-ai/create-agentic-app --list-agents` prints the current list.

## What you get

A complete pnpm monorepo, ready to run:

```
my-app/
├── servers/
│   ├── agent/      # your chosen agent SDK + a React chat UI
│   ├── ggui/       # `ggui serve --mcp-only` config
│   └── mcp-todo/   # standalone MCP server (the worked example)
├── .env.example
├── .env.local      # seeded from .env.example
├── package.json    # renamed to your project name
├── pnpm-workspace.yaml
├── CLAUDE.md       # Claude Code guidance for this project
└── README.md
```

After scaffolding:

1. `cd my-app && pnpm install` (skip if you passed `--install`)
2. Add your API key to `.env.local` (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`)
3. Run the three servers in separate terminals:
   - `pnpm dev:ggui` → http://localhost:6781/mcp
   - `pnpm dev:todo` → http://localhost:6782/mcp
   - `pnpm dev:agent` → chat UI on 6790 / 6791 / 6792 depending on SDK
4. Inside Claude Code, run `/bootstrap` to tailor README + CLAUDE.md for your
   project (renames the workspace identity, removes the boilerplate
   one-time blocks).

## Environment

| Variable                  | Purpose                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GGUI_TEMPLATES_REPO_URL` | Override the source repo (default: `https://github.com/ggui-ai/agentic-app-templates`). Useful for forks. |
| `GGUI_TEMPLATES_REF`      | git ref to clone (default: `main`). Same as `--ref <ref>` on the CLI.                                     |

## Requirements

- Node ≥ 20
- `git` on PATH (used for the shallow clone)
- `pnpm` on PATH (used for `--install`; otherwise needed for the dev scripts)

## License

Apache-2.0 — see [LICENSE](./LICENSE).
