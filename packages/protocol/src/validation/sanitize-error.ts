// packages/protocol/src/validation/sanitize-error.ts
//
// Credential-leak sanitizer for stringified errors bound for the wire.
//
// A diagnostic cause string carries the stringified original error —
// typically `Error.stack`. Stacks frequently
// contain URLs with query-param tokens (`?token=...`, `?api_key=...`),
// Authorization header values captured by over-eager logging libraries,
// and env-var dumps. The primary consumer is the live channel's
// `channel_error` frame: a `POLL_FAILED` emission threads the polled
// tool's failure into the frame's `details` slot, where it is visible
// to the subscribed client and in operator tools (RenderInspector
// activity panels). If an operator shares a bug report with that data,
// the credential leaks externally.
//
// This module's default posture is "sanitize before emission": every
// producer pipes the raw `err.stack` through {@link sanitizeCausedBy}
// before putting it on the wire. Producers that need stricter
// sanitization substitute their own {@link SanitizeCausedBy} function.
//
// Scope: this is a DEFENSE-IN-DEPTH belt, not the sole line. Libraries
// that handle secrets should already avoid embedding them in error
// messages. This sanitizer exists because stack traces are produced
// opportunistically by code that didn't think about leaking and we'd
// rather redact conservatively than ship raw stacks.

/**
 * Patterns stripped from stringified errors before they ride a wire
 * frame. The default set covers the common credential
 * shapes that show up in stack traces by accident (URLs with token query
 * params, Bearer headers captured by retry libraries, env-var dumps).
 *
 * Each regex replaces the matched span with `[REDACTED]`. Replacement is
 * conservative — we'd rather over-redact than leak. Operators who need
 * finer control supply a custom {@link SanitizeCausedBy} function (or
 * pass a stricter pattern set to {@link sanitizeCausedBy}).
 */
export const DEFAULT_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // Bearer / Basic header values. `Bearer <token>` / `Authorization: Basic <base64>`.
  /Bearer\s+[A-Za-z0-9._\-~+/]+=*/gi,
  /Basic\s+[A-Za-z0-9+/]+=*/gi,
  /Authorization:\s*\S+/gi,
  // Query-param-style secrets — matches `?token=...` / `&api_key=...` etc.
  // Up to the next `&`, space, quote, or end-of-string.
  /([?&](?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|session[_-]?id)=)[^&\s"']+/gi,
  // Env-var-style `KEY=value` where KEY is obviously secret-ish and value
  // is non-empty. Bounds the value to the next whitespace/quote.
  /\b(AWS_[A-Z_]+|ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|COGNITO_[A-Z_]+|DATABASE_URL|DB_PASSWORD|REDIS_URL)=\S+/gi,
];

/** Default max length for a sanitized `causedBy` string. */
export const DEFAULT_CAUSED_BY_MAX_LENGTH = 2048;

/** Truncation marker appended when `causedBy` exceeds the max length. */
export const TRUNCATION_MARKER = '\n…[truncated]';

/**
 * Sanitize a stringified error (typically `err.stack`) before it's
 * written to a wire-visible diagnostic slot (e.g. the `channel_error`
 * frame's `details`).
 *
 * Applies every pattern in {@link DEFAULT_CREDENTIAL_PATTERNS} in order,
 * replacing matches with `[REDACTED]`. If the result exceeds `maxLength`,
 * the tail is replaced with {@link TRUNCATION_MARKER}.
 *
 * The function is pure and deterministic — the same `raw` produces the
 * same output across runs. Safe to call in hot paths; patterns are
 * pre-compiled module-level regexes.
 *
 * @param raw - The stringified error (usually `err.stack`).
 * @param maxLength - Maximum length of returned string. Default 2048.
 * @param patterns - Override the default credential-pattern set. Useful
 *   for tests or operators who want stricter behavior. Passing an empty
 *   array disables pattern replacement (truncation still applies).
 */
export function sanitizeCausedBy(
  raw: string,
  maxLength: number = DEFAULT_CAUSED_BY_MAX_LENGTH,
  patterns: readonly RegExp[] = DEFAULT_CREDENTIAL_PATTERNS,
): string {
  let out = raw;
  for (const p of patterns) {
    // Special-case the query-param pattern: we want to keep the key name
    // so callers can still see WHERE the secret was, just not what it
    // was. Every other pattern is replaced whole.
    if (p.source.includes('token|api')) {
      out = out.replace(p, '$1[REDACTED]');
    } else {
      out = out.replace(p, '[REDACTED]');
    }
  }
  if (out.length > maxLength) {
    out = out.slice(0, maxLength) + TRUNCATION_MARKER;
  }
  return out;
}

/**
 * Signature of a `causedBy` sanitizer hook. Receives the raw
 * stringified error (typically `err.stack`) and MUST return a
 * safe-to-emit string.
 *
 * {@link sanitizeCausedBy} is the canonical implementation. A
 * pass-through function that returns `raw` unchanged is valid but
 * discouraged — it re-enables the leak this module was added to close.
 */
export type SanitizeCausedBy = (raw: string) => string;
