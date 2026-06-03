/**
 * `ggui_describe_data_contract_format` — wire-format documentation for
 * the DataContract envelope inside an AgentBlueprint.
 *
 * Pure compute, no DDB. Returns markdown explainer + 2-3 examples
 * covering common shapes (display-only / collect-form / chat).
 * Pinning the format server-side guards against contract drift between
 * what Claude composes and what `ggui_protocol_validate_blueprint` expects.
 */
import { z } from 'zod';
import type { SharedHandler } from '../types.js';

const inputSchema = {};

const outputSchema = {
  format: z.literal('DataContract'),
  documentation: z.string(),
  examples: z.array(
    z.object({
      title: z.string(),
      contract: z.record(z.string(), z.unknown()),
    }),
  ),
};

interface DescribeDataContractFormatOutput {
  readonly format: 'DataContract';
  readonly documentation: string;
  readonly examples: ReadonlyArray<{
    readonly title: string;
    readonly contract: Record<string, unknown>;
  }>;
}

const DOCUMENTATION = `# DataContract format

Top-level shape on every blueprint's \`contract\` field:

\`\`\`ts
interface DataContract {
  /** Initial render data — the props the component receives. */
  propsSpec?: PropsSpec;

  /** User-interaction events — flat map keyed by action name. */
  actionSpec?: ActionSpec;

  /** Observable client state — flat map keyed by slot name. */
  contextSpec?: ContextSpec;

  /** Live update payloads — flat map keyed by stream channel name. */
  streamSpec?: StreamSpec;

  /** Read-only catalog: MCP tools the AGENT may invoke. Referenced
   *  from actionSpec[*].nextStep and streamSpec[*].source.tool. The
   *  component NEVER calls these. */
  agentCapabilities?: AgentCapabilitiesSpec;

  /** Read-only catalog: browser-capability gadget hooks the COMPONENT
   *  imports (useGeolocation, useCamera, useClipboardWrite, …).
   *  Values reach the agent only when threaded into a contextSpec
   *  slot or an actionSpec payload. */
  clientCapabilities?: ClientCapabilitiesSpec;
}
\`\`\`

\`intent\` is NOT a contract field — the outer pipeline owns it
(top-level \`intent\` on the flat \`ggui_handshake\` input). The
four-spec surface — propsSpec / actionSpec / contextSpec / streamSpec
— describes the wire exhaustively. See
\`docs/principles/actions-vs-context.md\` for the placement rule on
the two inbound specs.

## PropsSpec

\`\`\`ts
interface PropsSpec {
  description?: string;
  properties: Record<string, {
    schema: JsonSchema;       // draft-07 subset: type, enum, items, properties
    required?: boolean;       // default true
    description?: string;
    default?: JsonValue;
    example?: JsonValue;
  }>;
}
\`\`\`

The boilerplate generator turns each \`properties\` entry into a typed
TypeScript field on \`Props\`. \`required: false\` becomes \`field?:\`.
\`schema.nullable: true\` becomes \`| null\`.

## ActionSpec entry

\`\`\`ts
interface ActionEntry {
  /** Human label — drives button copy / accessibility name. */
  label?: string;
  description?: string;
  /** Optional payload schema. Action with a payload becomes useAction<T>. */
  schema?: JsonSchema;
  /** Optional example payload — surfaces in tool descriptions. */
  example?: JsonValue;
  /** Optional hint: which agentCapabilities.tools entry the agent SHOULD
   *  invoke on its next turn after this action fires. Naming the
   *  tool here does NOT route the action server-side — every action
   *  is agent-routed. The hint surfaces on the action event so the
   *  agent picks the right tool. Must appear in agentCapabilities.tools. */
  nextStep?: string;
}
\`\`\`

In the source, declare with \`const X = useAction<PayloadType>('X')\` and
fire as \`X(payload)\` (or \`X()\` when payload-less).

## StreamSpec entry

\`\`\`ts
interface StreamEntry {
  description?: string;
  /** Payload schema — every emitted event must conform. */
  schema: JsonSchema;
  /** Optional example payload. */
  example?: JsonValue;
  /** Optional source binding: agent-tool name whose deliveries feed
   *  this channel (runtime subscribes / polls). Must appear in
   *  agentCapabilities.tools. */
  source?: { tool: string };
}
\`\`\`

In the source, declare with \`const stream = useStream<PayloadType>('channel')\`
and read latest as \`stream.latest\` or iterate \`stream.history\`.

## AgentCapabilitiesSpec entry

\`\`\`ts
interface AgentCapabilitiesSpec {
  // Keyed by the bare MCP tool name (the catalog key).
  tools: Record<string, AgentToolEntry>;
}

interface AgentToolEntry {
  // Owning MCP server identity. OPTIONAL — Tier-2: derive name from the
  // mcp__<server>__ prefix (omit when absent, never invent); Tier-1:
  // agent-server fills from 'initialize'. (server, toolName) is the
  // canonical identity; version is metadata, not identity.
  serverInfo?: { name: string; version?: string };
  // MCP tool descriptor, echoed from 'tools/list' (minus name = the key).
  toolInfo: {
    inputSchema: JsonSchema; // REQUIRED — every MCP tool has one.
    description?: string;
    outputSchema?: JsonSchema;
  };
  // ggui authoring layer (not MCP): when/why/by-whom the tool is called.
  usage?: string;
  example?: { input: JsonValue; output: JsonValue };
}
\`\`\`

Pure catalog — declares tools the AGENT may invoke. Referenced from
\`actionSpec[*].nextStep\` (agent next-turn hint) and
\`streamSpec[*].source.tool\` (channel data source). The component
NEVER calls these. Cross-ref linter rejects dangling \`nextStep\` /
\`source.tool\` values that don't resolve to a key here.

Canonical-identity hints (improve reuse of UIs built by earlier
conversations or other agents):

- The map KEYS are the **bare** MCP tool name — the part AFTER any
  \`mcp__<server>__\` prefix a host prepends on its connection. Key by
  the bare name (e.g. \`todo_add\`), NOT the host's connection label or
  prefix.
- \`serverInfo.name\` identifies the owning MCP server so a UI built against
  the same \`(server, toolName)\` is reused across conversations and agents.
  Set it to the server handle from your tool's \`mcp__<server>__\` prefix —
  the SAME \`<server>\` you stripped to get the bare key (e.g.
  \`mcp__todo__todo_add\` → \`serverInfo.name: 'todo'\`). If a tool has no
  such prefix, OMIT \`serverInfo\` — never invent a name. \`version\` is
  OPTIONAL metadata (include it only if your host surfaces it); a version
  difference alone never blocks reuse.
- \`toolInfo.inputSchema\` is echoed verbatim from the tool's \`tools/list\`
  descriptor.

## ClientCapabilitiesSpec entry

\`\`\`ts
interface ClientCapabilitiesSpec {
  // Keyed by npm PACKAGE name; each value is a per-package use map.
  gadgets: Record<string, GadgetPackageUse>;
}

// One package's exports the UI uses, keyed by export NAME (>= 1).
// The export name's grammar discriminates kind: a 'use'-prefixed
// name is a hook, a PascalCase name is a component. There is no
// 'hook' / 'component' field and no 'kind' tag.
type GadgetPackageUse = Record<string, GadgetExportUse>;

interface GadgetExportUse {
  /** Intent-specific override of the registered description. */
  description?: string;
  /** Intent-specific override of the registered usage hint. */
  usage?: string;
}

// Example: a contract that uses one Leaflet component + one stdlib hook
//   gadgets: {
//     '@my-org/leaflet': { LeafletMap: {} },
//     '@ggui-ai/gadgets': { useGeolocation: {} },
//   }
\`\`\`

The wire carries IDENTITY ONLY — \`(package, export name)\`. It does
NOT carry \`version\`: the operator's \`App.gadgets\` catalog owns the
version pin. Per-export registry metadata (\`permission\`, \`example\`)
and transport fields (\`bundleUrl\`,
\`bundleSri\`, …) likewise live on the operator-registered gadget
package descriptor — NOT on the wire. The renderer resolves them
server-side from the app's gadget catalog at push time (e.g. a hook's
browser \`permission\` flows into the iframe's Permissions-Policy
directive set from there).

Pure declaration — items are React hooks the UI imports + calls. Pure
UI-side lifecycle; the agent never invokes them. Values reach the
agent only when threaded into a contextSpec slot or actionSpec
payload.

## defineContract helper (TypeScript only)

\`\`\`ts
import { defineContract } from '@ggui-ai/protocol';

export const myContract = defineContract({
  propsSpec: { ... },
  actionSpec: { ... },
} as const);
\`\`\`

\`defineContract\` is a TypeScript-only helper — at runtime it returns
its argument unchanged. Always pair with \`as const\` so prop+action
names propagate as literal-typed strings into \`useAction<T>(name)\` and
\`useStream<T>(name)\` for autocomplete on the consumer side.`;

const EXAMPLES = [
  {
    title: 'Display-only — no actions, no stream',
    contract: {
      propsSpec: {
        properties: {
          city: { schema: { type: 'string' }, required: true },
          tempC: { schema: { type: 'number' }, required: true },
          condition: {
            schema: { type: 'string', enum: ['sunny', 'cloudy', 'rainy'] },
            required: true,
          },
        },
      },
    },
  },
  {
    title: 'Collect-form — props + submit action with payload',
    contract: {
      propsSpec: {
        properties: {
          placeholder: { schema: { type: 'string' }, required: false, default: 'New task' },
        },
      },
      actionSpec: {
        submit: {
          label: 'Add task',
          description: 'User submitted a new task title.',
          schema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
        },
        cancel: {
          label: 'Cancel',
          description: 'User dismissed without submitting.',
        },
      },
    },
  },
  {
    title: 'Live chat — initial messages prop + stream + send action',
    contract: {
      propsSpec: {
        properties: {
          messages: {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'agent'] },
                  text: { type: 'string' },
                },
              },
            },
            required: true,
          },
        },
      },
      streamSpec: {
        agentReply: {
          description: 'Token-by-token agent response.',
          schema: { type: 'object', properties: { delta: { type: 'string' } } },
        },
      },
      actionSpec: {
        send: {
          label: 'Send',
          schema: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
    },
  },
];

export function createDescribeDataContractFormatHandler(): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  DescribeDataContractFormatOutput
> {
  return {
    name: 'ggui_protocol_describe_data_contract_format',
    title: 'Describe data contract format',
    audience: ['protocol'],
    description:
      "Returns the wire-format spec for the DataContract envelope — the `contract` field inside an AgentBlueprint. Covers PropsSpec / ActionSpec / StreamSpec / AgentCapabilitiesSpec / ClientCapabilitiesSpec sub-shapes, the `defineContract({...} as const)` TypeScript helper, and three worked examples (display-only / collect-form / converse-stream). Call this alongside `ggui_protocol_describe_blueprint_format` when composing a blueprint in a fresh conversation. Then call `ggui_protocol_get_blueprint_boilerplate({ contract })` for a typed scaffold.",
    inputSchema,
    outputSchema,
    async handler() {
      return {
        format: 'DataContract' as const,
        documentation: DOCUMENTATION,
        examples: EXAMPLES,
      };
    },
  };
}
