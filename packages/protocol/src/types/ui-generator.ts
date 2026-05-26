import type { EventSubscription } from './events';
import type {
  DataContract,
  JsonObject,
  JsonSchema,
  JsonValue,
} from './data-contract';

/**
 * Design system version — used as part of the cache fingerprint.
 * When tokens or primitives change, bump this to invalidate cached blueprints.
 *
 * Keep in sync with the `@ggui-ai/design` package.json version.
 */
export const DESIGN_SYSTEM_VERSION = '0.1.0';

/**
 * Inputs for computing a style fingerprint.
 * The fingerprint determines cache validity for generated blueprints.
 *
 * NOTE: themeId is NOT included — theme colors are injected at render time
 * via cssOverrides, not baked into generated code.
 */
export interface StyleFingerprintInput {
  /** App's styling/generation prompt (affects component structure/layout) */
  stylingPrompt?: string;
  /** Design system preset (affects available components/tokens) */
  designSystemPreset?: string;
  /** Design system version (covers tokens, primitives, motion, everything compiled) */
  designSystemVersion: string;
}

/**
 * FNV-1a hash — a fast, non-cryptographic hash with good distribution.
 * Used for cache key fingerprinting only, not for security purposes.
 * Works in all JS runtimes (browser, Node.js, React Native).
 */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime (32-bit)
  }
  // Convert to unsigned 32-bit, then to base-36 for compact representation.
  // Produce two 32-bit hashes (second seeded differently) for a longer fingerprint.
  let hash2 = 0x1a2b3c4d;
  for (let i = 0; i < str.length; i++) {
    hash2 ^= str.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x01000193);
  }
  return (hash >>> 0).toString(36) + (hash2 >>> 0).toString(36);
}

/**
 * Compute a style fingerprint for cache invalidation.
 *
 * Blueprints generated under the same fingerprint are interchangeable.
 * A fingerprint change means cached blueprints may use outdated primitives,
 * tokens, or structural patterns and should be regenerated.
 *
 * What invalidates the cache:
 * - stylingPrompt changed ("make it playful" → different layout)
 * - designSystemPreset changed (different component set available)
 * - designSystemVersion bumped (new tokens, primitives, motion, etc.)
 *
 * What does NOT invalidate:
 * - themeId changed (colors are applied at render time via cssOverrides)
 *
 * Uses FNV-1a (non-cryptographic) — this is for cache keys, not security.
 * Works in all JS runtimes (browser, Node.js, React Native).
 */
export function computeStyleFingerprint(input: StyleFingerprintInput): string {
  const raw = [
    input.stylingPrompt || '',
    input.designSystemPreset || 'default',
    input.designSystemVersion,
  ].join('|');
  return fnv1aHash(raw);
}

/**
 * Request to generate a UI component.
 * Generic `TContext` defaults to {@link JsonObject} for generator context hints.
 */
export interface UIGenerationRequest<TContext = JsonObject> {
  sessionId: string;
  prompt: string;
  context?: TContext;
  schema?: JsonSchema;
  subscription?: EventSubscription;
}

/**
 * Internal response from UI generation. This is the GENERATOR-OUTPUT
 * shape — `componentCode` is the freshly produced ESM string. Before
 * the stack item commits to the wire, the slice-meta derivation
 * uploads the code body and projects `codeUrl` (a fetchable URL) onto
 * the `ai.ggui/stack-item` slice instead of inlining the source.
 * Iframe runtimes fetch the code from `codeUrl`; they never see this
 * field.
 */
export interface UIGenerationResponse {
  stackItemId: string;
  componentCode: string;
  sourceCode?: string;
  warnings?: string[];
  /**
   * Data contract the generated component conforms to.
   *
   * Populated by the generator when the component calls wire hooks
   * (`useAction('name')`, `useStream('channel')`) — the generator
   * extracts the call sites and emits a matching authoring-side
   * envelope so downstream consumers (`ggui_push` → StackItem, console
   * inspectors, session-channel router) have the contract available.
   *
   * - When the caller supplied `UiGenerateInput.contract` that
   *   envelope is passed through as-is (already authoritative).
   * - When the caller didn't supply a contract but the generated code
   *   uses wire hooks, the generator synthesizes a MINIMAL envelope:
   *   `actionSpec[name] = {label: name}` and
   *   `streamSpec[channel] = {schema: {type: 'object'}}`. Enough for
   *   the receiver to know the surface exists; callers who need
   *   richer metadata (labels, schemas, refresh tools) should
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
