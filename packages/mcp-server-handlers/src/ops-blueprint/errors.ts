/**
 * Typed errors thrown by the operator-class blueprint handlers.
 *
 * Lives alongside the handlers (not in `@ggui-ai/protocol`) for the
 * same reason `renders/errors.ts` does — these are
 * handler-flow diagnostics, not contract-shape violations.
 *
 * `BlueprintNotFoundError` and `BlueprintAlreadyExistsError` are
 * re-exported from `@ggui-ai/mcp-server-core` rather than redefined
 * here — they're store-level invariants that several handlers
 * (update + delete) surface verbatim.
 */

/**
 * Thrown by `ggui_ops_generate_blueprint` when the operator supplied
 * a `generator` slug that the bound `GeneratorRegistry` doesn't know
 * about. Typical causes: an OSS pod that didn't install Playwright
 * was asked for `ui-gen-advanced-opus-4-7`; a typo in an operator
 * script; a stale CI fixture against a deployment whose registry
 * shrank.
 *
 * Recovery: omit the `generator` field to use
 * `registry.defaultGenerator()`, or register the missing generator
 * before re-invoking.
 *
 * Not the retired agent-surface `unknown_generator` gate (rc3,
 * retired-surface cleanup 2026-06-11 — see `@ggui-ai/protocol`'s
 * version.ts changelog): the agent surface handles a bad
 * `blueprintDraft.generator` hint forgivingly as the
 * `GENERATOR_UNKNOWN` handshake finding (`renders/assert-generator.ts`);
 * THIS error is the operator registry's strict slug lookup and stays
 * live. Don't re-unify them.
 */
export class GeneratorNotFoundError extends Error {
  readonly code = "generator_not_found" as const;
  constructor(slug: string, registeredSlugs: readonly string[]) {
    super(
      `generator_not_found: no generator registered under slug ${JSON.stringify(slug)}. Registered slugs: [${registeredSlugs.map((s) => JSON.stringify(s)).join(", ")}]. Omit the \`generator\` field to use the registry default, or register the missing generator before re-invoking.`
    );
    this.name = "GeneratorNotFoundError";
  }
}

/**
 * Thrown by `ggui_ops_generate_blueprint` when the bound `resolveLlm`
 * dep returned `null` (no provider key resolved for the caller).
 * Distinct from a generator-level credential failure — this fires
 * BEFORE the generator runs, when no credential is even available
 * to pass through.
 *
 * Recovery: set the operator's bring-your-own-key provider key via
 * `ggui_ops_set_provider_key`, or run the handler in an environment
 * whose `resolveLlm` dep returns a pool credential.
 */
export class MissingCredentialsError extends Error {
  readonly code = "missing_credentials" as const;
  constructor(message?: string) {
    super(
      message ??
        "missing_credentials: no LLM provider credentials resolved for the caller. Set a BYOK provider key (`ggui_ops_set_provider_key`) before invoking generate, or run on a deployment whose `resolveLlm` dep returns a pool credential."
    );
    this.name = "MissingCredentialsError";
  }
}

/**
 * Thrown by `ggui_ops_generate_blueprint` when the generator returned
 * a non-`ok` result. Wraps the underlying `GenerationError` so the
 * MCP tool surface carries a consistent error shape regardless of
 * which generator failed and why.
 */
export class GenerationFailedError extends Error {
  readonly code = "generation_failed" as const;
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(`generation_failed: ${message}`);
    this.name = "GenerationFailedError";
    this.cause = cause;
  }
}
