/**
 * `isGeneratorRegistered` — predicate on the
 * `blueprintDraft.generator` slug field.
 *
 * Used by the FORGIVING `ggui_handshake` path — the only seam where an
 * agent can pin which generator the server uses. An unknown generator
 * slug is DROPPED (the server default is used) + surfaced as a
 * `GENERATOR_UNKNOWN` warn finding, rather than thrown — handshake
 * never hard-fails on a fixable detail. Discarding the slug silently
 * (no finding) would re-introduce the smuggle path: the LLM stuffs a
 * name in `generator`, the server ignores it, gen runs the default,
 * and the agent never learns its hint was dropped.
 *
 * Zod schema (input layer) already enforces shape (length +
 * identifier-charset); this checks that the supplied name is one the
 * server actually has BOUND. The default path binds exactly one
 * generator (`defaultGenerator`); multi-generator deployments would
 * thread a `knownGenerators: Set<string>` dep and check membership
 * against that set instead.
 *
 * `undefined` (use server default) is always registered.
 *
 * @param requested — the slug from `blueprintDraft.generator` (may be
 *   `undefined` for "use server default").
 * @param defaultGenerator — the server's currently-registered single
 *   generator. `undefined` means no generator is bound; any
 *   non-undefined `requested` is unregistered (no allow-list).
 */
export function isGeneratorRegistered(
  requested: string | undefined,
  defaultGenerator: string | undefined,
): boolean {
  if (requested === undefined) return true;
  return requested === defaultGenerator;
}
