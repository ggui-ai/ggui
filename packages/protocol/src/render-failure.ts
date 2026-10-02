/**
 * ggui#1609 / ggui#1679 — the vocabulary of `ggui_runtime_report_render_failure`: the phases a card's render can fail
 * in, the shape a reported `errorName` must have, the bounds on a report, and the one function that reduces a thrown
 * value to the name the wire carries. The emitter (the iframe runtime) and the server's input schema
 * (`reportRenderFailureInputShape`, `schemas/mcp.ts`) import the same names from here, so the runtime sends exactly
 * what the server bounds.
 *
 * PURE-CONST by contract, as `runtime-telemetry.ts` is: this module has no runtime imports, so a package that imports
 * `@ggui-ai/protocol/render-failure` takes none of the protocol package's runtime dependencies (zod, the schema
 * modules) into its bundle. The iframe runtime's bundle budget is why: importing these names from the package root
 * pulled the whole `schemas/mcp` module into the card runtime (+34 KB). A test pins the purity.
 */

/** The phases a card's render can fail in: its first paint, or a later re-render. */
export const RENDER_FAILURE_PHASES = ['mount', 'update'] as const;
export type RenderFailurePhase = (typeof RENDER_FAILURE_PHASES)[number];

/**
 * The shape a reported `errorName` must have: a code identifier. It is the
 * thrown value's class name and never its message, so a name that could
 * carry data (whatever a card's code set `error.name` to) is not sent; see
 * {@link renderFailureErrorName}.
 */
export const RENDER_FAILURE_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_$.]{0,63}$/;

/** Upper bound on a report's `catches` (the error boundary's catch count, 2 today). */
export const RENDER_FAILURE_MAX_CATCHES = 100;

/**
 * Upper bound on a report's `sessionId` and `appId` (ggui#1609). A relaying
 * door applies the same bound, so the protocol and the door cannot disagree
 * on which report is valid. Today's ids are far shorter (a hosted session id
 * is 43 characters, an app id 8).
 */
export const RENDER_FAILURE_MAX_ID_LENGTH = 256;

/**
 * The `errorName` a runtime sends for a thrown value: an `Error`'s own
 * `name` when it matches {@link RENDER_FAILURE_ERROR_NAME_PATTERN}, else
 * `"Error"`. Anything that is not an `Error` reports as `"Error"`, so no
 * message, no stack and no author-set string that fails the pattern ever
 * leaves the card.
 *
 * "Is an `Error`" is the brand (`[object Error]`), not `instanceof`: a card's
 * code may evaluate in a realm other than the runtime's (a document-injected
 * module, a sandboxed frame), and an `Error` from there is still an `Error`
 * whose class name the report should carry (ggui#1679).
 */
export function renderFailureErrorName(thrown: unknown): string {
  if (!isErrorBrand(thrown)) return 'Error';
  const name = thrown.name;
  return typeof name === 'string' && RENDER_FAILURE_ERROR_NAME_PATTERN.test(name) ? name : 'Error';
}

/** The `Error` brand check that holds across realms, where `instanceof` does not. */
function isErrorBrand(value: unknown): value is { readonly name: unknown } {
  return (
    value instanceof Error ||
    (typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object Error]')
  );
}
