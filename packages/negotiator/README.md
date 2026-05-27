# @ggui-ai/negotiator

UI decision engine for [ggui](https://github.com/ggui-ai/ggui).

Given an agent's signal (data, prompt, context, agent tools) and the current
render state, the negotiator decides **which UI to render** — create a new
interface, update an existing one, or replace it — and, on the cold path,
synthesizes the data contract that drives it.

The package is deployment-agnostic. It composes the storage interfaces
defined in `@ggui-ai/mcp-server-core` (`EmbeddingProvider`, `VectorStore`),
so concrete embedding and vector-store bindings plug in at the call site
without this package depending on any particular cloud vendor.

## Install

```bash
pnpm add @ggui-ai/negotiator
```

## What's in the box

- **`negotiate(deps, input)`** — top-level orchestrator. Runs RAG search over
  registered blueprints, reads render state, fast-paths exact blueprint
  hits, and otherwise calls the decision LLM.
- **`makeDecision(...)`** — the decision step in isolation: pick an action
  (`create` / `update` / `replace`) and a blueprint from the
  candidate set.
- **`synthesizeContract(...)`** — cold-path contract synthesizer. Turns an
  agent intent into a `DataContract` (props / context / action / stream
  specs, plus gadget references), with a repair loop and a schema-validation
  gate.
- **`ragSearch(...)`** — embedding + vector-store retrieval over the
  blueprint corpus, composing the `@ggui-ai/mcp-server-core` interfaces.
- **`rerankCandidates(...)`** — LLM re-rank of retrieval candidates.
- **`validateContractStructure` / `validateContractNovelty`** — advisory
  validators for the actions-vs-context placement rule.

```ts
import { negotiate } from "@ggui-ai/negotiator";

const result = await negotiate(deps, input);
// result.action — "create" | "update" | "replace"
// result.blueprint — the picked blueprint, if any
```

## License

Apache-2.0 — see [`../LICENSE`](../LICENSE).
