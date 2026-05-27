// packages/ui-gen/src/evaluation/axis-checks/checks/tooling.ts
//
// Checks gated on the tooling axis. Two surfaces:
//
//   - `tooling.clientCapability.hook_called` — verifies every declared
//     `clientCapabilities.gadgets[name]` has a matching
//     `const <name> = …()` binding in source.
//   - `tooling.clientCapability.start_called` — verifies a bound
//     gadget hook also has a `.start(...)` invocation; without it
//     the capability stays in `idle` and never fires.
//   - `realtime.stream_source.no_direct_call` — the LLM must NOT
//     directly invoke a tool named on `streamSpec[*].source.tool`;
//     subscribe via `useStream(...)` instead.
//   - `universal.no_retired_identifiers` — fires on every contract.
//     The LLM's training data predates the current wire shape and
//     reaches for retired identifiers (component-side tool hooks,
//     dispatch.kind, intendedTool, broadcast field, retired catalog
//     names, retired package imports, retired wire-input fields).
//     The grep gate emits one issue per detected identifier so the
//     LLM rewrites toward the current shape before evaluation
//     completes.

import type { DataContract, StreamChannelEntry } from "@ggui-ai/protocol";
import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import { getGadgetNames, getStdlibGadgetNames, mkIssue } from "../helpers.js";

const CLIENT_PRESENT = ["client", "both"] as const;
const ALL_TOOLING_VALUES = ["none", "wired", "client", "both"] as const;
const REALTIME_ACTIVE = [
  "merge",
  "append",
  "status",
  "presence",
  "mixed",
] as const;

// ── clientCapabilities ──────────────────────────────────────────────

function runGadgetHookCalled(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const names = getGadgetNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of names) {
    // The boilerplate emits `const <name> = <hook>();` — match the const
    // binding to detect omission. We don't pin the hook identifier here
    // because the contract carries it via `entry.hook` and the LLM may
    // legitimately alias on import.
    const re = new RegExp(`const\\s+${name}\\s*=`);
    if (re.test(src)) continue;
    issues.push(
      mkIssue(
        "tooling.clientCapability.hook_called",
        `Contract clientCapability "${name}" has no \`const ${name} = …()\` hook call.`,
        `Import the declared hook (default package: @ggui-ai/gadgets) and bind its return value to \`const ${name}\` at the top of the component; surface \`.value\` / \`.status\` in JSX.`,
      ),
    );
  }
  return issues;
}

function runClientCapabilityStartCalled(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  // Only the first-party `@ggui-ai/gadgets` browser capabilities have
  // the `idle → prompting → active` lifecycle that `.start()` drives.
  // Registered third-party gadget hooks (e.g. `useBoardState`) are
  // plain data hooks the runtime resolves on its own — exclude them.
  const names = getStdlibGadgetNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of names) {
    // Skip when the binding doesn't exist — the `hook_called` check
    // covers that case; we don't double-issue.
    const bindingRe = new RegExp(`const\\s+${name}\\s*=`);
    if (!bindingRe.test(src)) continue;

    // The capability lifecycle requires `.start()` invocation to
    // transition from `idle` → `prompting`. Without it the hook's
    // `.value` / `.status` stay frozen at the initial state and the
    // UI feature never fires. Match `<name>.start(`, allowing chained
    // member access or method aliasing.
    const startRe = new RegExp(`\\b${name}\\s*\\.\\s*start\\s*\\(`);
    if (startRe.test(src)) continue;
    issues.push(
      mkIssue(
        "tooling.clientCapability.start_called",
        `clientCapability "${name}" is bound but \`${name}.start(…)\` is never invoked — the capability stays in 'idle' and the feature won't fire.`,
        `Wire \`${name}.start({...})\` to a UI control (Button onClick, effect, etc.). Read \`.status\` to gate the UI between 'idle' / 'prompting' / 'active' / 'completed' / 'denied' / 'error'.`,
      ),
    );
  }
  return issues;
}

// ── streamSpec sources ──────────────────────────────────────────────

function collectStreamSourceTools(
  contract: DataContract | undefined,
): Map<string, string> {
  // Map<channelName, sourceToolName> for every channel that declares
  // a source. Excludes channels without `source` (agent-written).
  const result = new Map<string, string>();
  const streamSpec = contract?.streamSpec;
  if (!streamSpec || typeof streamSpec !== "object") return result;
  for (const [channelName, entryRaw] of Object.entries(streamSpec)) {
    const entry = entryRaw as StreamChannelEntry | undefined;
    if (!entry || typeof entry !== "object") continue;
    const tool = entry.source?.tool;
    if (typeof tool !== "string" || tool.length === 0) continue;
    result.set(channelName, tool);
  }
  return result;
}

function runStreamSourceNoDirectCall(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const map = collectStreamSourceTools(input.contract);
  if (map.size === 0) return [];

  const issues: EvalIssue[] = [];
  for (const [channelName, toolName] of map) {
    // Detect a direct call to the source tool. Matches identifier
    // followed by `(` — covers `foo()`, `foo(args)`, `foo.bar()`
    // (the dotted form indirectly catches `someObject.foo()` which
    // the contract doesn't expect to see, since the source tool is
    // an agent-side MCP tool, not a local function).
    const callRe = new RegExp(`\\b${toolName}\\s*\\(`);
    if (!callRe.test(src)) continue;

    // Don't false-fire when `toolName` happens to be the channel name
    // bound to useStream (e.g., `const messages = useStream(...)` then
    // `messages(...)` would be weird but we're matching the TOOL name,
    // not the binding). If toolName === channelName then the
    // `<channel>(` call would be the useStream binding being called
    // as a function — which is itself wrong, so still emit.
    issues.push(
      mkIssue(
        "realtime.stream_source.no_direct_call",
        `Source code calls \`${toolName}(...)\` directly but the contract declares it as the source tool for streamSpec.${channelName}. Source tools are agent-side / runtime-polled; the component MUST NOT invoke them.`,
        `Subscribe to the channel via \`const ${channelName} = useStream('${channelName}');\` and read \`${channelName}.latest\` / \`${channelName}.all\` — the runtime polls or subscribes to '${toolName}' on the component's behalf.`,
      ),
    );
  }
  return issues;
}

// ── Anti-pattern grep — retired identifiers a model may emit from
//    stale training data ──

interface RetiredIdentifier {
  /** Regex matching the retired surface in source. */
  readonly pattern: RegExp;
  /** Stable subcategory used for the EvalIssue. */
  readonly id: string;
  /** Human-readable description for the issue message. */
  readonly label: string;
  /** Replacement guidance for the fix message. */
  readonly replacement: string;
}

const RETIRED_IDENTIFIERS: readonly RetiredIdentifier[] = [
  {
    pattern: /\buseWiredTool\b/,
    id: "useWiredTool",
    label: "`useWiredTool(...)` hook",
    replacement:
      "Use `useAction(name)` for user gestures the agent should react to. `agentCapabilities.tools` entries are agent-side catalog declarations — the component never calls them directly.",
  },
  {
    pattern: /\buseAgentTool\b/,
    id: "useAgentTool",
    label: "`useAgentTool(...)` hook",
    replacement:
      "Agent-side tools are NEVER imported as component hooks. The contract declares them under `agentCapabilities.tools` for cross-ref (actionSpec.nextStep / streamSpec.source.tool); the component reacts via `useAction` / `useStream`.",
  },
  {
    pattern: /\bcallWiredTool\b/,
    id: "callWiredTool",
    label: "`callWiredTool(...)` call",
    replacement:
      "Component-side direct invocation of agent-side tools is retired. Fire a UI gesture via `useAction(name)`; the agent reacts on its next turn (`nextStep` hint optional).",
  },
  {
    pattern: /\buseClientTool\b/,
    id: "useClientTool",
    label: "`useClientTool(name, handler)` hook",
    replacement:
      "Use a gadget hook from `@ggui-ai/gadgets` (e.g., `useGeolocation`, `useClipboardWrite`) and thread the result into a contextSpec slot or actionSpec payload.",
  },
  {
    pattern: /\bdispatch\s*:\s*\{\s*kind\s*:/,
    id: "dispatch.kind",
    label: "`dispatch: { kind: '...' }` discriminated union",
    replacement:
      "ActionEntry.dispatch is retired. Use the flat `nextStep?: '<tool>'` field on the action entry instead.",
  },
  {
    pattern: /\bintendedTool\b/,
    id: "intendedTool",
    label: "`intendedTool` field",
    replacement:
      "Use the flat `nextStep` field — the hint surface is one optional advisory string, not a nested discriminator.",
  },
  {
    pattern: /\bmode\s*:\s*['"`]host-routed['"`]/,
    id: "mode.host-routed",
    label: "`mode: 'host-routed'`",
    replacement:
      "The `mode` field on action entries is retired. All actions are agent-routed; use `nextStep` for the optional tool hint.",
  },
  {
    pattern: /\bbroadcast\s*:\s*\{/,
    id: "broadcast",
    label: "`broadcast: { … }` contract field",
    replacement:
      "Move the channel source declaration to `streamSpec[channel].source = { tool, args? }`.",
  },
  {
    // Match `agentTools` only as a contract-shaped object key or
    // property access — not as a local variable name in unrelated
    // code. `\bagentTools\s*[:.]` catches `{ agentTools: {...} }` /
    // `contract.agentTools` while ignoring `const agentTools = ...`.
    pattern: /\bagentTools\s*[:.]/,
    id: "contract.agentTools",
    label: "`agentTools` top-level contract field",
    replacement:
      "The top-level `agentTools` field is retired. Declare agent-side tools under `agentCapabilities.tools` (catalog nested under a capabilities parent for symmetry with `clientCapabilities`).",
  },
  {
    pattern: /\bclientCapabilities\s*\.\s*capabilities\b/,
    id: "clientCapabilities.capabilities",
    label: "`clientCapabilities.capabilities` inner key",
    replacement:
      "The inner `capabilities` key is retired. Use `clientCapabilities.gadgets` — entries are library-hook declarations, not RPC capabilities.",
  },
  {
    pattern: /['"`]@ggui-ai\/client-tools['"`]/,
    id: "package.@ggui-ai/client-tools",
    label: "`@ggui-ai/client-tools` package import",
    replacement:
      "The package was renamed to `@ggui-ai/gadgets`. Update the import string.",
  },
  {
    pattern: /\bPushStory\b/,
    id: "PushStory",
    label: "`PushStory` type / `pushStorySchema` schema",
    replacement:
      "`PushStory` was retired when the handshake input was flattened. The post-Phase-B wire is `ggui_handshake({intent, blueprintDraft: {contract, variance?, generator?}})` + `ggui_render({handshakeId, decision: {kind: 'accept' | 'override', blueprintDraft?}, props?})`.",
  },
  {
    pattern: /\bpushStorySchema\b/,
    id: "pushStorySchema",
    label: "`pushStorySchema` zod schema",
    replacement:
      "`pushStorySchema` was retired alongside `PushStory`. Current schemas: `handshakeInputSchema` + `renderInputSchema` (with the `decision` discriminator) in `@ggui-ai/protocol`.",
  },
  {
    pattern: /\bstory\s*\.\s*adapters\b/,
    id: "story.adapters",
    label: "`story.adapters` field access",
    replacement:
      "The story.adapters gate was retired alongside `PushStory`. Per-app permission gates flow through `clientCapabilities.gadgets[*].permission` (Permissions-Policy derivation).",
  },
  {
    pattern: /\bdeclaredAdapters\b/,
    id: "declaredAdapters",
    label: "`declaredAdapters` field / runtime gate",
    replacement:
      "App-level `declaredAdapters` was retired. Per-app permission gates derive from `clientCapabilities.gadgets[*].permission` instead.",
  },
  {
    pattern: /\bassertAdaptersDeclared\b/,
    id: "assertAdaptersDeclared",
    label: "`assertAdaptersDeclared(...)` runtime call",
    replacement:
      "The runtime adapter-gate function is retired. Permissions-Policy is derived per-contract at render commit time and threaded through the bootstrap projection.",
  },
  {
    pattern: /\bHandshakeStoredStory\b/,
    id: "HandshakeStoredStory",
    label: "`HandshakeStoredStory` storage type",
    replacement:
      "The OSS handler's stored type is now `HandshakeStoredInput` with the MVB-5 `{intent, blueprintDraft, forceCreate?}` shape.",
  },
  {
    pattern: /\brecord\s*\.\s*story\b/,
    id: "record.story",
    label: "`record.story.*` access on handshake storage",
    replacement:
      "Handshake storage was flattened. Read `record.input.*` (intent / blueprintDraft) — the nested `story` wrapper is gone. MVB-5 also adds `record.suggestion` + `record.effectiveContract`.",
  },
];

function runNoRetiredIdentifiers(input: AxisCheckInput): EvalIssue[] {
  // Source-only scan; compiled code irrelevant for identifier detection.
  // Run even without compiled code so we surface early in the loop.
  const src = input.sourceCode;
  const issues: EvalIssue[] = [];
  for (const rule of RETIRED_IDENTIFIERS) {
    if (!rule.pattern.test(src)) continue;
    issues.push(
      mkIssue(
        `universal.no_retired_identifiers.${rule.id}`,
        `Source contains ${rule.label} — retired from the contract surface.`,
        rule.replacement,
      ),
    );
  }
  return issues;
}

export const TOOLING_CHECKS: readonly AxisCheck[] = [
  {
    id: "tooling.clientCapability.hook_called",
    axis: "tooling",
    values: CLIENT_PRESENT,
    run: runGadgetHookCalled,
  },
  {
    id: "tooling.clientCapability.start_called",
    axis: "tooling",
    values: CLIENT_PRESENT,
    run: runClientCapabilityStartCalled,
  },
  {
    // Stream-source direct-call check. Gated on realtime axis (rather
    // than tooling) since stream sources are a realtime concern — but
    // logically lives in tooling.ts alongside the other tool-reference
    // checks since the issue class is about referenced agentTools.
    id: "realtime.stream_source.no_direct_call",
    axis: "realtime",
    values: REALTIME_ACTIVE,
    run: runStreamSourceNoDirectCall,
  },
  {
    // Universal — fires on every tooling-axis value. The check itself
    // is contract-agnostic; the axis gate is "every contract" via the
    // full ALL_TOOLING_VALUES list (rather than the universal-check
    // module's "render" gate convention) so the anti-pattern stays
    // co-located with the other tooling-related rules.
    id: "universal.no_retired_identifiers",
    axis: "tooling",
    values: ALL_TOOLING_VALUES,
    run: runNoRetiredIdentifiers,
  },
];
