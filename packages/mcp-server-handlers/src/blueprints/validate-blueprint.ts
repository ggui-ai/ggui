/**
 * `ggui_validate_blueprint` — sequential gated blueprint validator.
 *
 * Pure compute, no database, no network. Wraps the canonical
 * `validateBlueprint()` orchestrator from `@ggui-ai/ui-gen/blueprint-validator`
 * — the same code a cloud deployment's blueprint-validation and
 * blueprint-registration paths re-run server-side as
 * defense-in-depth. Runs three tiers in order with short-circuit:
 *
 *   1. compile      — esbuild transform of source.tsx
 *   2. selfCheck    — minimal contract+source coherence checks
 *   3. runtime      — `DEFAULT_RUNTIME_RENDER_CHECK` in happy-dom
 *
 * Surfaces the result envelope as-is so Claude can read `failedAt` to
 * know which tier stopped, then iterate. Cost on a passing blueprint
 * with a contract: ~100-300ms cold, ~50ms warm.
 */
import { z } from 'zod';
import {
  validateBlueprint,
  type ValidationResult,
} from '@ggui-ai/ui-gen/blueprint-validator';
import type { SharedHandler } from '../types.js';

const inputSchema = {
  source: z
    .string()
    .min(1)
    .describe(
      'TSX source for the React component. Must `export default` a component. Receives `props` typed by the contract.',
    ),
  contract: z
    .unknown()
    .optional()
    .describe(
      "DataContract envelope (propsSpec / actionSpec / contextSpec / streamSpec / agentCapabilities / clientCapabilities). Optional — without it, the runtime probe skips with a `runtime:skipped-no-contract` warning since there's nothing to verify.",
    ),
  fixtureProps: z
    .unknown()
    .optional()
    .describe(
      "Optional concrete props to render with. When omitted, the probe synthesizes mockup props from the contract's prop schema.",
    ),
};

const outputSchema = {
  valid: z.boolean(),
  failedAt: z.enum(['compile', 'selfCheck', 'runtime']).nullable(),
  errors: z.array(
    z.object({
      tier: z.enum(['compile', 'selfCheck', 'runtime']),
      code: z.string(),
      message: z.string(),
      fix: z.string().optional(),
    }),
  ),
  warnings: z.array(
    z.object({
      tier: z.enum(['compile', 'selfCheck', 'runtime']),
      code: z.string(),
      message: z.string(),
      fix: z.string().optional(),
    }),
  ),
};

export function createValidateBlueprintHandler(): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  ValidationResult
> {
  return {
    name: 'ggui_protocol_validate_blueprint',
    title: 'Validate blueprint',
    audience: ['protocol'],
    description:
      'Run the 3-tier sequential gated validator (compile → self-check → runtime probe) over a candidate blueprint. Short-circuits on the first failure — read `failedAt` to know which tier stopped. Compile errors are syntax/imports; self-check errors are missing default-export or contract/source drift; runtime errors are real wiring bugs (action declared but no clickable trigger; useStream subscribed but never read; clientTool not registered). Iterate until `valid: true`, then call `ggui_ops_generate_blueprint` — that path re-runs the same validator and rejects anything that fails.',
    inputSchema,
    outputSchema,
    async handler(rawInput: Record<string, unknown>) {
      const parsed = z.object(inputSchema).parse(rawInput);
      return validateBlueprint({
        blueprint: {
          source: parsed.source,
          contract: parsed.contract,
          fixtureProps: parsed.fixtureProps,
        },
      });
    },
  };
}
