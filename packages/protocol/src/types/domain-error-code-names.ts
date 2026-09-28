/**
 * The Plane-2 code NAMES — the ONLY list of domain-error slugs (ggui#880).
 *
 * The registry rows (`./domain-error-codes`) carry each code's tools,
 * recovery, emitter and description, and are typed exhaustively over this
 * tuple: a name without a row, or a row without a name, does not compile.
 * The names live apart from that prose because a reader of the wire grammar
 * needs only them. `parseDomainErrorText` (`../errors/domain-error-text`)
 * imports this module and nothing else, so a browser that parses a domain
 * error (`@ggui-ai/protocol/wire`) does not carry every row's text.
 *
 * Disjoint from the refusal registry (`./refusal-codes`, pinned): one code
 * names one plane.
 */
export const DOMAIN_ERROR_CODES = [
  // identity
  'session_not_found',
  'handshake_not_found',
  // the contract gate
  'contract_violation',
  'schema_mismatch_error',
  'contract_validation_failed',
  'override_contract_invalid',
  // the live channel
  'channel_not_declared',
  'invalid_complete',
  // the gadget gate
  'gadget_not_registered',
  'gadget_package_mismatch',
  'gadget_public_env_missing',
  'duplicate_gadget_hook',
  'gadget_types_fetch_failed',
  'gadget_catalog_integrity',
  // the blueprint registry
  'blueprint_rejected',
] as const;

/** A domain-error code: one member of {@link DOMAIN_ERROR_CODES}. */
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** Whether `value` is a registered domain-error code. */
export function isDomainErrorCode(value: string): value is DomainErrorCode {
  return DOMAIN_ERROR_CODES.some((code) => code === value);
}
