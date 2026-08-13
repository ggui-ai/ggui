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
 *
 * `code` vocabulary:
 *
 *   - `PRODUCTION_FAILED` — the generation pipeline ran but did not
 *     produce a component.
 *   - `COMPILATION_ERROR` — produced code failed to compile. Maps to
 *     the canonical `PRODUCTION_FAILED` on the render failure envelope
 *     (it is a finer-grained production failure, not a distinct wire
 *     class).
 *   - `VALIDATION_ERROR` — an input/config precondition rejected the
 *     generation before the LLM was called.
 *   - `NO_PLATFORM_KEY` — the server's managed provider-key
 *     configuration has no key for the resolved route.
 *   - `NO_CREDENTIALS` — no generation credentials are configured on
 *     the server.
 *   - `GENERATION_QUEUE_OVERLOADED` — the deployment's generation
 *     admission gate rejected this request before any generation
 *     attempt started (its concurrent-request queue was full, or the
 *     wait for a free slot exceeded the configured timeout). Contract
 *     (protocol-and-contract-bar): the deployment (party A) promises
 *     the caller (party B) that this code is emitted ONLY when
 *     generation never began — never as a relabeling of a genuine
 *     production failure. Callers MUST NOT bill or count this as a
 *     failed generation attempt; a caller that retries MAY do so
 *     immediately (no generation attempt was made — re-handshake first,
 *     since the handshake that led here was already consumed like
 *     every other Plane-3 failure). Violation is observable:
 *     a deployment that folds an admission shed into
 *     `PRODUCTION_FAILED` (or vice versa) breaks this promise and a
 *     caller relying on the distinction will mis-bill or mis-count.
 *
 * The other five map 1:1 onto the render failure envelope's canonical
 * codes (`renderErrorCodeSchema` in `schemas/mcp.ts`); `COMPILATION_ERROR`
 * is the sole exception (folds into `PRODUCTION_FAILED` on the wire, per
 * above).
 */
export interface GenerationError {
  code:
    | 'PRODUCTION_FAILED'
    | 'COMPILATION_ERROR'
    | 'VALIDATION_ERROR'
    | 'NO_PLATFORM_KEY'
    | 'NO_CREDENTIALS'
    | 'GENERATION_QUEUE_OVERLOADED';
  message: string;
  /** Additional diagnostic information. Typed as {@link JsonValue} (any JSON-safe value). */
  details?: JsonValue;
}
