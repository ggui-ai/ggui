# @ggui-ai/agent-runtime

Pluggable adapter seam for "the thing that runs an agent."

Part of the **ggui protocol** toolchain, this package defines a small contract —
`AgentRuntimeAdapter` — for supervising whatever actually executes an agent: the
Claude Agent SDK, OpenAI Agents, the Vercel AI SDK, a plain subprocess, or anything
else. A host consumes this seam so no agent framework is hardcoded into its dev loop;
swapping runtimes never touches host code.

This package exposes the contract types plus an in-memory stub adapter
(`createStubAgentRuntime`) for tests and local development. Framework-specific
adapters live in their own packages so consumers opt into the dependency weight.

## Exports

| Import                           | Contents                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| `@ggui-ai/agent-runtime`         | The `AgentRuntimeAdapter` contract and the in-memory stub. |
| `@ggui-ai/agent-runtime/process` | A subprocess-backed adapter.                               |

## License

Apache-2.0
