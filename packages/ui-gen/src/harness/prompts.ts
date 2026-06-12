// packages/ui-gen/src/harness/prompts.ts
//
// Published `@ggui-ai/ui-gen/harness/prompts` subpath — prompt-context
// builders shared by the harness / benchmark dispatch path.
//
// The implementations live in `../contract-context.ts` (the module the
// live `createUiGenerator` path uses). This file used to carry a
// hand-maintained copy of the same builders; the copy had silently
// drifted from the canonical one (no variance block, no
// `source.tool` stream annotation, hooks-only gadget teaching), so it
// was deleted and the subpath now re-exports the canonical
// implementations. One module owns the LLM-visible strings.
export {
  buildContractsContext,
  buildRenderingContext,
  injectContracts,
  injectRenderingContext,
} from '../contract-context.js';
export type { RenderingContext } from '../contract-context.js';
