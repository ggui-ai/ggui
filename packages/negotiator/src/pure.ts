/**
 * Pure helpers — zero I/O, zero AWS dependencies.
 *
 *   - `inferInteractionMode(text)` — keyword-priority mapper from free
 *     text (category / pattern / prompt) to a categorical interaction
 *     label. Used for telemetry / RAG hinting only; NOT part of the
 *     `DataContract` wire surface. Deterministic; default `'display'`.
 *   - `inferJsonSchemaType(tsType)` — TypeScript-style type-string
 *     mapper to the JSON Schema type union. Deterministic.
 */

/**
 * Categorical interaction-mode label used by `inferInteractionMode` for
 * telemetry / RAG hinting. NOT a `DataContract` field — the four typed
 * specs (propsSpec / actionSpec / contextSpec / streamSpec) describe
 * the wire surface exhaustively, so interaction mode is a derived
 * heuristic, never part of the contract.
 */
export type InteractionMode = 'display' | 'collect' | 'converse' | 'broadcast' | 'flow';

/**
 * Infer interaction mode from any text (category, pattern, or prompt).
 * Consolidated keyword matcher — all call sites use the same function.
 *
 * Used by rag-search and external benchmark runners for routing /
 * telemetry. Deterministic; no I/O. Matches the first rule in priority
 * order, defaulting to 'display'.
 */
export function inferInteractionMode(text: string): InteractionMode {
  const t = text.toLowerCase();
  if (t.includes('form') || t.includes('survey') || t.includes('input') || t.includes('collect') || t.includes('sign up') || t.includes('contact')) return 'collect';
  if (t.includes('chat') || t.includes('conversation') || t.includes('messaging') || t.includes('talk')) return 'converse';
  if (t.includes('dashboard') || t.includes('monitor') || t.includes('live') || t.includes('feed') || t.includes('real-time')) return 'broadcast';
  if (t.includes('wizard') || t.includes('onboarding') || t.includes('checkout') || t.includes('stepper') || t.includes('multi-step') || t.includes('flow') || t.includes('step')) return 'flow';
  return 'display';
}

/** Map TypeScript-style type strings to JSON Schema types. */
export function inferJsonSchemaType(tsType: string): 'string' | 'number' | 'boolean' | 'array' | 'object' {
  const t = tsType.toLowerCase();
  if (t.includes('string')) return 'string';
  if (t.includes('number') || t.includes('int') || t.includes('float')) return 'number';
  if (t.includes('boolean') || t.includes('bool')) return 'boolean';
  if (t.includes('array') || t.includes('[]')) return 'array';
  return 'object';
}
