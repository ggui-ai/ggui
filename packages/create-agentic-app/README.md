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

## Options

| Flag              | Effect                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`   | npm package name. Defaults to `<target>`. kebab-case.                                                                       |
| `--scope <scope>` | npm scope for the `servers/*` + `apps/*` packages (no leading `@`). Defaults to the project name.                           |
| `--agent <sdk>`   | One of the SDKs below. Prompted if omitted.                                                                                 |
| `--install`       | Run `pnpm install` after scaffolding.                                                                                       |
| `--no-git`        | Skip `git init` + initial commit (done by default — see below).                                                             |
| `--force`         | Overwrite the target directory if it exists and is non-empty.                                                               |
| `--ref <ref>`     | Opt into cloning the live templates mirror at this git ref instead of the bundled templates (default: bundled — see below). |
| `--list-agents`   | Print the supported agent SDKs and exit.                                                                                    |
| `--help`, `-h`    | Show help.                                                                                                                  |

## Templates source

The templates ship **inside this package** (at `dist/templates/`), exact-pinned
to this CLI's own `@ggui-ai/*` cohort version — scaffolding is offline by
default, with no network access and no clone. Passing `--ref` (or setting
either `GGUI_TEMPLATES_*` env var) opts into shallow-cloning the live mirror at
[`ggui-ai/agentic-app-templates`](https://github.com/ggui-ai/agentic-app-templates)
instead, which requires `git`.

## Agent SDKs

Pick one at scaffold time:

| `--agent`           | LLM              |
| ------------------- | ---------------- |
| `claude-agent-sdk`  | Anthropic Claude |
| `openai-agents-sdk` | OpenAI           |
| `google-adk`        | Google Gemini    |

All three agent backends listen on the same dev port (6790). The Railway
deploy config is the one place ports diverge per SDK (6790 / 6791 / 6792 in
`railway.toml`).

`npx @ggui-ai/create-agentic-app --list-agents` prints the current list.

## What you get

A complete pnpm monorepo, ready to run:

```
my-app/
├── servers/
│   ├── agent/          # your chosen agent SDK + the chat loop
│   ├── ggui/           # `ggui serve` config — renders the agent's UI
│   └── mcps/
│       └── todo/       # worked-example MCP server — copy it for your domain
├── apps/
│   └── web/            # Vite SPA — @ggui-ai/react <AppRenderer>
├── .reference/         # local ggui guides for the Claude Code in this repo
├── .claude/            # Claude Code settings + /bootstrap slash command
├── scripts/            # deploy-railway.mjs (powers `pnpm deploy:railway`)
├── .env.example
├── .env.local          # seeded from .env.example
├── .gitignore          # already excludes .env*.local, node_modules, dist
├── .mcp.json           # wires the ggui-docs MCP for Claude Code
├── railway.toml
├── package.json        # renamed to your project name
├── pnpm-workspace.yaml
├── CLAUDE.md           # Claude Code guidance for this project
└── README.md
```

It's also **already a git repository** with one initial commit — so you can add
a remote and push immediately. The commit runs _after_ `--install`, so a
generated `pnpm-lock.yaml` is included. Pass `--no-git` to skip it (or, to
re-author the commit under your own identity, `git commit --amend --reset-author`).

## After scaffolding

1. `cd my-app && pnpm install` (skip if you passed `--install`)
2. Add your API key to `.env.local` (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`)
3. `pnpm dev` starts all four servers and opens the app at http://localhost:6890
   when it's ready (logs hidden by default — `pnpm dev --verbose` streams them).
   To run them in separate terminals instead:
   - `pnpm dev:ggui` → http://localhost:6781/mcp
   - `pnpm dev:mcps` → every `servers/mcps/*` (todo on http://localhost:6782/mcp)
   - `pnpm dev:agent` → agent backend on http://localhost:6790 (uniform across SDKs)
   - `pnpm dev:web` → frontend SPA on http://localhost:6890
4. Open http://localhost:6890 and chat (`pnpm dev` opens it for you).
5. Inside Claude Code, run `/bootstrap` — it tailors the README + CLAUDE.md
   prose for your domain, walks you through building your first tool, and
   removes its own one-time onboarding block when done.

Deploying? `pnpm deploy:railway` provisions all four services on Railway in one
command (see the scaffolded project's `CLAUDE.md`).

## Environment

Both variables opt into clone mode (instead of the default bundled templates):

| Variable                  | Purpose                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GGUI_TEMPLATES_REPO_URL` | Clone this repo instead of using the bundle (default repo: `https://github.com/ggui-ai/agentic-app-templates`). Useful for forks. |
| `GGUI_TEMPLATES_REF`      | git ref to clone (default: `main`). Same as `--ref <ref>` on the CLI.                                                             |

## Requirements

- Node ≥ 20
- `git` on PATH (used to initialize the project repo + first commit unless
  `--no-git`, and for the shallow clone when `--ref` / `GGUI_TEMPLATES_*`
  opt into clone mode)
- `pnpm` on PATH (used for `--install`; otherwise needed for the dev scripts)

## License

Apache-2.0 — see [LICENSE](./LICENSE).
