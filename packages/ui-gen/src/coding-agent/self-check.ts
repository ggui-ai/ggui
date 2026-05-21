// packages/ui-gen/src/coding-agent/self-check.ts
//
// Self-check rules for the coding agent.
// Reuses runSelfChecks from adapters/tools.ts + contract validation.

import { runSelfChecks } from '../adapters/tools';
import { validateAllContracts } from '../check/index.js';
import { checkWirePreservation, type WireKind } from '../check/index.js';
import type { DataContract } from '@ggui-ai/protocol';
import type { BuildResult } from './types';

export interface SelfCheckResult {
  passed: boolean;
  violations: string[];
}

/** Map wire kind to the matching `@ggui-ai/wire` hook name. */
const HOOK_NAME_FOR: Readonly<Record<WireKind, string>> = {
  action: 'useAction',
  stream: 'useStream',
  context: 'useGguiContext',
};

/**
 * Run all self-checks on generated component code.
 * All rules always apply — single-file standalone mode only.
 */
export async function runCodingAgentSelfCheck(
  code: string,
  buildResult: BuildResult,
  contract?: DataContract,
): Promise<SelfCheckResult> {
  const violations: string[] = [];

  // ── Build check ────────────────────────────────────
  if (!buildResult.success) {
    violations.push(
      `builds_clean: Build failed${buildResult.errors?.length ? ': ' + buildResult.errors.join('; ') : ''}`,
    );
  }

  // ── Self-checks (imports, types, security, a11y) ──
  try {
    const { issues } = await runSelfChecks(code, contract);
    for (const issue of issues) {
      const fixHint = issue.fix ? ` → Fix: ${issue.fix}` : '';
      violations.push(`${issue.check}: ${issue.message} (line ${issue.line})${fixHint}`);
    }
  } catch {
    // runSelfChecks may fail if code is malformed — treat as non-blocking
  }

  // ── Contract validation ────────────────────────────
  if (contract) {
    try {
      const contractIssues = validateAllContracts(code, contract);
      for (const ci of contractIssues) {
        if (ci.severity === 'error') {
          violations.push(`contract:${ci.field}: ${ci.message} → Fix: ${ci.fix}`);
        }
      }
    } catch {
      // contract validation may fail on malformed code
    }
  }

  // ── Wire preservation ──────────────────────────────────────────────
  // The boilerplate generator emits one `const X = use{Action,Stream}('X')`
  // call per contract-declared wire plus one `useGguiContext('slot')` per
  // contextSpec slot. Those hook declarations ARE the contract-completeness
  // manifest. If the LLM's apply_patch deletes any of them, the component
  // will not fire the wire at runtime — but `pnpm typecheck` won't flag the
  // absence (a missing call is a missing side effect, not a type error).
  // This rule closes that gap at the deterministic self_check tier.
  // `agentTools` (catalog declaration, NOT a hook) and `clientCapabilities`
  // (vendor-package hooks, not @ggui-ai/wire) are intentionally excluded.
  if (contract) {
    try {
      const report = checkWirePreservation(code, contract);
      for (const site of report.missing) {
        const hook = HOOK_NAME_FOR[site.kind];
        violations.push(
          `wire_preservation:${site.kind}:${site.name}: ` +
          `Contract declares ${site.kind} '${site.name}' but no ${hook}('${site.name}') ` +
          `call exists in the component. The boilerplate placed this hook for you — ` +
          `restore it at the top of the function body and consume the returned binding ` +
          `(in JSX, a callback, or an effect).`,
        );
      }
    } catch {
      // Malformed code surfaces as a primary error elsewhere — don't
      // mask it with a wire-preservation noise-violation here.
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Get soft warnings (non-blocking quality checks).
 */
export function getSoftWarnings(code: string): string[] {
  const warnings: string[] = [];

  if (!/var\(--ggui-/.test(code)) {
    warnings.push(
      'uses_design_tokens: No CSS variables (var(--ggui-*)) found — consider using design system tokens',
    );
  }

  if (!/aria-label/.test(code)) {
    warnings.push(
      'has_aria_labels: No aria-label attributes found — consider adding for accessibility',
    );
  }

  return warnings;
}
