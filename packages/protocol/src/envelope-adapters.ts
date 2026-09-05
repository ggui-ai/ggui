/**
 * Envelope adapters — storage-side helpers for the consume pipe.
 *
 * `PendingEvent.envelope` carries the per-gesture {@link ConsumeEventEntry}
 * row written by `submit_action`'s `kind:"dispatch"` branch. Storage is
 * single-shaped (the same shape `ggui_consume` returns verbatim on drain).
 *
 * The only bounded adapter that lives here now is
 * {@link parsePendingEnvelope} — a shape-neutral reader for stored
 * `PendingEvent.envelope` values that may arrive as raw objects or as
 * JSON strings, depending on how the deployment's storage layer
 * serializes rows.
 */
import { consumeEventEntrySchema } from './schemas/mcp';
import type { ConsumeEventEntry } from './types/mcp';

/**
 * Parse a {@link PendingEvent.envelope} that may arrive as either a raw
 * object or a JSON-stringified object, depending on how the
 * deployment's storage layer serializes rows. Returns the parsed entry
 * unchanged when already an object.
 *
 * Throws `SyntaxError` when a string input is malformed JSON. Does NOT
 * validate the entry shape — that's the caller's job.
 */
export function parsePendingEnvelope(
  stored: ConsumeEventEntry | string,
): ConsumeEventEntry {
  if (typeof stored !== 'string') return stored;
  // Parsed, never cast (ggui#817 part C2): a malformed pipe entry refuses
  // here, at the seam, instead of shipping to the agent typed as good.
  return consumeEventEntrySchema.parse(JSON.parse(stored));
}
