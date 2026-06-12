import type {
  DataContract,
  JsonObject,
  JsonSchema,
  JsonValue,
} from './data-contract';

/**
 * Request to generate a UI component.
 * Generic `TContext` defaults to {@link JsonObject} for generator context hints.
 */
export interface UIGenerationRequest<TContext = JsonObject> {
  sessionId: string;
  prompt: string;
  context?: TContext;
  schema?: JsonSchema;
}

/**
 * Internal response from UI generation. This is the GENERATOR-OUTPUT
 * shape — `componentCode` is the freshly produced ESM string. Before
 * the render commits to the wire, the slice-meta derivation
 * uploads the code body and projects `codeUrl` (a fetchable URL) onto
 * the `ai.ggui/render` slice instead of inlining the source.
 * Iframe runtimes fetch the code from `codeUrl`; they never see this
 * field.
 */
export interface UIGenerationResponse {
  sessionId: string;
  componentCode: string;
  sourceCode?: string;
  warnings?: string[];
  /**
   * Data contract the generated component conforms to.
   *
   * Populated by the generator when the component calls wire hooks
   * (`useAction('name')`, `useStream('channel')`) — the generator
   * extracts the call sites and emits a matching authoring-side
   * envelope so downstream consumers (`ggui_render` → GguiSession,
   * console inspectors) have the contract available.
   *
   * - When the caller supplied `UiGenerateInput.contract` that
   *   envelope is passed through as-is (already authoritative).
   * - When the caller didn't supply a contract but the generated code
   *   uses wire hooks, the generator synthesizes a MINIMAL envelope:
   *   `actionSpec[name] = {label: name}` and
   *   `streamSpec[channel] = {schema: {type: 'object'}}`. Enough for
   *   the receiver to know the surface exists; callers who need
   *   richer metadata (labels, schemas, nextStep hints) should
   *   author the contract themselves and pass it on input.
   * - When no wire hooks are used, this field stays absent.
   */
  contract?: DataContract;
}

/**
 * Error during UI generation.
 * The `details` field is {@link JsonValue} to carry any JSON-safe diagnostic data.
 */
export interface GenerationError {
  code: 'PRODUCTION_FAILED' | 'COMPILATION_ERROR' | 'VALIDATION_ERROR';
  message: string;
  /** Additional diagnostic information. Typed as {@link JsonValue} (any JSON-safe value). */
  details?: JsonValue;
}
