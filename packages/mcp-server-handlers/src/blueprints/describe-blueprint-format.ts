/**
 * `ggui_describe_blueprint_format` — wire-format documentation for the
 * blueprint envelope `ggui_ops_generate_blueprint` and `ggui_protocol_validate_blueprint`
 * accept.
 *
 * Pure compute, no DDB. Returns a markdown explainer + a minimum-viable
 * example. Pinning the format server-side guards against Claude
 * composing from stale training-data assumptions about the shape.
 */
import { z } from 'zod';
import type { SharedHandler } from '../types.js';

const inputSchema = {};

const outputSchema = {
  format: z.literal('AgentBlueprint'),
  documentation: z.string(),
  example: z.record(z.string(), z.unknown()),
};

interface DescribeBlueprintFormatOutput {
  readonly format: 'AgentBlueprint';
  readonly documentation: string;
  readonly example: Record<string, unknown>;
}

const DOCUMENTATION = `# AgentBlueprint format

The wire shape every blueprint authoring tool consumes:

\`\`\`ts
interface AgentBlueprint {
  /** TSX source for the React component. MUST \`export default\` a component. */
  source: string;

  /**
   * DataContract envelope describing the component's wire surface
   * (propsSpec / actionSpec / contextSpec / streamSpec /
   * agentCapabilities / clientCapabilities). Optional — without it,
   * the runtime probe
   * skips and you only get compile + self-check tier validation.
   * Strongly recommended. Get the full contract format via
   * \`ggui_protocol_describe_data_contract_format\`.
   */
  contract?: DataContract;

  /**
   * Optional concrete props to render with during the runtime probe.
   * Must match \`contract.propsSpec\` shape. Defaults to mockup props
   * synthesized from the prop schema when omitted.
   */
  fixtureProps?: Record<string, JsonValue>;
}
\`\`\`

## Field semantics

- **\`source\`** is plain TSX — no preamble, no markdown fence.
  Imports allowed: \`react\`, \`@ggui-ai/design/primitives\`,
  \`@ggui-ai/design/components\`, \`@ggui-ai/design/compositions\`.
  No external libraries, no \`fetch\`, no \`eval\`.
- **\`contract\`** is the same object \`defineContract({ ... } as const)\`
  produces in path-(a) generation. Pass the literal — \`defineContract\`
  is a TypeScript-only inference helper, not a runtime transform.
- **\`fixtureProps\`** is informational for the probe. It does NOT ride
  onto the persisted blueprint — the user's runtime data fills props
  at render time.

## Composition workflow

1. Call \`ggui_protocol_describe_data_contract_format\` to learn the contract shape.
2. Compose your contract object.
3. Call \`ggui_protocol_get_blueprint_boilerplate({ contract, intent?, shell?, screen? })\`
   for a typed scaffold.
4. Modify the source for user intent.
5. Call \`ggui_protocol_validate_blueprint({ source, contract, fixtureProps? })\` —
   iterate until \`valid: true\`.
6. Call \`ggui_ops_generate_blueprint({ name, blueprint, description?, tags? })\`.

## Validation tiers

\`ggui_protocol_validate_blueprint\` runs three tiers in order, short-circuiting on
the first failure:

| Tier | Check | What fails |
|------|-------|------------|
| 1 | \`compile\` | esbuild transform — syntax / import errors |
| 2 | \`selfCheck\` | default-export presence + prop coverage |
| 3 | \`runtime\` | happy-dom probe — action wiring, tool calls, prop usage |

Read \`failedAt\` on the result to know which tier stopped.`;

const EXAMPLE = {
  source: `import { Card, Stack, Text, Button } from '@ggui-ai/design/primitives';
import { useAction } from '@ggui-ai/wire';

interface Props {
  greeting: string;
}

export default function Hello(props: Props) {
  const dismiss = useAction<void>('dismiss');
  return (
    <Card>
      <Stack gap={2}>
        <Text size="lg">{props.greeting}</Text>
        <Button onClick={() => dismiss()}>Dismiss</Button>
      </Stack>
    </Card>
  );
}`,
  contract: {
    propsSpec: {
      properties: {
        greeting: {
          schema: { type: 'string' },
          required: true,
          description: 'Salutation text shown in the card.',
        },
      },
    },
    actionSpec: {
      dismiss: {
        label: 'Dismiss',
        description: 'User dismissed the greeting.',
      },
    },
  },
  fixtureProps: {
    greeting: 'Hello, world',
  },
};

export function createDescribeBlueprintFormatHandler(): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  DescribeBlueprintFormatOutput
> {
  return {
    name: 'ggui_protocol_describe_blueprint_format',
    title: 'Describe blueprint format',
    audience: ['protocol'],
    description:
      "Returns the wire-format spec for the AgentBlueprint envelope — the shape `ggui_protocol_validate_blueprint` and `ggui_ops_generate_blueprint` accept. Includes field semantics, the composition workflow (which tools to call in what order), the three validation tiers, and a minimum-viable example. **Call this first** when composing a blueprint in a fresh conversation, alongside `ggui_protocol_describe_data_contract_format` for the contract sub-shape. Tools you'll then call: `ggui_protocol_get_blueprint_boilerplate` (scaffold) → `ggui_protocol_validate_blueprint` (check) → `ggui_ops_generate_blueprint` (save).",
    inputSchema,
    outputSchema,
    async handler() {
      return {
        format: 'AgentBlueprint' as const,
        documentation: DOCUMENTATION,
        example: EXAMPLE,
      };
    },
  };
}
