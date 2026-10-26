/**
 * AUTO-GENERATED from @ggui-ai/design JSDoc: every prop tagged `@revealedBy <axis>=<value>`, with its whole
 * docblock. Do not edit manually. Run: pnpm --filter @ggui-ai/design generate:docs-ts
 *
 * These props are absent from the component reference; the prompt fragment for their axis value teaches them
 * (fragments/index.ts), so each lives in exactly one place.
 */
import type { RevealedProp } from "./types.js";

export const REVEALED_PROPS: readonly RevealedProp[] = [
  {
    "axis": "choice",
    "value": "offered-items",
    "prop": "maxRows?",
    "type": "number",
    "components": [
      "Stack",
      "Row"
    ],
    "description": "Wrapping rows only: at most this many rows, whole children only, the rest hidden. A group of quick-reply chips is `<Row wrap maxRows={3}>`."
  }
];
