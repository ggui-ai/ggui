/**
 * `@ggui-ai/agent-runtime` — pluggable adapter seam for "the thing
 * that runs an agent," consumed by the open dev engine
 * (`@ggui-ai/dev-stack`) and any future non-dev host (bench
 * runners, remote supervisors).
 *
 * This barrel exposes the contract + an in-memory stub adapter.
 * Framework-specific adapters (Claude Agent SDK, OpenAI Agents,
 * Vercel AI SDK, a plain subprocess) live in their own packages so
 * consumers opt into the dependency weight.
 *
 * Design rule: the agent framework is NEVER hardcoded into the dev
 * engine. This adapter seam carries every framework, so a host can
 * swap runtimes without touching engine code.
 */
export type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  AgentRuntimeHandle,
  AgentRuntimeListener,
  AgentRuntimeProjectIdentity,
  AgentRuntimeStartInput,
  AgentRuntimeStatus,
} from './types.js';

export {
  createStubAgentRuntime,
  type StubAgentRuntimeController,
  type StubAgentRuntimeOptions,
} from './stub.js';
