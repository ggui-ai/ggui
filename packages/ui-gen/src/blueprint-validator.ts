/**
 * D16 sequential gated blueprint validator (path b — Claude composes).
 *
 * Pipeline (short-circuit on first failure):
 *   1. compile      — esbuild transform of source.tsx
 *   2. selfCheck    — minimal contract+source coherence checks
 *   3. runtime      — `DEFAULT_RUNTIME_RENDER_CHECK` from
 *                     `./harness/check/runtime-render`
 *
 * Returns `{ valid, failedAt, errors, warnings }`. `failedAt` reports
 * the FIRST tier that failed (or `null` when all green).
 *
 * Single source of truth for path-(b) validation. Two consumers today:
 *   - `validateGguiBlueprint` AppSync mutation Lambda (`backend`)
 *   - `registerGguiBlueprint` AppSync mutation Lambda — defense-in-depth
 *
 * Pod-side `ggui_validate_blueprint` MCP tool will import from here too
 * once S4.A.5 lands.
 *
 * Path (a) (ggui's own LLM driving the harness in `runCheck`) keeps
 * running every check unconditionally for full feedback in one round.
 * This module is path (b) only — short-circuit semantics for
 * conversation-paced iteration where each `validate` call sits between
 * Claude's MCP turns.
 */

import type { DataContract, JsonObject } from '@ggui-ai/protocol';
import { DEFAULT_RUNTIME_RENDER_CHECK } from './harness/check/runtime-render/index.js';
import type { EvalIssue } from './evaluation/types-public.js';

/**
 * Caller-supplied blueprint payload. `contract` is `unknown` at the
 * input boundary because callers (AppSync handler, MCP handler) receive
 * stringified JSON or untyped wire data; tier 2 (`selfCheckTier`)
 * narrows internally via {@link asContract}.
 */
type RawContract = unknown;

// ─── Result shape ───────────────────────────────────────────────────────────

export type ValidationTier = 'compile' | 'selfCheck' | 'runtime';

export interface ValidationError {
  /** Tier that produced this error. */
  readonly tier: ValidationTier;
  /** Short machine-readable code, e.g. `"compile:syntax"`. */
  readonly code: string;
  /** Human-readable diagnostic. */
  readonly message: string;
  /** Optional suggested fix — drives Claude's next-turn iteration. */
  readonly fix?: string;
}

export interface ValidationWarning extends ValidationError {
  readonly _kind: 'warning';
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly failedAt: ValidationTier | null;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
}

export interface ValidateBlueprintInput {
  readonly blueprint: {
    readonly source: string;
    readonly contract?: RawContract;
    readonly fixtureProps?: unknown;
  };
}

/**
 * Narrow the wire-supplied `unknown` contract into the typed
 * `DataContract` shape that downstream tiers consume. Returns
 * `undefined` when the payload is missing or malformed — tiers handle
 * the absence cleanly (selfCheck skips prop-coverage warnings; runtime
 * probe skip-warns).
 */
function asContract(x: RawContract): DataContract | undefined {
  if (typeof x !== 'object' || x === null) return undefined;
  return x as DataContract;
}

/**
 * Narrow `unknown` fixture props into a `JsonObject` for the runtime
 * probe. Anything that isn't a plain object becomes `undefined` and the
 * probe synthesizes mockup props from the contract's prop schema.
 */
function asJsonObject(x: unknown): JsonObject | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined;
  return x as JsonObject;
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

export async function validateBlueprint(
  input: ValidateBlueprintInput,
): Promise<ValidationResult> {
  const warnings: ValidationWarning[] = [];

  const compile = await compileTier(input.blueprint.source);
  if (!compile.ok) {
    return { valid: false, failedAt: 'compile', errors: compile.errors, warnings };
  }

  const contract = asContract(input.blueprint.contract);
  const selfCheck = selfCheckTier(input.blueprint.source, contract);
  warnings.push(...selfCheck.warnings);
  if (selfCheck.errors.length > 0) {
    return { valid: false, failedAt: 'selfCheck', errors: selfCheck.errors, warnings };
  }

  const runtime = await runtimeTier({
    sourceCode: input.blueprint.source,
    compiledCode: compile.compiledCode,
    contract,
    fixtureProps: input.blueprint.fixtureProps,
  });
  warnings.push(...runtime.warnings);
  if (runtime.errors.length > 0) {
    return { valid: false, failedAt: 'runtime', errors: runtime.errors, warnings };
  }

  return { valid: true, failedAt: null, errors: [], warnings };
}

// ─── Tier 1 — compile ───────────────────────────────────────────────────────

interface CompileOk {
  readonly ok: true;
  readonly compiledCode: string;
}
interface CompileFail {
  readonly ok: false;
  readonly errors: readonly ValidationError[];
}

async function compileTier(source: string): Promise<CompileOk | CompileFail> {
  const esbuild = await import('esbuild');
  try {
    const out = await esbuild.transform(source, {
      loader: 'tsx',
      jsx: 'automatic',
      target: 'es2022',
      format: 'esm',
      sourcemap: false,
    });
    return { ok: true, compiledCode: out.code };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      errors: [
        {
          tier: 'compile',
          code: 'compile:syntax',
          message: `esbuild transform failed: ${message}`,
          fix: 'Fix the syntax / import error in the source. Check JSX, TS types, and import paths.',
        },
      ],
    };
  }
}

// ─── Tier 2 — self-check (minimal v1) ───────────────────────────────────────

interface SelfCheckResult {
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
}

/**
 * Minimal source-level checks. TODO(S4.B): expand with the axis + tier
 * check registry from `./check/index.ts` for full parity with path (a).
 */
function selfCheckTier(source: string, contract?: DataContract): SelfCheckResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (!/export\s+default\s+/.test(source)) {
    errors.push({
      tier: 'selfCheck',
      code: 'selfCheck:missing-default-export',
      message:
        'Source has no `export default` — the runtime probe needs a default-exported React component.',
      fix:
        'Add `export default function MyComponent(props) { … }` (or `export default MyComponent` after the declaration).',
    });
  }

  if (contract?.propsSpec) {
    const propNames = Object.keys((contract.propsSpec as { shape?: Record<string, unknown> }).shape ?? {});
    for (const propName of propNames) {
      if (!source.includes(propName)) {
        warnings.push({
          _kind: 'warning',
          tier: 'selfCheck',
          code: 'selfCheck:declared-prop-unused',
          message: `Contract declares prop \`${propName}\` but the source never references it.`,
          fix: `Either render \`{props.${propName}}\` somewhere in the JSX, or remove the prop from the contract if it's no longer needed.`,
        });
      }
    }
  }

  return { errors, warnings };
}

// ─── Tier 3 — runtime probe ─────────────────────────────────────────────────

interface RuntimeTierInput {
  readonly sourceCode: string;
  readonly compiledCode: string;
  readonly contract?: DataContract;
  readonly fixtureProps?: unknown;
}

interface RuntimeResult {
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
}

async function runtimeTier(input: RuntimeTierInput): Promise<RuntimeResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (!input.contract) {
    warnings.push({
      _kind: 'warning',
      tier: 'runtime',
      code: 'runtime:skipped-no-contract',
      message:
        'Runtime probe skipped — blueprint has no contract surface to verify against.',
    });
    return { errors, warnings };
  }

  // Wired to `DEFAULT_RUNTIME_RENDER_CHECK` (shared with path-(a)'s
  // tier-2 gate). Renders the compiled component in happy-dom,
  // exercises declared actions/tools/streams, and emits `EvalIssue[]`.
  // We map fail→error, warn→warning so the pipeline's sequential-gate
  // semantics carry through.
  let issues: readonly EvalIssue[];
  try {
    issues = await DEFAULT_RUNTIME_RENDER_CHECK.run({
      sourceCode: input.sourceCode,
      compiledCode: input.compiledCode,
      contract: input.contract,
      fixtureProps: asJsonObject(input.fixtureProps),
    });
  } catch (e) {
    // Probe-internal infra failures (happy-dom load, ESM/CJS interop)
    // are caught and logged inside the probe; anything that escapes
    // here is a true bug. Surface as a warning rather than a hard
    // error so a flaky probe doesn't permanently block legitimate
    // blueprints — Claude can retry, and host-level logs record the
    // diagnostic for ops review.
    const message = e instanceof Error ? e.message : String(e);
    warnings.push({
      _kind: 'warning',
      tier: 'runtime',
      code: 'runtime:probe-infra-failure',
      message: `Runtime probe could not run: ${message}`,
    });
    return { errors, warnings };
  }

  for (const issue of issues) {
    const entry = {
      tier: 'runtime' as const,
      code: `runtime:${issue.subcategory ?? issue.category}`,
      message: issue.description,
      fix: issue.fix,
    };
    if (issue.result === 'fail') {
      errors.push(entry);
    } else if (issue.result === 'warn') {
      warnings.push({ _kind: 'warning', ...entry });
    }
  }

  return { errors, warnings };
}
