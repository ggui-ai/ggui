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
  // `undefined` means "use server default" — always registered. The
  // explicit check (rather than relying on the predicate alone)
  // narrows `requested` to `string` for the typed error below.
  if (requested === undefined) return;
  if (isGeneratorRegistered(requested, defaultGenerator)) return;
  throw new UnknownGeneratorError(requested, defaultGenerator);
}

/**
 * Thrown when {@link assertGeneratorRegistered} receives a
 * `blueprintDraft.generator` slug that is not bound on this server.
 *
 * The `code` slug is a member of the `GadgetGateErrorCode` union in
 * `./errors.ts` — the type-level closure of every gate-rejection code
 * the render + handshake stack can throw. Consumers match via
 * `instanceof` or `error.code` string-equality, never by parsing the
 * message prefix.
 *
 * The message names the registered slug so the recovery is obvious:
 * omit `blueprintDraft.generator` to use the server default, or use
 * the named generator.
 */
export class UnknownGeneratorError extends Error {
  readonly code = 'unknown_generator' as const;
  /** The unregistered slug the caller requested. */
  readonly requested: string;
  /**
   * The server's currently-registered single generator, or
   * `undefined` when no generator is bound at all.
   */
  readonly defaultGenerator: string | undefined;

  constructor(requested: string, defaultGenerator: string | undefined) {
    const registered = defaultGenerator
      ? `['${defaultGenerator}']`
      : '[] (no generator registered)';
    super(
      `unknown_generator: '${requested}' is not registered on this server. Registered generators: ${registered}. Omit \`blueprintDraft.generator\` to use the server default.`,
    );
    this.name = 'UnknownGeneratorError';
    this.requested = requested;
    this.defaultGenerator = defaultGenerator;
  }
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
