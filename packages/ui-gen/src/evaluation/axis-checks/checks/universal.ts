// packages/ui-gen/src/evaluation/axis-checks/checks/universal.ts
//
// Checks that run regardless of axis value — they apply to any generated
// component. Dispatched via a "universal" gate that matches every render
// value.

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import {
  getRequiredPropNames,
  mkIssue,
} from "../helpers.js";

const ALL_RENDER_VALUES = [
  "static", "list", "grid", "spatial", "timeline", "chart", "master-detail",
] as const;

function runPropCoverage(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const requiredProps = getRequiredPropNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of requiredProps) {
    const dotAccess = new RegExp(`\\bprops\\.${name}\\b`);
    const bracketAccess = new RegExp(`\\bprops\\[['"\`]${name}['"\`]\\]`);
    const destructured = new RegExp(
      `props[^;]{0,200}\\{[^}]*\\b${name}\\b[^}]*\\}|\\{[^}]*\\b${name}\\b[^}]*\\}[^;]{0,10}=\\s*props`,
    );
    if (dotAccess.test(src) || bracketAccess.test(src) || destructured.test(src))
      continue;
    issues.push(
      mkIssue(
        "universal.prop_coverage",
        `Required prop "${name}" is not referenced anywhere in the component.`,
        `GguiSession props.${name} — the data contract marks it required.`,
      ),
    );
  }
  return issues;
}

function runNoPropMirror(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const issues: EvalIssue[] = [];
  const re =
    /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState(?:<[^>]*>)?\s*\(\s*props\??\.(\w+)/g;
  for (const m of src.matchAll(re)) {
    const [full, stateVar, setter, propName] = m;
    const idx = m.index ?? 0;
    const after = src.slice(idx + full.length);
    if (new RegExp(`\\b${setter}\\s*\\(`).test(after)) continue;
    issues.push(
      mkIssue(
        "universal.no_prop_mirror",
        `useState(props.${propName}) for "${stateVar}" has no "${setter}" call — this mirrors a prop without mutation.`,
        `Read props.${propName} directly in the render; remove the useState for ${stateVar}.`,
        "warn",
      ),
    );
  }
  return issues;
}

function runNoPhantomUseState(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const issues: EvalIssue[] = [];
  const re = /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState/g;
  for (const m of src.matchAll(re)) {
    const [full, stateVar, setter] = m;
    const idx = m.index ?? 0;
    const after = src.slice(idx + full.length);
    const stateUsed = new RegExp(`\\b${stateVar}\\b`).test(after);
    const setterUsed = new RegExp(`\\b${setter}\\b`).test(after);
    if (stateUsed || setterUsed) continue;
    issues.push(
      mkIssue(
        "universal.no_phantom_useState",
        `useState for "${stateVar}" is declared but neither "${stateVar}" nor "${setter}" is referenced.`,
        `Remove the useState for ${stateVar} — it is dead state.`,
        "warn",
      ),
    );
  }
  return issues;
}

export const UNIVERSAL_CHECKS: readonly AxisCheck[] = [
  {
    id: "universal.prop_coverage",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runPropCoverage,
  },
  {
    id: "universal.no_prop_mirror",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runNoPropMirror,
  },
  {
    id: "universal.no_phantom_useState",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runNoPhantomUseState,
  },
];
