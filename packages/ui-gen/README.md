# @ggui-ai/ui-gen

UI generation harness for [ggui](https://github.com/ggui-ai/ggui) — the engine that turns a `DataContract` into a working React component.

It bundles the three coupled pieces of the generation pipeline:

- **System prompt** — the instructions that tell the LLM _how_ to code against the ggui design system.
- **Coding-agent harness** — the multi-turn loop (implement → self-check → patch → evaluate) plus provider adapters for Claude, OpenAI, and Google models.
- **Evaluation engine** — deterministic checks and LLM-judged scoring of generated components.

`ui-gen` implements the `UiGenerator` contract from `@ggui-ai/mcp-server-core`. Most applications never import it directly — it is consumed by `@ggui-ai/mcp-server`, which exposes generation over MCP.

## When to use this package

Reach for `@ggui-ai/ui-gen` directly only if you are:

- composing your own MCP server and want a drop-in `UiGenerator`, or
- building tooling around the generation pipeline (benchmarks, custom harnesses, evaluators).

For everything else, use `@ggui-ai/mcp-server`.

## Usage

```ts
import { createUiGenerator } from "@ggui-ai/ui-gen";
import { createAnthropicAdapter } from "@ggui-ai/ui-gen/providers";

const generator = createUiGenerator({
  adapter: createAnthropicAdapter(),
});

const result = await generator.generate({ request, llm, providerKey, blueprints });
```

The `./harness`, `./workflows`, `./classifier`, and `./fragments` subpaths are available for consumers that want to compose the harness themselves.

## License

Apache-2.0
