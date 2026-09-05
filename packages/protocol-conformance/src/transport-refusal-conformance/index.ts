/**
 * Transport-refusal conformance catalog (ggui#825) — grades a deployment's
 * PER-APP ENDPOINT refusal projector: the function that turns a registry
 * refusal into the JSON-RPC error a per-app MCP endpoint answers with when
 * it refuses a request for a typed reason, on ANY method (`initialize`
 * included).
 *
 * The contract it makes observable: a deprovisioned app answers HTTP 403
 * with `{ code: -32003, message: "App not found", data: { refusal } }` where
 * `refusal` is the registry projection without the render-only fields
 * (`code`, `message`, `fix`, `retry`); an authorization failure that is
 * NOT a registry state answers 403 with `-32007` and no `data` — the untyped
 * arms deliberately indistinguishable among themselves, so a client never
 * learns which one it hit (codes ruled in ggui#836).
 *
 * Each case ships as raw JSON under `./cases/`. The kit never imports a
 * concrete server: the adopter supplies the projector, the catalog grades
 * it, and a code whose `surfaces` exclude `mcp-endpoint` must project to
 * `null` (no transport envelope exists for it).
 */
import refuseDeprovisionedEndpoint from './cases/refuse-deprovisioned-endpoint.json' with { type: 'json' };
import refuseRenderOnlyCode from './cases/refuse-render-only-code.json' with { type: 'json' };

import { jsonEqual } from '../json-equal.js';

/**
 * The refusal handed to the projector — the registry projection on the
 * transport surface. Authored here rather than imported from
 * `@ggui-ai/protocol` for the same reason as the render catalog: the kit
 * grades the WIRE, and a stringly input keeps a stale kit from typing
 * its way past a registry change.
 */
export interface TransportRefusalInput {
  /** Registered refusal code. */
  readonly code: string;
  /** Precise diagnostic. */
  readonly message: string;
  /** The one recovery step. */
  readonly fix: string;
  /** Retry class (`after-fix` | `next-period` | `later` | `never`). */
  readonly retry: string;
  /** The app id the refused endpoint serves — equals the path's `{appId}` (ggui#870). */
  readonly appId: string;
}

/** What the endpoint answers: the HTTP status and the JSON-RPC error object. */
export interface ProjectedTransportRefusal {
  readonly httpStatus: number;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data: { readonly refusal: TransportRefusalInput };
  };
}

/** One transport-refusal case, authored as JSON under `./cases/`. */
export interface TransportRefusalConformanceCase {
  readonly name: string;
  readonly description: string;
  readonly refusal: TransportRefusalInput;
  /** `null` when the code has no transport envelope (surfaces exclude `mcp-endpoint`). */
  readonly expect: ProjectedTransportRefusal | null;
}

export const transportRefusalCases: readonly TransportRefusalConformanceCase[] = [
  refuseDeprovisionedEndpoint,
  refuseRenderOnlyCode,
];

export interface TransportRefusalMismatch {
  readonly name: string;
  readonly expected: ProjectedTransportRefusal | null;
  /** What the projector produced — or the message of the error it threw. */
  readonly actual: ProjectedTransportRefusal | null | string;
}

export interface TransportRefusalConformanceResult {
  readonly passed: readonly string[];
  readonly failed: readonly TransportRefusalMismatch[];
}

/**
 * Grade a per-app endpoint refusal projector against the catalog. Pure
 * and synchronous: no server, no transport — the deterministic
 * projection is the whole obligation.
 */
export function runTransportRefusalConformance(
  project: (refusal: TransportRefusalInput) => ProjectedTransportRefusal | null,
): TransportRefusalConformanceResult {
  const passed: string[] = [];
  const failed: TransportRefusalMismatch[] = [];
  for (const testCase of transportRefusalCases) {
    let actual: ProjectedTransportRefusal | null | string;
    try {
      actual = project(testCase.refusal);
    } catch (error) {
      actual = error instanceof Error ? error.message : String(error);
    }
    if (typeof actual !== 'string' && jsonEqual(actual, testCase.expect)) {
      passed.push(testCase.name);
    } else {
      failed.push({ name: testCase.name, expected: testCase.expect, actual });
    }
  }
  return { passed, failed };
}
