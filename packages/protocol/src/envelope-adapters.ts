/**
 * Envelope adapters — storage-side helpers for the consume pipe.
 *
 * `PendingEvent.envelope` carries the per-gesture {@link ConsumeEventEntry}
 * row written by `submit_action`'s `kind:"dispatch"` branch. Storage is
 * single-shaped (the same shape `ggui_consume` returns verbatim on drain).
 *
 * The only bounded adapter that lives here now is
 * {@link parsePendingEnvelope} — a shape-neutral reader for stored
 * `PendingEvent.envelope` values that may arrive as raw objects (direct
 * DDB writes) or as JSON strings (AppSync `a.json()` semantics).
 */
import type { ConsumeEventEntry } from './types/mcp';

/**
 * Parse a {@link PendingEvent.envelope} that may arrive as either a raw
 * object (direct DDB writes) or a JSON-stringified object (AppSync
 * `a.json()` semantics). Returns the parsed entry unchanged when
 * already an object.
 *
 * Throws `SyntaxError` when a string input is malformed JSON. Does NOT
 * validate the entry shape — that's the caller's job.
 */
export function parsePendingEnvelope(
  stored: ConsumeEventEntry | string,
): ConsumeEventEntry {
  if (typeof stored !== 'string') return stored;
  return JSON.parse(stored) as ConsumeEventEntry;
}
