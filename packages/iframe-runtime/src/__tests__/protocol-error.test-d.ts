/**
 * Compile-time type tests for `ProtocolError` + `BootstrapFailureReason`.
 *
 * Two protections:
 *
 *   (a) Union exhaustiveness on `kind` — the discriminator is closed,
 *       so `never` narrowing in a switch MUST reach the default branch.
 *       Any future widening of `kind` that bypasses this file fails the
 *       exhaustiveness probe.
 *
 *   (b) Extensibility locks — `kind: 'protocol'`'s `code` and
 *       `BootstrapFailureReason` both tolerate `(string & {})` without
 *       losing autocomplete for the canonical values. The probes below
 *       assert that pattern holds: a string literal OUTSIDE the closed
 *       set still type-checks.
 *
 * This is a type-only file; it exports nothing at runtime.
 */
import { expectTypeOf } from 'vitest';
import type {
  ProtocolError,
  BootstrapFailureReason,
  ProtocolErrorEmitter,
} from '../protocol-error.js';

// =============================================================================
// (a) Exhaustiveness — every `kind` must narrow + the default must be `never`.
// =============================================================================

function exhaust(err: ProtocolError): string {
  switch (err.kind) {
    case 'transport':
      expectTypeOf(err.code).toEqualTypeOf<'DISCONNECTED' | 'TIMEOUT'>();
      expectTypeOf(err.retryable).toEqualTypeOf<boolean>();
      return err.code;
    case 'auth':
      expectTypeOf(err.code).toEqualTypeOf<
        'SESSION_NOT_FOUND' | 'TOKEN_EXPIRED' | 'AUTH_REJECTED'
      >();
      return err.code;
    case 'protocol': {
      // `code` is extensibly closed — accepts canonical values AND
      // foreign strings without losing autocomplete.
      const okCanonical: ProtocolError & { kind: 'protocol' } = {
        kind: 'protocol',
        code: 'SESSION_MISMATCH',
      };
      const okForeign: ProtocolError & { kind: 'protocol' } = {
        kind: 'protocol',
        code: 'FORWARD_COMPAT_CODE',
      };
      void okCanonical;
      void okForeign;
      return typeof err.code === 'string' ? err.code : 'unknown';
    }
    case 'contract':
      expectTypeOf(err.payload).toHaveProperty('toolName');
      return err.payload.toolName;
    case 'bootstrap':
      expectTypeOf(err.reason).toEqualTypeOf<BootstrapFailureReason>();
      return err.message;
    case 'version':
      expectTypeOf(err.clientSupports).toEqualTypeOf<readonly string[]>();
      return err.serverVersion ?? '<unknown>';
    case 'unknown':
      return String(err.raw);
    default: {
      // Compile-time exhaustiveness: if a new `kind` lands without a
      // case branch above, `err` is no longer `never` and the
      // assignment errors.
      const _exhaustive: never = err;
      void _exhaustive;
      return 'never';
    }
  }
}
void exhaust;

// =============================================================================
// (b) Extensibility locks — `(string & {})` tail on `kind: 'protocol'` code
//     and `BootstrapFailureReason`.
// =============================================================================

// Canonical bootstrap reasons all assignable.
const _canonical: BootstrapFailureReason[] = [
  'MISSING_TOOL_OUTPUT',
  'MISSING_META_GGUI_BOOTSTRAP',
  'BOOTSTRAP_META_MISSING',
  'MALFORMED_BOOTSTRAP',
  'EXPIRED_BOOTSTRAP',
  'UI_INITIALIZE_FAILED',
  'WS_HANDSHAKE_FAILED',
  'UPGRADE_REQUIRED',
  'BUNDLE_FETCH_FAILED',
  'CSP_VIOLATION',
  'SESSION_NOT_FOUND',
  'AUTH_REJECTED',
];
void _canonical;

// Extensibility: forward-compat values must still type-check.
const _forwardCompat: BootstrapFailureReason = 'SOME_FUTURE_REASON';
void _forwardCompat;

// =============================================================================
// (c) Emitter shape — the function signature the caller passes in.
// =============================================================================

const emitter: ProtocolErrorEmitter = (err) => {
  // Exhaustively narrow inside the emitter to lock the downstream
  // consumer contract.
  void exhaust(err);
};
void emitter;

// Ensure the emitter cannot be mistyped as returning something.
expectTypeOf<ProtocolErrorEmitter>().toMatchTypeOf<(err: ProtocolError) => void>();

export {};
