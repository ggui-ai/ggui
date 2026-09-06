/**
 * `DomainError` — the ONE composer of a Plane-2 error's wire text (ggui#880).
 *
 * SPEC §7.9 Plane 2. The MCP SDK converts every error a tool handler throws
 * into `{content: [{type: 'text', text: error.message}], isError: true}` —
 * no `structuredContent`, no `_meta`, no field for a code. So `message` IS
 * the wire, and this base is the only place that composes it:
 *
 *     <code> ": " <detail>
 *
 * with `code` a member of {@link DOMAIN_ERROR_CODES}. A reader branches on
 * `text.startsWith(code + ': ')` for a REGISTERED code and on nothing else
 * — a tool-name prefix inside the detail (`ggui_render: …`) is prose. The
 * one thing the base refuses at construction is a detail that itself
 * begins with a registered domain or refusal code followed by `': '`: the
 * leading slug would then lie to the reader, and the emitter's own suite
 * sees the `TypeError` instead of the wire.
 *
 * Parties (the contract): the EMITTER is any data-plane handler that throws
 * for a caller-fixable, nothing-committed condition; the TRANSPORT is the
 * server's `tools/call` dispatch and the SDK's catch it hands to; the
 * CONSUMER is a raw MCP agent reading the result text. Observable violation:
 * the conformance kit's `domain-error` catalog grades the raw result.
 */
import {
  DOMAIN_ERROR_CODES,
  isDomainErrorCode,
  type DomainErrorCode,
} from '../types/domain-error-codes';
import { PRE_GENERATION_REFUSAL_CODES } from '../types/refusal-codes';

/**
 * Marks a {@link DomainError} across bundle copies and realms: an instance
 * from another copy of `@ggui-ai/protocol` is still a domain error to
 * {@link isDomainError}, which never uses `instanceof`.
 */
export const DOMAIN_ERROR_MARKER: unique symbol = Symbol.for('ai.ggui.domainError');

/** The leading `"<code>: "` a detail must not carry — either registry. */
function leadingRegisteredCode(detail: string): string | undefined {
  for (const code of DOMAIN_ERROR_CODES) {
    if (detail.startsWith(`${code}: `)) return code;
  }
  for (const code of Object.keys(PRE_GENERATION_REFUSAL_CODES)) {
    if (detail.startsWith(`${code}: `)) return code;
  }
  return undefined;
}

/**
 * Thrown at construction when a detail begins with a registered code —
 * an emitter bug, surfaced in the emitter's own suite, never on the wire.
 */
export class DomainErrorDetailCollisionError extends TypeError {
  constructor(
    readonly code: DomainErrorCode,
    readonly collidingCode: string,
    readonly detail: string,
  ) {
    super(
      `DomainError(${code}): the detail begins with the registered code "${collidingCode}: " — a reader branches on the leading slug, so a nested code would lie to it; say the cause in words instead`,
    );
    this.name = 'DomainErrorDetailCollisionError';
  }
}

/**
 * Base of every Plane-2 error. Subclass it per state; the subclass owns the
 * detail text and any typed fields, the base owns the wire grammar.
 */
export class DomainError<C extends DomainErrorCode = DomainErrorCode> extends Error {
  readonly [DOMAIN_ERROR_MARKER] = true as const;
  readonly code: C;
  readonly detail: string;

  constructor(code: C, detail: string, options?: ErrorOptions) {
    if (detail.trim().length === 0) {
      throw new TypeError(`DomainError(${code}): the detail must be non-empty — the wire text is "${code}: <detail>"`);
    }
    const collision = leadingRegisteredCode(detail);
    if (collision !== undefined) {
      throw new DomainErrorDetailCollisionError(code, collision, detail);
    }
    super(`${code}: ${detail}`, options);
    this.code = code;
    this.detail = detail;
    this.name = new.target.name;
  }
}

/**
 * Whether `err` is a domain error — by marker and shape, never by
 * `instanceof` (not even `instanceof Error`, which is realm-bound), so an
 * instance from another bundle copy or realm still qualifies and a plain
 * `Error` that merely carries a `code` does not.
 */
export function isDomainError(err: unknown): err is DomainError {
  // Structural on purpose: `instanceof Error` is realm-bound, and an
  // error thrown in another realm or bundle copy is still a domain error.
  if (typeof err !== 'object' || err === null) return false;
  if (Reflect.get(err, DOMAIN_ERROR_MARKER) !== true) return false;
  const code = Reflect.get(err, 'code');
  const detail = Reflect.get(err, 'detail');
  const message = Reflect.get(err, 'message');
  return (
    typeof code === 'string' &&
    isDomainErrorCode(code) &&
    typeof detail === 'string' &&
    typeof message === 'string'
  );
}

/** A parsed Plane-2 wire text. */
export interface ParsedDomainErrorText {
  readonly code: DomainErrorCode;
  readonly detail: string;
}

/**
 * The reader side of the grammar: `<code>: <detail>` for a REGISTERED code,
 * else `null` — a Plane-1 text (`MCP error -32602: …`), a tool-name prefix
 * (`ggui_render: …`) or an unregistered slug is not a domain error.
 */
export function parseDomainErrorText(text: string): ParsedDomainErrorText | null {
  const separator = text.indexOf(': ');
  if (separator <= 0) return null;
  const code = text.slice(0, separator);
  const detail = text.slice(separator + 2);
  if (!isDomainErrorCode(code) || detail.trim().length === 0) return null;
  return { code, detail };
}
