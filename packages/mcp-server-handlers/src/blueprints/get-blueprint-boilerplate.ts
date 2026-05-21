/**
 * `ggui_get_blueprint_boilerplate` — scaffolded TSX source tailored to a
 * caller-supplied DataContract. A composition aid for agents that
 * author UI source by hand.
 *
 * Pure compute, no database, no network. Wraps `generateBoilerplate`
 * from `@ggui-ai/ui-gen/boilerplate` — the same composer the
 * generation pipeline uses internally for first-attempt scaffolding
 * (`buildSystemPrompt` relies on the same primitive). Returns a
 * `.tsx` string that compiles
 * out of the box: typed `Props` derived from `contract.propsSpec`, action
 * handler stubs from `contract.actionSpec`, stream wiring from
 * `contract.streamSpec`, and primitives pre-imported.
 *
 * Workflow guidance lives in the tool description — Claude is expected
 * to call this AFTER `ggui_validate_data_contract` (when that ships in
 * the next sub-slice) and BEFORE `ggui_protocol_validate_blueprint`. The contract
 * is the load-bearing input: a richer contract → a more complete scaffold.
 */
import { z } from 'zod';
import {
  generateBoilerplate,
  type ScreenSize,
  type ShellType,
} from '@ggui-ai/ui-gen/boilerplate';
import type { DataContract } from '@ggui-ai/protocol';
import type { SharedHandler } from '../types.js';

const inputSchema = {
  contract: z
    .unknown()
    .describe(
      'DataContract envelope: `{ propsSpec?, actionSpec?, contextSpec?, streamSpec?, agentCapabilities?, clientCapabilities? }`. The composer derives typed `Props`, action handler stubs, and stream subscriptions from this. Required — pass an empty object `{}` only if you genuinely want a propless component.',
    ),
  intent: z
    .string()
    .optional()
    .describe(
      'Optional natural-language hint about what the component should do (e.g. "kanban board with drag-drop"). Currently informational — the composer is contract-driven; intent affects axis-composed sections in the future.',
    ),
  shell: z
    .enum(['chat', 'fullscreen', 'spatial'])
    .default('fullscreen')
    .describe(
      'Container shell. `chat` = inline 300-600px (Claude Desktop side panel). `fullscreen` = 100vh dashboard. `spatial` = AR/VR. Defaults to `fullscreen`.',
    ),
  screen: z
    .enum(['mobile', 'tablet', 'desktop', 'universal'])
    .default('universal')
    .describe(
      'Target device size. `universal` works across all viewports; pick a specific value when the layout is opinionated.',
    ),
};

const outputSchema = {
  source: z.string().describe('TSX source ready to compile + render.'),
};

interface GetBlueprintBoilerplateOutput {
  readonly source: string;
}

export function createGetBlueprintBoilerplateHandler(): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  GetBlueprintBoilerplateOutput
> {
  return {
    name: 'ggui_protocol_get_blueprint_boilerplate',
    title: 'Get blueprint boilerplate',
    audience: ['protocol'],
    description:
      "Generate a scaffolded TSX source tailored to a DataContract — typed `Props`, action handler stubs, stream subscriptions, and primitives pre-imported. Compiles out of the box; pass it back through `ggui_protocol_validate_blueprint` to confirm. The contract is the load-bearing input: a richer contract (more props/actions/streams) yields a more complete scaffold. Pass `shell` (`chat` for Claude Desktop side panels, `fullscreen` for dashboards) and `screen` (`mobile` / `desktop` / `universal`) to bias the layout. Workflow: define your contract → call this → modify the source for user intent → `ggui_protocol_validate_blueprint` → `ggui_ops_generate_blueprint`. Same composer path-(a) uses internally so server + agent path see identical scaffolds.",
    inputSchema,
    outputSchema,
    async handler(rawInput: Record<string, unknown>) {
      const parsed = z.object(inputSchema).parse(rawInput);
      const contract = parsed.contract as DataContract;
      const source = generateBoilerplate(
        parsed.intent ?? '',
        contract,
        parsed.shell as ShellType,
        parsed.screen as ScreenSize,
      );
      return { source };
    },
  };
}
