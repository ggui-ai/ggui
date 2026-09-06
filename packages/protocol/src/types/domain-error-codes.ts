/**
 * The Plane-2 registry — the ONLY list of domain-error slugs (ggui#880).
 *
 * SPEC §7.9 Plane 2: a recoverable, contract-level failure the caller can
 * fix — a missing session or handshake, props that do not satisfy the
 * contract, an undeclared channel. The MCP SDK ships a thrown handler error
 * to the agent as `{content: [{type: 'text', text: error.message}],
 * isError: true}` and nothing else, so the slug travels as the LEADING
 * token of that text — `<code>: <detail>` — composed by the `DomainError`
 * base in `../errors/domain-error` from a code in this registry. A reader
 * branches on `text.startsWith(code + ': ')` for a registered code and on
 * nothing else.
 *
 * Same posture as the refusal registry in `./refusal-codes`: `code === key`
 * is forced at the definer, the code type is derived from the keys, and
 * the two registries are disjoint (pinned) — one code names one plane.
 */

/**
 * How a caller recovers from a Plane-2 failure.
 *
 * - `retry-same-id` — fix the input and retry on the SAME handshakeId /
 *   sessionId; nothing was consumed.
 * - `re-mint` — the id itself is gone (unknown, consumed, expired,
 *   another app's); mint a fresh one (`ggui_handshake`, then `ggui_render`).
 * - `later` — a dependency the server fetches was unavailable; time
 *   restores it, the input was fine.
 */
export const DOMAIN_ERROR_RECOVERIES = ['retry-same-id', 're-mint', 'later'] as const;

/** One member of {@link DOMAIN_ERROR_RECOVERIES}. */
export type DomainErrorRecovery = (typeof DOMAIN_ERROR_RECOVERIES)[number];

/**
 * A data-plane `tools/call` name a Plane-2 slug may be emitted on. The
 * template admits any `ggui_*` name at the type level; the registry's own
 * suite narrows every row's `tools` to the data-plane set (no `ggui_ops_*`,
 * no `ggui_protocol_*`).
 */
export type DataPlaneToolName = `ggui_${string}`;

/** Fields every row carries. */
interface DomainErrorRowBase {
  /** Non-empty — the data-plane tools that emit this code. */
  readonly tools: readonly [DataPlaneToolName, ...DataPlaneToolName[]];
  /** How the caller recovers. */
  readonly recovery: DomainErrorRecovery;
  /** Where the code is produced, in deployment-neutral wording. */
  readonly emitter: string;
  /** What state the code names, written for a self-hoster. */
  readonly description: string;
}

/**
 * The registry is the ONLY list of domain-error codes: {@link DomainErrorCode}
 * is derived from the keys below, and this definer forces every row's
 * `code` to equal its key at the type level.
 */
function defineDomainErrorRegistry<
  const T extends { readonly [K in keyof T]: DomainErrorRowBase & { readonly code: K } },
>(rows: T): T {
  return rows;
}

/**
 * The registry with its per-key literal types kept (ggui#889):
 * `DOMAIN_ERROR_ROWS.session_not_found.code` is `'session_not_found'`,
 * its `recovery` is `'re-mint'`. {@link DOMAIN_ERROR_REGISTRY} is the
 * same object read through the normalized row type.
 */
export const DOMAIN_ERROR_ROWS = /* @__PURE__ */ defineDomainErrorRegistry({
  // ── identity ──────────────────────────────────────────────────────
  session_not_found: {
    code: 'session_not_found',
    tools: [
      'ggui_consume',
      'ggui_get_session',
      'ggui_get_render_source',
      'ggui_update',
      'ggui_amend',
      'ggui_emit',
      'ggui_runtime_pull',
    ],
    recovery: 're-mint',
    emitter: 'the session lookup on every session-scoped tool',
    description:
      'The sessionId names no session this caller can reach — never minted, expired, closed, or owned by another app (cross-app access surfaces uniformly). Re-handshake and re-render to mint a fresh one.',
  },
  handshake_not_found: {
    code: 'handshake_not_found',
    tools: ['ggui_render'],
    recovery: 're-mint',
    emitter: 'the handshake-record lookup at ggui_render',
    description:
      'The handshakeId is unknown, already consumed by a render, or expired. Call ggui_handshake again for a fresh id, then render with the new pair.',
  },
  // ── the contract gate ─────────────────────────────────────────────
  contract_violation: {
    code: 'contract_violation',
    tools: ['ggui_render', 'ggui_update', 'ggui_amend', 'ggui_emit'],
    recovery: 'retry-same-id',
    emitter: 'the props / payload validator against the contract',
    description:
      "Props or a payload do not satisfy the contract's spec — a missing required prop included. Fix the values and retry with the same id; nothing was consumed.",
  },
  schema_mismatch_error: {
    code: 'schema_mismatch_error',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the schema-compatibility check between the contract and the registered tool shapes',
    description:
      "An actionSpec or streamSpec schema is not a subset of the named tool's registered shape. Adjust the contract or the tool, then retry with the same handshakeId.",
  },
  contract_validation_failed: {
    code: 'contract_validation_failed',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the contract lint gate (shape, retired fields, schema metadata, cross-references, schema compatibility)',
    description:
      'The contract failed the lint gate; the detail names the category and the finding. Fix the contract and retry with the same handshakeId.',
  },
  override_contract_invalid: {
    code: 'override_contract_invalid',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the override gate at ggui_render',
    description:
      'override.contract failed validation — an override commits the caller to a conforming contract. Drop the override and render the suggestion, or fix the draft.',
  },
  // ── the live channel ──────────────────────────────────────────────
  channel_not_declared: {
    code: 'channel_not_declared',
    tools: ['ggui_emit'],
    recovery: 'retry-same-id',
    emitter: "ggui_emit's channel check against the contract's streamSpec",
    description:
      "The channel is not declared by the session's contract. Emit on a declared channel; the detail lists them.",
  },
  invalid_complete: {
    code: 'invalid_complete',
    tools: ['ggui_emit'],
    recovery: 'retry-same-id',
    emitter: "ggui_emit's completion check",
    description:
      'A completion was signalled for a channel that cannot complete in its current state. Emit on the channel first, or omit the completion.',
  },
  // ── the gadget gate ───────────────────────────────────────────────
  gadget_not_registered: {
    code: 'gadget_not_registered',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the gadget gate at ggui_render',
    description:
      "A clientCapabilities.gadgets reference names an export the app's gadget registry does not carry. Drop the reference or fix the name; the detail suggests the nearest match.",
  },
  gadget_package_mismatch: {
    code: 'gadget_package_mismatch',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the gadget gate at ggui_render',
    description:
      'A gadget export is registered, but only under a different package than the contract requested. Request the registered package; the detail names it.',
  },
  gadget_public_env_missing: {
    code: 'gadget_public_env_missing',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the gadget gate at ggui_render',
    description:
      "A registered wrapper requires a public-env key the app has not set. Set the key on the app's public env, then retry.",
  },
  duplicate_gadget_hook: {
    code: 'duplicate_gadget_hook',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the gadget gate at ggui_render',
    description:
      'Two gadget packages export the same name; the generated import would collide. Reference one of them.',
  },
  gadget_types_fetch_failed: {
    code: 'gadget_types_fetch_failed',
    tools: ['ggui_render'],
    recovery: 'later',
    emitter: 'the gadget type fetch before cold generation',
    description:
      "Fetching a gadget package's types failed; the input was fine. Retry after a short delay.",
  },
  gadget_catalog_integrity: {
    code: 'gadget_catalog_integrity',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: "the app's gadget catalog resolver at ggui_render",
    description:
      "The app's gadget catalog is inconsistent with its registrations. Repair the catalog, then retry with the same handshakeId.",
  },
  // ── the blueprint registry ────────────────────────────────────────
  blueprint_rejected: {
    code: 'blueprint_rejected',
    tools: ['ggui_render'],
    recovery: 'retry-same-id',
    emitter: 'the blueprint registry on registration',
    description:
      "The blueprint was rejected by the registry's error-level findings; the detail lists them. Fix the contract and retry with the same handshakeId.",
  },
});

/** A domain-error code = a registry key. Derived; never a second list. */
export type DomainErrorCode = keyof typeof DOMAIN_ERROR_ROWS;

/** A registry row, as consumers read it. */
export interface DomainErrorRow {
  readonly code: DomainErrorCode;
  readonly tools: readonly DataPlaneToolName[];
  readonly recovery: DomainErrorRecovery;
  readonly emitter: string;
  readonly description: string;
}

/** The registry consumers read. */
export const DOMAIN_ERROR_REGISTRY: Readonly<Record<DomainErrorCode, DomainErrorRow>> =
  DOMAIN_ERROR_ROWS;

/** Whether `value` is a registered domain-error code. */
export function isDomainErrorCode(value: string): value is DomainErrorCode {
  return Object.hasOwn(DOMAIN_ERROR_ROWS, value);
}

/** Every registered code, in registry order. */
export const DOMAIN_ERROR_CODES: readonly DomainErrorCode[] =
  Object.keys(DOMAIN_ERROR_ROWS).filter(isDomainErrorCode);
