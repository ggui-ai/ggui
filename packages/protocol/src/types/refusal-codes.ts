/**
 * `PRE_GENERATION_REFUSAL_CODES` — the closed registry of refusal codes
 * (ggui#786).
 *
 * A **pre-generation refusal** is a deployment declining a call BEFORE
 * it does any work: no state read, nothing committed, no model spend.
 * (The call has already passed the SDK's check against the declared
 * `inputSchema`; the claim is nothing READ, not nothing validated.)
 * It is a third outcome, not a failure — a failure describes work
 * that ran and did not produce a result. The wire shape
 * of a refused render lives in `../schemas/mcp.ts`
 * (`renderRefusalSchema`); this file owns the NAMES.
 *
 * ## Why one file
 *
 * The registry is the anti-drift mechanism: one `code` namespace across
 * every surface a deployment can refuse on, so two names can never mean
 * the same state and one name can never mean two. Emitters read a row
 * from here; they never mint a code literal of their own. A code that
 * is not in this file fails the wire enum at the transport, loudly — a
 * bug, never a wire state.
 *
 * ## The rules every row obeys
 *
 * - **Name the STATE, not the verb.** `subscription_exists`, not
 *   `cannot_create_subscription`: the same state may refuse more than
 *   one action later, and the code must not encode which.
 * - **One state, one code.** Two codes never share a name; one code MAY
 *   list several `surfaces` when a single state surfaces in more than
 *   one place (`billing_mode_anomaly`).
 * - **`retry` is defined from the CALLER's side.** `after-fix` — a
 *   named party can act and the SAME call then succeeds; `next-period`
 *   — time restores it at the next period boundary; `later` —
 *   unbounded time (transient unavailability); `never` — no action by
 *   the caller restores the call under this identity.
 * - **`fixBy` names WHO acts.** REQUIRED on every `after-fix` row;
 *   PERMITTED on a `later` row (naming the operator who restores a
 *   surface that is transiently unavailable); FORBIDDEN on
 *   `next-period` and `never` — time restores the first and nothing
 *   restores the second, so naming a party would be a lie about who
 *   can act. **An agent MUST NOT auto-retry an `after-fix` refusal
 *   whose `fixBy` is not `caller`** — otherwise "retry after fix"
 *   would mean "perform someone else's billing or policy decision on
 *   their behalf". `caller` is the only value an agent may act on
 *   itself.
 * - **`emitter` is named.** A row whose emitter is unrecorded is the
 *   drift the registry exists to prevent.
 *
 * ## Reading this file as a self-hoster
 *
 * Every `description` here ships to npm, and the render-gate subset
 * reaches an agent as JSON-Schema metadata through `tools/list`. The
 * wording is therefore written from the DEPLOYMENT-POLICY perspective
 * ("the allowance this deployment configured for the app is
 * exhausted"), never from an operator's internal vocabulary. A
 * deployment that configures none of these policies emits none of these
 * codes; the registry is the vocabulary, not a mandate.
 */

/**
 * The surfaces a refusal code may be emitted on.
 *
 *   - `render-gate` — the pre-generation gate on the render/mutation
 *     tools. These are the only codes that can appear in a refused
 *     tool result's `refusal.code`.
 *   - `owner-api` — an app owner's own billing mutations.
 *   - `provisioning-api` — a tenant provisioning an app on behalf of
 *     its own users.
 *   - `mcp-endpoint` — the per-app MCP endpoint's authorization, on
 *     any JSON-RPC request (`initialize` included). The refusal rides
 *     the JSON-RPC error object's `data.refusal` (HTTP 403, error code
 *     `-32000`, message `Forbidden` — unchanged); only the codes listed
 *     here are ever typed there, and an authorization failure that is
 *     NOT one of them stays a bare 403 by contract, so a client can
 *     never learn which of the untyped arms it hit.
 */
export const REFUSAL_SURFACES = [
  'render-gate',
  'owner-api',
  'provisioning-api',
  'mcp-endpoint',
] as const;

/** One member of {@link REFUSAL_SURFACES}. */
export type RefusalSurface = (typeof REFUSAL_SURFACES)[number];

/** The closed `retry` vocabulary — see the file header for semantics. */
export const REFUSAL_RETRIES = [
  'after-fix',
  'next-period',
  'later',
  'never',
] as const;

/** One member of {@link REFUSAL_RETRIES}. */
export type RefusalRetry = (typeof REFUSAL_RETRIES)[number];

/**
 * Who can act on an `after-fix` refusal. Only `caller` is the agent
 * itself — see the no-auto-retry rule in the file header.
 */
export const REFUSAL_FIX_BY = ['caller', 'owner', 'tenant', 'operator'] as const;

/** One member of {@link REFUSAL_FIX_BY}. */
export type RefusalFixBy = (typeof REFUSAL_FIX_BY)[number];

/** Fields every row carries regardless of its retry class. */
interface RefusalRowShared {
  /** Non-empty — the surfaces this state is refused on. */
  readonly surfaces: readonly [RefusalSurface, ...RefusalSurface[]];
  /** Where the code is produced, in deployment-neutral wording. */
  readonly emitter: string;
  /** What state the code names, written for a self-hoster. */
  readonly description: string;
}

/**
 * The retry/fixBy pairing, encoded so the compiler enforces it rather
 * than a test catching it later: `after-fix` MUST name who acts;
 * `later` MAY (the operator who restores a transiently unavailable
 * surface); `next-period` and `never` MUST NOT — time restores the one
 * and nothing restores the other, so there is no party to address.
 *
 * The forbidden arm is branded `fixBy?: never` rather than left silent.
 * TypeScript's excess-property check against a UNION admits any property
 * declared by ANY member, so an unbranded `{ retry: 'never' }` arm would
 * accept `fixBy: 'tenant'` beside it — the docstring would then claim an
 * enforcement the compiler never performed. `never` closes it: the value
 * matches no member, so the row is a compile error at the definer call.
 */
type RefusalRowPolicy =
  | { readonly retry: 'after-fix'; readonly fixBy: RefusalFixBy }
  | { readonly retry: 'later'; readonly fixBy?: RefusalFixBy }
  | { readonly retry: 'next-period' | 'never'; readonly fixBy?: never };

type RefusalRowBase = RefusalRowShared & RefusalRowPolicy;

/**
 * The registry is the ONLY list of refusal codes: {@link RefusalCode}
 * is derived from the keys below, and this definer forces every row's
 * `code` to equal its key at the type level. The `const` type parameter
 * preserves each `surfaces` list as a literal tuple, which is what lets
 * {@link PreGenerationRefusalCode} be derived per surface rather than
 * written down a second time.
 *
 * Same posture as `defineModelRegistry` in `./llm.ts`.
 */
function defineRefusalRegistry<
  const T extends { readonly [K in keyof T]: RefusalRowBase & { readonly code: K } },
>(rows: T): T {
  return rows;
}

const REFUSAL_ROWS = /* @__PURE__ */ defineRefusalRegistry({
  // ── render-gate ───────────────────────────────────────────────────
  unsupported_provider: {
    code: 'unsupported_provider',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's generation gate, provider arm",
    description:
      'The provider behind the requested model is not one this deployment can fund for the app. The app owner picks a funded provider or configures the app with its own credentials.',
  },
  insufficient_credit: {
    code: 'insufficient_credit',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's generation gate, balance arm",
    description:
      'The balance this deployment funds the app from is exhausted. The app owner adds funds, after which the same call succeeds.',
  },
  hard_cap_exceeded: {
    code: 'hard_cap_exceeded',
    surfaces: ['render-gate'],
    retry: 'next-period',
    emitter: "a deployment's generation gate, cap arm",
    description:
      'The app reached the hard ceiling this deployment set for the current period. Nothing the caller or the owner does lifts it before the period rolls over.',
  },
  model_not_in_tier: {
    code: 'model_not_in_tier',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'caller',
    emitter: "a deployment's generation gate, model arm",
    description:
      'The requested model is not among those the app is allowed to use. The caller picks an allowed model and retries — the one render-gate state an agent may act on itself.',
  },
  managed_default_cap_exceeded: {
    code: 'managed_default_cap_exceeded',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'tenant',
    emitter: "a deployment's generation gate, delegated-policy arm",
    description:
      'The app is running on the default ceiling because the tenant that provisioned it has declared no policy of its own, and that ceiling is reached. The tenant declares an explicit policy for the app.',
  },
  app_policy_missing: {
    code: 'app_policy_missing',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'tenant',
    emitter: "a deployment's generation gate, delegated-policy arm",
    description:
      'The app exists but carries no policy yet — the window between provisioning it and declaring what it may spend. The tenant declares the policy.',
  },
  billing_mode_anomaly: {
    code: 'billing_mode_anomaly',
    // ONE state on TWO surfaces: the same unreadable record refuses a
    // provisioning call and a render. Two entries with one name would
    // be the collision the namespace rule forbids; this is not one.
    surfaces: ['provisioning-api', 'render-gate'],
    retry: 'never',
    emitter:
      "a deployment's provisioning guard and its generation gate, reading the same record",
    description:
      'The app record declares a funding mode this deployment does not recognise, or declares none at all. The value is reported as read and never coerced — an unreadable record is not a policy.',
  },
  app_canceled: {
    code: 'app_canceled',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's generation gate, plan-state arm",
    description:
      "The app's plan has ended, so it renders nothing while the stored work is kept. The owner starts a new plan to restore rendering.",
  },
  trial_exhausted: {
    code: 'trial_exhausted',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's generation gate, trial arm",
    description:
      'The trial this deployment grants the app has used up its allotment. The owner starts a paid plan.',
  },
  trial_expired: {
    code: 'trial_expired',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's generation gate, trial arm",
    description:
      "The app's trial window has closed. The owner starts a paid plan.",
  },
  issuer_rate_limited: {
    code: 'issuer_rate_limited',
    surfaces: ['render-gate'],
    retry: 'later',
    emitter: "the per-issuer render-rate cap's denial",
    description:
      'Calls arriving under this issuing identity are over the rate this deployment allows. Time restores it; retry shortly.',
  },
  app_rate_limited: {
    code: 'app_rate_limited',
    surfaces: ['render-gate'],
    retry: 'later',
    emitter: "the per-app render-rate cap's denial",
    description:
      'This app is rendering faster than the rate this deployment allows it. The cap is the app\u2019s own, not the issuing identity\u2019s \u2014 the two are separate states with separate codes. Time restores it; retry shortly.',
  },
  app_deprovisioned: {
    code: 'app_deprovisioned',
    surfaces: ['render-gate', 'mcp-endpoint'],
    retry: 'never',
    emitter:
      "the generation gate's owner-claim check, before any reservation or metering",
    description:
      'The app record has no owner claim any more \u2014 either the claim was removed, or the record names no issuing tenant at all. A record with no owner cannot be funded, so nothing renders under it and no caller action restores it.',
  },
  billing_path_missing: {
    code: 'billing_path_missing',
    surfaces: ['render-gate'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter:
      "the generation gate's fall-through arm: a non-playground identity that resolves to no billing path (not a trial account, not a managed app, not a credit holder)",
    description:
      'The caller has no billing subject on this deployment, so nothing renders under it. The owner provisions one — a trial account, a managed policy, or credit. Unlike `billing_mode_anomaly` — an app record that exists and declares a funding mode this deployment cannot read — no record arm applies here: there is simply no subject to bill. A deployment MAY suppress this refusal by operator override; that switch is deployment policy, not a wire state.',
  },

  // ── owner-api ─────────────────────────────────────────────────────
  subscription_exists: {
    code: 'subscription_exists',
    surfaces: ['owner-api'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's owner billing mutations",
    description:
      "An active (non-canceled) plan exists on this app. It refuses starting another one AND deleting the app — the refusal's own `fix` names the next step for the action that was called.",
  },
  checkout_unavailable: {
    code: 'checkout_unavailable',
    surfaces: ['owner-api'],
    retry: 'later',
    fixBy: 'operator',
    emitter: "a deployment's owner billing mutations",
    description:
      'The surface that starts a plan is unavailable on this deployment right now — unconfigured, or its provider is down. Only the operator can restore it.',
  },
  card_update_unavailable: {
    code: 'card_update_unavailable',
    surfaces: ['owner-api'],
    retry: 'later',
    fixBy: 'operator',
    emitter: "a deployment's owner billing mutations",
    description:
      'The surface that updates a payment method is unavailable on this deployment right now. Only the operator can restore it.',
  },
  portal_unavailable: {
    code: 'portal_unavailable',
    surfaces: ['owner-api'],
    retry: 'later',
    fixBy: 'operator',
    emitter: "a deployment's owner billing mutations",
    description:
      "The self-service billing surface is unavailable on this deployment right now. Only the operator can restore it.",
  },
  no_subscription: {
    code: 'no_subscription',
    surfaces: ['owner-api'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's owner billing mutations",
    description:
      'A plan-management action was called on an app that has no plan. The owner starts a plan first.',
  },
  already_on_tier: {
    code: 'already_on_tier',
    surfaces: ['owner-api'],
    retry: 'after-fix',
    fixBy: 'owner',
    emitter: "a deployment's owner billing mutations",
    description:
      'The plan requested is the one the app is already on. The owner picks a different plan.',
  },
  managed_app_no_checkout: {
    code: 'managed_app_no_checkout',
    surfaces: ['owner-api'],
    retry: 'never',
    emitter: "a deployment's owner billing mutations",
    description:
      'This app is funded by the tenant that provisioned it, so it has no owner-facing plan surface at all. No owner action creates one.',
  },
  managed_app_no_card_update: {
    code: 'managed_app_no_card_update',
    surfaces: ['owner-api'],
    retry: 'never',
    emitter: "a deployment's owner billing mutations",
    description:
      'This app is funded by the tenant that provisioned it, so it carries no owner payment method to update.',
  },
  managed_app_no_portal: {
    code: 'managed_app_no_portal',
    surfaces: ['owner-api'],
    retry: 'never',
    emitter: "a deployment's owner billing mutations",
    description:
      'This app is funded by the tenant that provisioned it, so it has no owner self-service billing surface.',
  },

  // ── provisioning-api ──────────────────────────────────────────────
  owner_ref_mismatch: {
    code: 'owner_ref_mismatch',
    surfaces: ['provisioning-api'],
    retry: 'after-fix',
    fixBy: 'tenant',
    emitter: "a deployment's provisioning guard",
    description:
      "The owner reference the caller supplied is not the one recorded on this app. The refusal names the route and the app, never the recorded reference. The tenant re-derives the reference and retries.",
  },
  policy_version_stale: {
    code: 'policy_version_stale',
    surfaces: ['provisioning-api'],
    retry: 'after-fix',
    fixBy: 'tenant',
    emitter: "a deployment's provisioning guard, policy-write arm",
    description:
      "The policy write carries a version older than the one stored, so it would overwrite a newer decision. The refusal reports the stored version; the tenant re-derives from it and writes again.",
  },
});

/** A refusal code = a registry key. Derived; never a second list. */
export type RefusalCode = keyof typeof REFUSAL_ROWS;

/**
 * A registry row, as consumers read it. Normalized (not the literal
 * row union) so `PRE_GENERATION_REFUSAL_CODES[code]` for any
 * {@link RefusalCode} exposes `fixBy` as `RefusalFixBy | undefined`
 * rather than a union in which some rows lack the property. The
 * literal rows above still derive {@link RefusalCode}, enforce
 * `code === key`, and enforce the retry/fixBy pairing.
 */
export interface RefusalRow {
  readonly code: RefusalCode;
  readonly surfaces: readonly RefusalSurface[];
  readonly retry: RefusalRetry;
  readonly fixBy?: RefusalFixBy;
  readonly emitter: string;
  readonly description: string;
}

/** The registry consumers read. */
export const PRE_GENERATION_REFUSAL_CODES: Readonly<
  Record<RefusalCode, RefusalRow>
> = REFUSAL_ROWS;

/**
 * The codes on one surface, derived type-level from the literal rows'
 * `surfaces` tuples. A runtime `.filter()` cannot narrow a type, so the
 * union is computed here and the tuple below is proved complete
 * against it.
 */
type CodesOnSurface<S extends RefusalSurface> = {
  [K in RefusalCode]: S extends (typeof REFUSAL_ROWS)[K]['surfaces'][number]
    ? K
    : never;
}[RefusalCode];

/**
 * A code that can appear in a refused tool result's `refusal.code` —
 * i.e. one whose `surfaces` include `render-gate`. Derived, so an
 * owner-api or provisioning-api code is not even expressible on the
 * render wire.
 */
export type PreGenerationRefusalCode = CodesOnSurface<'render-gate'>;

/**
 * A code that can appear in a per-app MCP endpoint refusal's
 * `error.data.refusal.code` — i.e. one whose `surfaces` include
 * `mcp-endpoint` (ggui#825). Derived, so a render-gate-only code is not
 * expressible on the transport wire.
 */
export type McpEndpointRefusalCode = CodesOnSurface<'mcp-endpoint'>;

/**
 * Identity helper that only accepts an EXHAUSTIVE tuple of one surface's
 * codes: omit one and the parameter type collapses to `never`, so the
 * call site is a compile error. A tuple is needed because a wire enum
 * requires a literal, non-empty tuple — a runtime filter over the rows
 * yields `string[]`, which cannot type an enum. This keeps every
 * per-surface tuple derived-CHECKED rather than a second list.
 */
const exhaustiveCodesOn =
  <S extends RefusalSurface>() =>
  <const T extends readonly CodesOnSurface<S>[]>(
    codes: T &
      (Exclude<CodesOnSurface<S>, T[number]> extends never ? unknown : never),
  ): T =>
    codes;

/**
 * Every render-gate code, as the literal tuple the wire enum
 * (`renderRefusalSchema.code`) is built from. Order is the registry's.
 */
export const RENDER_GATE_REFUSAL_CODES = exhaustiveCodesOn<'render-gate'>()([
  'unsupported_provider',
  'insufficient_credit',
  'hard_cap_exceeded',
  'model_not_in_tier',
  'managed_default_cap_exceeded',
  'app_policy_missing',
  'billing_mode_anomaly',
  'billing_path_missing',
  'app_canceled',
  'trial_exhausted',
  'trial_expired',
  'issuer_rate_limited',
  'app_rate_limited',
  'app_deprovisioned',
]);

/**
 * Every mcp-endpoint code, as the literal tuple the transport wire enum
 * (`transportRefusalSchema.code`) is built from — the refusals a per-app
 * MCP endpoint's authorization types on `error.data.refusal`
 * (ggui#825). Order is the registry's.
 */
export const MCP_ENDPOINT_REFUSAL_CODES = exhaustiveCodesOn<'mcp-endpoint'>()([
  'app_deprovisioned',
]);
