/**
 * `@ggui-ai/preview-a2ui/emitters` — reference producers for the
 * provisional preview pipeline.
 *
 * V1 ships a deterministic producer (`produceDeterministicPreview`
 * + `createDeterministicPreviewEmitter`) that makes the server
 * orchestration path real without requiring a fast-model LLM. A
 * future fast-model-backed producer can layer onto the same contract.
 *
 * Keeping producers in a dedicated subpath lets consumers import
 * exactly the bundle they need — hosted pods pulling a Haiku
 * producer don't pay for the deterministic one, and vice-versa.
 */
export {
  createDeterministicPreviewEmitter,
  produceDeterministicPreview,
  type DeterministicPreviewContext,
  type DeterministicPreviewOptions,
} from './deterministic';
