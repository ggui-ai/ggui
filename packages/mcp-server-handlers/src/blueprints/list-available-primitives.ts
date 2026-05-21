/**
 * `ggui_list_available_primitives` — TypeScript-format reference for
 * every primitive Claude can import in a blueprint source.tsx.
 *
 * Returns the canonical `PRIMITIVES_DOCUMENTATION_TS` block from
 * `@ggui-ai/ui-gen/tools/get-primitives-ts`. Same documentation
 * string the path-(a) generator threads into its system prompt — keeps
 * Claude on the same primitive surface ggui's own LLM sees, so
 * blueprints composed via path (b) compile against the same component
 * library that path-(a) tier-0 checks validate.
 *
 * Pure compute, no DDB. Single string output; the MCP client decides
 * how to surface it. Includes critical conventions (enum string
 * literals, not CSS variables; `onChange(value)` not `onChange(event)`)
 * and the import-allowlist (`@ggui-ai/design/primitives`,
 * `/components`, `/compositions`).
 */
import { z } from 'zod';
import { PRIMITIVES_DOCUMENTATION_TS } from '@ggui-ai/ui-gen/tools/get-primitives-ts';
import type { SharedHandler } from '../types.js';

const inputSchema = {};

const outputSchema = {
  documentation: z
    .string()
    .describe('TypeScript-format primitive reference.'),
  importPath: z
    .string()
    .describe('Canonical import specifier — e.g. `@ggui-ai/design/primitives`.'),
};

interface ListAvailablePrimitivesOutput {
  readonly documentation: string;
  readonly importPath: string;
}

export function createListAvailablePrimitivesHandler(): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  ListAvailablePrimitivesOutput
> {
  return {
    name: 'ggui_protocol_list_available_primitives',
    title: 'List available primitives',
    audience: ['protocol'],
    description:
      "Returns the TypeScript-format reference for every primitive component your blueprint source can import. Each entry has the prop signatures, enum string literals (NOT CSS variables — `<Text size=\"sm\" />` not `<Text size=\"var(--ggui-font-size-sm)\" />`), event-handler conventions (`onChange` receives the value directly, not an event), and the import-allowlist (`@ggui-ai/design/primitives`, `/components`, `/compositions` — no external libraries, no fetch, no eval). Call this when composing a fresh blueprint or when `ggui_protocol_validate_blueprint` reports a missing/unknown component import.",
    inputSchema,
    outputSchema,
    async handler() {
      return {
        documentation: PRIMITIVES_DOCUMENTATION_TS,
        importPath: '@ggui-ai/design/primitives',
      };
    },
  };
}
