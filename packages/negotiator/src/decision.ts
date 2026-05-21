/**
 * Decision Engine — one LLM call, one UI decision.
 *
 * Replaces the V2 brainstorm/option-picker pattern with a single
 * opinionated decision: `create` / `update` / `compose` / `replace`.
 * The LLM sees the agent's data, the current session stack, any
 * `blueprintCandidates` from `ragSearch`, and returns a
 * {@link NegotiatorDecision} with a full {@link DataContract} payload.
 *
 * Contract shape — the returned `contract` always includes an
 * `intent` (semantic identity — same intent = cached component).
 * Other fields are populated opportunistically; `agentCapabilities` is
 * always populated deterministically from `input.agentTools` after
 * the LLM returns (see {@link mergeAgentCapabilities}). The
 * `clientCapabilities.gadgets` catalog is similarly enriched from
 * the per-app gadget list (see {@link mergeGadgets}).
 *
 * Structured output — prefers `llmCaller.callStructured?` with a
 * forced-tool-use schema (guaranteed JSON). Falls back to text + regex
 * JSON extraction if the caller doesn't support structured output, or
 * if the structured call throws. On total parse failure, emits a
 * fallback decision with `action: 'create'` built from the agent's
 * data shape.
 *
 * ## Public surface + semver weight
 *
 * Exported:
 *   - `DECISION_SYSTEM_PROMPT` — the system prompt constant. Its
 *     content is part of the behavioral contract: changing the prompt
 *     changes what the model emits and therefore changes the cache
 *     identity of downstream generated blueprints. Treat content
 *     changes like `CRITERIA` ordering: CHANGELOG-worthy.
 *   - `buildDecisionUserMessage(input)` — pure string builder. Stable
 *     output for stable input.
 *   - `makeDecision(input, llmCaller)` — runtime orchestrator.
 *
 * Intentionally **not** exported:
 *   - `DECISION_TOOL` — the OpenAI-style tool schema handed to
 *     `callStructured`. Pinning its shape in the public API would
 *     freeze the tool-schema format consumers never need to see.
 *   - `mergeAgentCapabilities`, `mergeGadgets`, `buildFallbackDecision`,
 *     `inferType` — engine-internal helpers.
 */

import type {
  AgentCapabilitiesSpec,
  GadgetDescriptor,
  GadgetExport,
  GadgetExportUse,
  GadgetPackageUse,
  DataContract,
  JsonValue,
  NegotiatorAlternative,
  NegotiatorDecision,
} from '@ggui-ai/protocol';
import { gadgetExportName, gadgetIdentityKey } from '@ggui-ai/protocol';
import type { NegotiatorDecisionInput } from './decision-input.js';
import type { LLMCaller } from './llm-caller.js';
import { composeAvailableGadgetsSection } from './synthesize-contract.js';

export const DECISION_SYSTEM_PROMPT = `You are a UI strategist for ggui, a generative UI platform. Given the agent's data, current session state, and blueprint candidates, decide the best way to show this information.

Respond with a JSON object:
{
  "action": "create" | "update" | "compose" | "replace",
  "reasoning": "1-2 sentences explaining why",
  "blueprintId": "matched blueprint ID or null",
  "targetStackItemId": "existing page to update/compose/replace, or null",
  "contract": {
    "intent": "Concise purpose — e.g. 'Display current weather conditions for a quick daily check'",
    "propsSpec": {
      "properties": {
        "fieldName": {
          "description": "what this field is",
          "schema": { "type": "string" },
          "required": true,
          "example": "sample value"
        }
      }
    }
  },
  "adaptations": {
    "fontSize": "compact" | "default" | "large",
    "density": "dense" | "default" | "spacious",
    "complexity": "simplified" | "default" | "detailed"
  }
}

INTENT RULES (most important):
- The "intent" field captures WHY this UI exists in one sentence.
- Include: the user's goal (why), what data is shown (what), and how they interact (how).
- Be abstract enough to match reusable patterns — "Display current weather conditions" not "Display Tokyo weather at 3pm".
- Same intent = same component can be reused with different data.
- Examples:
  - "Display current weather conditions for a quick daily check"
  - "Collect user feedback via a multi-field survey form"
  - "Show real-time stock prices with live updates"
  - "Compare two products side by side for purchase decision"

DECISION RULES:
- "create": No existing UI or blueprint matches this intent. Show something new.
- "update": An existing UI on the stack has the same intent. Update its props.
- "compose": An existing UI could incorporate this data as a section.
- "replace": Two or more related UIs would be better as a single unified view.

REUSE BIAS (critical for performance):
- Reusing a blueprint = INSTANT render (cached code, <1 second).
- Creating new = 20+ seconds of generation. The user waits.
- Default to reuse. Only "create" when NO candidate can reasonably serve the request.
- A candidate that shows the SAME KIND of data (e.g., weather, stock prices, user profiles) is a match — even if the specific data differs (Tokyo vs Seoul, AAPL vs GOOG).
- Ask yourself: "Can this candidate display the agent's data with different prop values?" If yes → reuse it.
- When reusing a blueprint, copy its contract EXACTLY as-is (including its intent). Do NOT rephrase the intent.

CONTRACT RULES:
- Always include an "intent" field — it's required.
- If reusing a blueprint: use that blueprint's contract verbatim. Do not modify intent or propsSpec.
- If no blueprint match: infer propsSpec.properties from the agent's data shape. Each key becomes a prop.
- Use the data values as examples.

ACTION SPEC — declare interactive affordances WHENEVER you see them in the data:
- The discrimination is local-state vs persistent-state, NOT "did the agent declare agentTools".
- LOCAL STATE (counter value, theme toggle, slider position, picker selection, search-as-you-type, form draft fields): contextSpec only. NO actionSpec. The slot mirror IS the wire — the agent observes context via its next ggui_consume.
- PERSISTENT STATE (items with identity / IDs + mutable fields, draft submissions awaiting save, deletions of agent-owned rows): actionSpec required. Each gesture is a discrete event the agent must witness.
- Inference signals for persistent state:
  • Items with \`id\`/\`itemId\`/\`uuid\` fields + boolean toggle fields like \`done\`/\`completed\`/\`checked\`/\`pinned\`/\`enabled\` → toggle action (e.g. \`toggleTodo\`, \`togglePin\`).
  • Lists where the data shape implies the agent maintains identity → add/delete actions.
  • Form data with mutable fields + a submit gesture → submit action.
  • A click that would cause a server-side side-effect (publish, archive, send, delete-from-database) → action.
- nextStep is OPTIONAL on actionSpec entries:
  • Bind \`nextStep: "tool_name"\` ONLY when input.agentTools contains a matching tool (exact or close name match — \`todo_toggle\` matches the \`toggleTodo\` action).
  • If no agentTools match, OMIT nextStep. Events drain via ggui_consume on the agent's next turn — the agent's reasoning loop sees the event and decides what to do.
- Examples:
  • agentTools=["todo_toggle","todo_delete"] + todo data → actionSpec: { "toggleTodo": { label: "Toggle", schema: {type:"object",properties:{id:{type:"string"}},required:["id"]}, nextStep: "todo_toggle" }, "deleteTodo": {...nextStep: "todo_delete"} }
  • agentTools=[] + todo data → SAME actionSpec entries WITHOUT nextStep. The agent's next turn reads the event and reacts.
  • agentTools=[] + counter prompt → contextSpec.count only. NO actionSpec.

AGENT CAPABILITIES (catalog):
- You do NOT need to emit contract.agentCapabilities — it is populated deterministically from input.agentTools after you return.
- Focus on actionSpec entries + their optional nextStep bindings; the catalog auto-populates.

ANTI-PATTERNS — DO NOT EMIT (cross-ref linter rejects at push):
- "props" / "props.properties" as a CONTRACT field      (retired contract-side spelling — the contract field is propsSpec; the wire field on push/update is still "props" but carries VALUES, not the spec)
- "wiredTools" / "agentTools" / "clientTools" catalog names  (retired; use agentCapabilities.tools / clientCapabilities.gadgets)
- clientCapabilities.capabilities                       (retired inner key; use clientCapabilities.gadgets)
- ActionEntry.tool / ActionEntry.dispatch.kind          (retired discriminated union; use the flat nextStep field)
- mode: 'host-routed' / mode: 'agent-routed'            (retired; all actions are agent-routed)
- broadcast: { ... } as a top-level field               (retired; use streamSpec[X].source instead)`;

export function buildDecisionUserMessage(input: NegotiatorDecisionInput): string {
  const parts: string[] = [];

  // Agent's data
  if (input.agentData) {
    parts.push(`Agent's data:\n${JSON.stringify(input.agentData, null, 2)}`);
  }
  if (input.agentPrompt) {
    parts.push(`Agent's hint: "${input.agentPrompt}"`);
  }
  if (input.agentContext) {
    const ctx =
      typeof input.agentContext === 'string'
        ? input.agentContext
        : JSON.stringify(input.agentContext);
    parts.push(`Agent's context: ${ctx}`);
  }

  // Session state
  const { sessionState } = input;
  if (sessionState.stack.length > 0) {
    const stackSummary = sessionState.stack
      .map(
        (item) =>
          `  [${item.id}] ${item.prompt ?? 'no prompt'}`,
      )
      .join('\n');
    parts.push(`Current UI stack (${sessionState.stack.length} items):\n${stackSummary}`);
  } else {
    parts.push('Current UI stack: empty');
  }

  if (sessionState.conversationHistory.length > 0) {
    const recent = sessionState.conversationHistory.slice(-5);
    parts.push(
      `Recent conversation:\n${recent.map((t) => `  ${t.role}: ${t.content}`).join('\n')}`,
    );
  }

  // Agent tools — MCP tools the agent invokes; component never calls these.
  // When tools ARE listed, prefer binding matching actionSpec entries to them
  // via `nextStep`. When tools are absent BUT the data implies interactivity,
  // still declare actionSpec — events drain via ggui_consume on the next turn.
  if (input.agentTools?.length) {
    parts.push(
      `Agent-side MCP tools (bind matching actionSpec entries' nextStep to these names; the agent invokes the tool on its next turn):\n` +
        input.agentTools.map((t) => `  • ${t}`).join('\n'),
    );
  } else {
    parts.push(
      `Agent-side MCP tools: none declared. If the data implies interactivity (items with id + mutable fields, draft submissions, deletions of agent-owned rows), STILL declare actionSpec entries — just omit nextStep. The agent's next turn drains events via ggui_consume and reacts.`,
    );
  }

  // Client-side gadget catalog — browser-capability hooks AND
  // operator-registered 3rd-party plugins (Leaflet, Mapbox, Stripe, …)
  // the runtime can serve for this app. Declare bindings under
  // `clientCapabilities.gadgets` ONLY when the produced UI actually
  // imports the hook.
  //
  // Routes through {@link composeAvailableGadgetsSection} so the
  // decision LLM sees the same teaching text the synth-only path
  // does — `description` (what), `usage` (when), with bounded
  // per-entry + total budget. Both the decision path and the
  // synth-only path share this one composer, so they agree on what
  // the LLM is told about each gadget.
  if (input.gadgets?.length) {
    // `composeAvailableGadgetsSection` is component-aware — it
    // flattens the package-keyed `GadgetDescriptor[]` catalog itself
    // and renders hook AND component exports with their render idiom
    // (call vs JSX) + package name. No pre-filter / pre-flatten here.
    const gadgetsSection = composeAvailableGadgetsSection(input.gadgets);
    if (gadgetsSection !== undefined) {
      // Suffix the binding rule the previous flat-loop carried — the
      // composer's section header doesn't say "declare under
      // clientCapabilities.gadgets"; preserve that authoring nudge
      // for the LLM. The permission column is intentionally dropped
      // from the LLM's view: the operator's `App.gadgets`
      // catalog still owns permission policy at registration time and
      // push-time enrichment merges it back in.
      parts.push(
        `${gadgetsSection}\n\nDeclare each chosen gadget under clientCapabilities.gadgets[<packageName>][<exportName>] = {} — the package name keys the outer map, the export name (use-prefixed hook or PascalCase component) keys the inner map. Declare ONLY when the produced UI imports the export.`,
      );
    }
  }

  // Blueprint candidates (with contract + intents when available)
  if (input.blueprintCandidates.length > 0) {
    const candidates = input.blueprintCandidates
      .map((c) => {
        let line = `  [${c.blueprintId}] ${c.description} (${c.verdict}, ${Math.round(c.similarity * 100)}% match)`;
        line += ` — REUSE = instant render, CREATE NEW = 20s wait`;
        if (c.contract) {
          line += `\n    contract: ${JSON.stringify(c.contract)}`;
        }
        return line;
      })
      .join('\n');
    parts.push(`Blueprint candidates (reuse any of these for instant render):\n${candidates}`);
  } else {
    parts.push('Blueprint candidates: none (no cached components — "create" will generate new)');
  }

  return parts.join('\n\n');
}

/**
 * Tool schema for structured decision output.
 *
 * Matches @ggui-ai/protocol's NegotiatorDecision + DataContract types.
 * Uses forced tool_choice to guarantee valid JSON output from the LLM.
 *
 * Module-internal — intentionally NOT exported. See the public-surface
 * section of the top docstring.
 */
const DECISION_TOOL = {
  name: 'ui_decision',
  description: 'Output the UI decision with a full data contract.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'compose', 'replace'],
        description:
          'What to do: create (new UI), update (swap data), compose (add to stack), replace (swap UI type)',
      },
      reasoning: { type: 'string', description: 'Brief explanation' },
      blueprintId: {
        type: 'string',
        description: 'Blueprint ID from candidates to reuse. Omit to generate new.',
      },
      contract: {
        type: 'object',
        description: 'Data contract — defines the UI shape and the four wire surfaces (propsSpec / actionSpec / contextSpec / streamSpec)',
        properties: {
          intent: {
            type: 'string',
            description:
              'Concise reusable purpose — e.g. "Display weather conditions". Same intent = cached component.',
          },
          propsSpec: {
            type: 'object',
            description: 'Props contract — initial render data',
            properties: {
              description: { type: 'string', description: 'What this data represents' },
              properties: {
                type: 'object',
                description:
                  'Per-prop definitions keyed by name. Each: { description, schema: { type }, required, example }',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    schema: { type: 'object', properties: { type: { type: 'string' } } },
                    required: { type: 'boolean' },
                    example: {},
                  },
                },
              },
            },
          },
          actionSpec: {
            type: 'object',
            description:
              'Action contract — flat map keyed by actionId. Each value describes one user-interaction event the UI can emit. Every action is agent-routed. Optional "nextStep" names the MCP tool the AGENT should invoke on its next turn after the event fires.',
            additionalProperties: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                label: { type: 'string', description: 'Button label' },
                schema: { type: 'object' },
                icon: { type: 'string', description: 'Icon hint (emoji or name)' },
                nextStep: {
                  type: 'string',
                  description: 'MCP tool name the agent SHOULD call after the user fires this action (must appear in agentCapabilities.tools).',
                },
              },
            },
          },
          streamSpec: {
            type: 'object',
            description:
              'Stream contract — flat map keyed by channel name. Declares typed live channels the component consumes. Each value is a StreamChannelEntry describing schema + optional source.tool (the agent-tool name whose deliveries feed this channel).',
            additionalProperties: { type: 'object' },
          },
        },
        required: ['intent'],
      },
      targetStackItemId: {
        type: 'string',
        description: 'Page to target (update/replace actions)',
      },
      adaptations: {
        type: 'object',
        description: 'UI adaptations based on device/context',
        properties: {
          fontSize: { type: 'string', enum: ['compact', 'default', 'large'] },
          density: { type: 'string', enum: ['dense', 'default', 'spacious'] },
          complexity: { type: 'string', enum: ['simplified', 'default', 'detailed'] },
        },
      },
    },
    required: ['action', 'reasoning', 'contract'],
  },
};

/** Make the UI decision via one LLM call with all context. */
export async function makeDecision(
  input: NegotiatorDecisionInput,
  llmCaller: LLMCaller,
): Promise<{ decision: NegotiatorDecision; alternatives: NegotiatorAlternative[] }> {
  const userMessage = buildDecisionUserMessage(input);

  // Prefer structured output (tool use) — guaranteed valid JSON
  if (llmCaller.callStructured) {
    try {
      const parsed = await llmCaller.callStructured<NegotiatorDecision>(
        DECISION_SYSTEM_PROMPT,
        userMessage,
        DECISION_TOOL,
        2048,
      );
      return {
        decision: {
          action: parsed.action ?? 'create',
          reasoning: parsed.reasoning ?? 'Structured output',
          blueprintId: parsed.blueprintId ?? undefined,
          contract: mergeGadgets(
            mergeAgentCapabilities(
              { ...parsed.contract },
              input.agentTools,
            ),
            input.gadgets,
          ),
          targetStackItemId: parsed.targetStackItemId ?? undefined,
          adaptations: parsed.adaptations ?? undefined,
        },
        alternatives: [],
      };
    } catch (err) {
      console.warn(
        '[decision] Structured output failed, falling back to text:',
        (err as Error).message,
      );
    }
  }

  // Fallback: regex JSON extraction from raw text
  const raw = await llmCaller.call(DECISION_SYSTEM_PROMPT, userMessage, 2048);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { decision: buildFallbackDecision(input), alternatives: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as NegotiatorDecision;
    return {
      decision: {
        action: parsed.action ?? 'create',
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        blueprintId: parsed.blueprintId ?? undefined,
        contract: mergeGadgets(
          mergeAgentCapabilities(
            { ...parsed.contract },
            input.agentTools,
          ),
          input.gadgets,
        ),
        targetStackItemId: parsed.targetStackItemId ?? undefined,
        adaptations: parsed.adaptations ?? undefined,
      },
      alternatives: [],
    };
  } catch {
    return { decision: buildFallbackDecision(input), alternatives: [] };
  }
}

/**
 * Deterministically populate `contract.agentCapabilities.tools` from
 * `input.agentTools`.
 *
 * The LLM decides which agent tools become user-triggered actions
 * (`actionSpec[*].nextStep`), but the contract-level catalog — the
 * canonical list of tool names the agent MAY invoke — is a superset
 * of the input and not something the LLM needs to restate. Populating
 * it here closes the gap where the contract under-declared its
 * agent-tool surface.
 *
 * Merge behavior:
 * - If the LLM returned a `contract.agentCapabilities`, union its entries with input names.
 * - Input-only names get a minimal `AgentToolEntry` (description only).
 * - LLM-declared entries are preserved verbatim (may carry richer schema metadata).
 */
function mergeAgentCapabilities(
  contract: DataContract,
  inputAgentTools: string[] | undefined,
): DataContract {
  if (!inputAgentTools?.length && !contract.agentCapabilities) return contract;
  const existing = contract.agentCapabilities?.tools ?? {};
  const merged: Record<string, { description?: string }> = { ...existing };
  for (const name of inputAgentTools ?? []) {
    if (!merged[name]) {
      merged[name] = { description: `Agent-provided MCP tool: ${name}` };
    }
  }
  const spec: AgentCapabilitiesSpec = {
    tools: merged,
  };
  return { ...contract, agentCapabilities: spec };
}

/**
 * Deterministically enrich `contract.clientCapabilities.gadgets` from
 * the per-app gadget catalog (`app.gadgets`).
 *
 * Per-app `gadgets` declares which browser-capability gadgets the
 * runtime can serve for the app. The LLM authors a per-contract subset
 * (only the gadgets the produced UI actually uses) on the
 * package-keyed wire map (`Record<package, Record<exportName,
 * GadgetExportUse>>`), but partial entries (no `description` / `usage`
 * override) are common — this merge fills in the canonical teaching
 * text from the app catalog.
 *
 * Merge behavior:
 * - Each wire `(package, exportName)` use that resolves to an
 *   app-catalog export inherits the registered export's
 *   `description` / `usage` (when the wire use didn't override them).
 * - Wire uses that do NOT resolve to any app-catalog export are
 *   preserved verbatim (the app may carry a third-party gadget the
 *   catalog passed in here doesn't include).
 * - The contract's set of declared `(package, export)` uses stays
 *   exactly what the LLM authored — we don't append every app-catalog
 *   export, since the contract only declares what the produced UI
 *   references.
 * - LLM-authored fields win on conflict (operator may have authored a
 *   richer description/usage for the use at this specific call site).
 *
 * Identity keying routes through `gadgetIdentityKey` so the merge
 * agrees byte-for-byte with the push-time gates on what "the same
 * gadget export" means.
 */
function mergeGadgets(
  contract: DataContract,
  appGadgets: readonly GadgetDescriptor[] | undefined,
): DataContract {
  if (!appGadgets?.length || !contract.clientCapabilities?.gadgets) {
    return contract;
  }
  // Index every registered export by its `(name, package)` identity
  // tuple. A descriptor-side `GadgetExport` carries no package
  // identity, so combine `gadgetExportName(exp)` with the descriptor's
  // own `package` to form the key the wire side keys by too.
  const byExport = new Map<string, GadgetExport>();
  for (const pkg of appGadgets) {
    for (const exp of pkg.exports) {
      byExport.set(
        gadgetIdentityKey({
          name: gadgetExportName(exp),
          package: pkg.package,
        }),
        exp,
      );
    }
  }
  const enriched: Record<string, GadgetPackageUse> = {};
  for (const [pkgName, packageUse] of Object.entries(
    contract.clientCapabilities.gadgets,
  )) {
    const enrichedPackage: Record<string, GadgetExportUse> = {};
    for (const [exportName, use] of Object.entries(packageUse)) {
      const canonical = byExport.get(
        gadgetIdentityKey({ name: exportName, package: pkgName }),
      );
      if (canonical) {
        enrichedPackage[exportName] = {
          // Registered export's teaching text as the base...
          ...(canonical.description !== undefined
            ? { description: canonical.description }
            : {}),
          ...(canonical.usage !== undefined ? { usage: canonical.usage } : {}),
          // ...then the wire use — LLM-authored fields win on conflict.
          ...use,
        };
      } else {
        enrichedPackage[exportName] = use;
      }
    }
    enriched[pkgName] = enrichedPackage;
  }
  return {
    ...contract,
    clientCapabilities: { gadgets: enriched },
  };
}

function buildFallbackDecision(input: NegotiatorDecisionInput): NegotiatorDecision {
  const props = input.agentData
    ? Object.fromEntries(
        Object.entries(input.agentData).map(([key, value]) => [
          key,
          {
            description: key,
            schema: { type: inferType(value) as 'string' },
            required: true,
            example: value as JsonValue,
          },
        ]),
      )
    : {};

  const contract: DataContract = {
    propsSpec: { properties: props },
  };

  return {
    action: 'create',
    reasoning: 'Fallback: creating new UI (decision LLM failed to parse)',
    contract: mergeGadgets(
      mergeAgentCapabilities(contract, input.agentTools),
      input.gadgets,
    ),
  };
}

function inferType(value: unknown): string {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object' && value !== null) return 'object';
  return 'string';
}
