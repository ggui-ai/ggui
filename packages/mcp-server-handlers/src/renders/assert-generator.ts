/**
 * `assertGeneratorRegistered` — semantic gate on the
 * `blueprintDraft.generator` slug field.
 *
 * Symmetric defender for the two seams where an agent can pin which
 * generator the server uses:
 *   - `ggui_handshake` input — agent-side hint on draft creation.
 *   - `ggui_render` override decision — agent revises after seeing
 *     the suggestion.
 *
 * Zod schema (input layer) already enforces shape (length +
 * identifier-charset); this enforces that the supplied name is one
 * the server actually has BOUND. The default path binds exactly one
 * generator (`defaultGenerator`); multi-generator deployments would
 * thread a `knownGenerators: Set<string>` dep and check membership
 * against that set instead.
 *
 * The agent-facing error names the registered slug so the recovery is
 * obvious (omit the field, or use the named generator). Falling back
 * silently on an unknown slug would re-introduce the smuggle path
 * (LLM stuffs source in `generator`, server discards it, gen runs the
 * default, user sees stale-cache code).
 *
 * Hoisted out of the duplicated inline checks in `handshake.ts` +
 * `render.ts` so the two seams cannot drift in their error format or
 * whitelist semantics.
 *
 * @param requested — the slug from `blueprintDraft.generator` (may be
 *   `undefined` for "use server default", which is a no-op).
 * @param defaultGenerator — the server's currently-registered single
 *   generator. `undefined` means no generator is bound; any
 *   non-undefined `requested` still fails (no allow-list).
 */
export function assertGeneratorRegistered(
  requested: string | undefined,
  defaultGenerator: string | undefined,
): void {
  if (isGeneratorRegistered(requested, defaultGenerator)) return;
  const registered = defaultGenerator
    ? `['${defaultGenerator}']`
    : '[] (no generator registered)';
  throw new Error(
    `unknown_generator: '${requested}' is not registered on this server. Registered generators: ${registered}. Omit \`blueprintDraft.generator\` to use the server default.`,
  );
}

/**
 * Non-throwing predicate form of {@link assertGeneratorRegistered}.
 *
 * Used by the FORGIVING `ggui_handshake` path: an unknown generator slug
 * is DROPPED (the server default is used) + surfaced as a finding,
 * rather than thrown — handshake never hard-fails on a fixable detail.
 * The STRICT `ggui_render` override path keeps the throwing assert,
 * because override commits the agent to its exact draft.
 *
 * `undefined` (use server default) is always registered.
 */
export function isGeneratorRegistered(
  requested: string | undefined,
  defaultGenerator: string | undefined,
): boolean {
  if (requested === undefined) return true;
  return requested === defaultGenerator;
}
