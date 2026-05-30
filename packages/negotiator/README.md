# @ggui-ai/negotiator

Contract-synthesis + match-judge engine for
[ggui](https://github.com/ggui-ai/ggui)'s handshake.

Given an agent's draft contract + intent, this package synthesizes (or
repairs) a conforming `DataContract`, judges blueprint-match candidates for
reuse, and validates contract structure + novelty — the primitives the
handshake composes to always return a valid contract.

> The handshake **decision** itself (find-similar → reuse vs synth-create)
> lives in the shared `decideHandshake` core in
> [`@ggui-ai/mcp-server-handlers`](../mcp-server-handlers), which composes
> the primitives below. The former in-package `negotiate()` RAG+decision
> pipeline was retired in favor of that unified, adapter-injected core
> (one decision spine, an OSS BYOK adapter and a cloud Bedrock adapter).

The package is deployment-agnostic. It composes the storage interfaces
defined in `@ggui-ai/mcp-server-core` (`EmbeddingProvider`, `VectorStore`),
so concrete embedding and vector-store bindings plug in at the call site
without this package depending on any particular cloud vendor.

## Install

```bash
pnpm add @ggui-ai/negotiator
```

## What's in the box

- **`synthesizeContract(...)`** — cold-path contract synthesizer. Turns an
  agent intent into a `DataContract` (props / context / action / stream
  specs, plus gadget references), with a repair loop and a schema-validation
  gate.
- **`ensureConformingContract(...)`** — the create-path guarantee: validates
  an untrusted draft and, on errors, deterministically normalizes or
  LLM-repairs it so the handshake always returns a contract that passes the
  backstop. Never throws.
- **`rerankCandidates(...)`** — LLM judge that re-ranks blueprint-match
  retrieval candidates (the semantic-match decision used by
  `decideHandshake`).
- **`validateContractStructure` / `validateContractNovelty`** — advisory
  validators for the actions-vs-context placement rule.

```ts
import { ensureConformingContract } from "@ggui-ai/negotiator";

const result = await ensureConformingContract({ llm }, { intent, draft });
// result.origin — "agent" (clean) | "synth" (repaired)
// result.contract — a DataContract guaranteed to pass the handshake backstop
```

## License

Apache-2.0 — see [`../LICENSE`](../LICENSE).
