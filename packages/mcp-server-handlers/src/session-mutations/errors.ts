/**
 * Typed errors thrown by shared render-mutation helpers.
 *
 * Lives alongside the helpers (not in @ggui-ai/protocol) because these are
 * mutation-flow diagnostics — the protocol's ContractViolationError covers
 * the contract-violation surface; these cover the "target not found" /
 * "malformed input" surface that mutation paths need to distinguish.
 *
 * Post-Phase-B (flatten-render-identity): the pre-rename Session* +
 * StackItem* error matrix is collapsed to a single
 * {@link RenderNotFoundError}. The vessel-vs-entry distinction the prior
 * matrix encoded does not exist anymore — every render IS the addressable
 * unit; "session not found" and "stack item not found" both fold into
 * "render not found".
 */

/**
 * Thrown when a tool that requires a renderId receives one that
 * doesn't resolve to any live render for the caller's appId. Three
 * triggers, all surfaced as the same error to avoid leaking cross-
 * tenant existence:
 *
 *   1. The renderId was never minted (typo, fabricated, replay from a
 *      different deployment).
 *   2. The renderId belongs to a different appId (cross-tenant probe).
 *   3. The render was deleted, closed, or its TTL expired.
 *
 * Recovery: call `ggui_handshake` followed by `ggui_render` to mint a
 * fresh renderId, then thread it through subsequent `ggui_update` /
 * `ggui_consume` calls.
 */
export class RenderNotFoundError extends Error {
  readonly code = 'render_not_found' as const;
  constructor(public readonly renderId: string, message?: string) {
    super(
      message ??
        `Render "${renderId}" not found. Either it was never minted, expired (TTL), was closed, or belongs to a different appId. Recovery: call ggui_handshake then ggui_render to mint a fresh renderId.`,
    );
    this.name = 'RenderNotFoundError';
  }
}

/**
 * Thrown when `ggui_emit` targets a channel that is not declared on the
 * resolved render's `streamSpec`, OR when the resolved render has no
 * `streamSpec` at all.
 *
 * Post-streamSpec-rewrite, permissive-when-spec-missing is no longer
 * allowed: a render without a streamSpec cannot accept `ggui_emit`
 * emissions. Callers who want a render without live-channel affordances
 * simply don't call the tool.
 */
export class ChannelNotDeclaredError extends Error {
  readonly channel: string;
  readonly declaredChannels: ReadonlyArray<string>;
  readonly renderId: string | undefined;

  constructor(
    channel: string,
    declaredChannels: ReadonlyArray<string>,
    renderId?: string,
  ) {
    super(
      `Channel '${channel}' is not declared on the render's streamSpec. Declared channels: [${declaredChannels.join(', ') || '(none — no streamSpec on this render)'}]`,
    );
    this.name = 'ChannelNotDeclaredError';
    this.channel = channel;
    this.declaredChannels = declaredChannels;
    if (renderId !== undefined) {
      this.renderId = renderId;
    } else {
      this.renderId = undefined;
    }
  }
}

/**
 * Thrown when `ggui_emit` sets `complete: true` on a channel that was
 * not declared with `complete: true` on the streamSpec. A channel's
 * completability is part of its contract — retroactively declaring one
 * completable at emit time would let producers violate receivers'
 * expectations (receivers render 'channel closed' state only for
 * channels they know can close).
 */
export class InvalidCompleteError extends Error {
  readonly channel: string;

  constructor(channel: string) {
    super(
      `Channel '${channel}' was not declared with complete: true on its streamSpec. Declare completability on the spec, or drop complete from the emission.`,
    );
    this.name = 'InvalidCompleteError';
    this.channel = channel;
  }
}

/**
 * Closed enum union of every error code the render + handshake gate
 * stack can throw for gadget-related rejections. Keeps the wire
 * vocabulary single-sourced so the cloud, standalone server, and SDK
 * error matchers don't silently diverge as new gate paths land.
 *
 * Tag stays as the readonly `code` field on each error class above
 * (`GadgetNotRegisteredError.code`, `GadgetPublicEnvMissingError.code`).
 * This union is the type-level closure consumers can switch on.
 *
 * ## NOT in this union: `gadget_preservation:<hook>`
 *
 * The `gadget_preservation:*` namespace does NOT belong in this
 * union. `gadget_preservation:<hook>` is a
 * `Tier0CheckResult.subcategory` value emitted by the ui-gen
 * self-check pipeline at
 * `packages/ui-gen/src/check/run-tier0.ts:gadget_preservation:${hook}`
 * — a CODE-LEVEL diagnostic about whether the LLM kept the boilerplate
 * direct import of each gadget export (`import { useFoo } from
 * '<package>'`) intact. It rides on the
 * synthesis/check loop, never on the render/handshake gate stack, and
 * has its own structured shape (`{tier, category, subcategory,
 * severity, description, fix}`) distinct from this string-union wire
 * vocabulary.
 *
 * Keeping the two namespaces separate is intentional: this union is
 * the GATE-rejection contract (server-side refusal to mutate state);
 * `gadget_preservation:*` is the CODE-quality finding (LLM output
 * needs another pass). Conflating them would lose the "where in the
 * pipeline did this fail" signal that each consumer relies on.
 */
export type GadgetGateErrorCode =
  | 'gadget_not_registered'
  | 'gadget_package_mismatch'
  | 'gadget_public_env_missing'
  | 'unknown_generator';
