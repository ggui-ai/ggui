// packages/ui-gen/src/evaluation/axis-checks/checks/writes.ts
//
// Checks gated on writes != none. Ported from display.ts (action-hook,
// action-handler) + form.ts (submit-hook, submit-handler, submit-disabled)
// + collection.ts (per-item action variants).

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import {
  getActionNames,
  getSubmitActions,
  mkIssue,
} from "../helpers.js";

const ACTIVE_WRITES = [
  "commit", "multi-commit", "per-item", "submit", "compose",
] as const;

function runActionHookWired(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const actionNames = getActionNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of actionNames) {
    const re = new RegExp(`useAction(?:<[^>]*>)?\\s*\\(\\s*['"\`]${name}['"\`]`);
    if (re.test(src)) continue;
    issues.push(
      mkIssue(
        "writes.action_hook_wired",
        `Contract action "${name}" has no useAction('${name}') call.`,
        `Add \`const ${name} = useAction<...>('${name}');\` and wire it to the relevant control.`,
      ),
    );
  }
  return issues;
}

function runActionHandlerAttached(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const actionNames = getActionNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of actionNames) {
    const declRe = new RegExp(
      `const\\s+(\\w+)\\s*=\\s*useAction(?:<[^>]*>)?\\s*\\(\\s*['"\`]${name}['"\`]`,
    );
    const m = src.match(declRe);
    if (!m) continue;
    const constName = m[1];
    const rest = src.replace(m[0], "");
    if (new RegExp(`\\b${constName}\\s*\\(`).test(rest)) continue;
    issues.push(
      mkIssue(
        "writes.action_handler_attached",
        `useAction result "${constName}" (for action "${name}") is declared but never invoked.`,
        `Call ${constName}({...}) from an interactive element (e.g., <Button onClick={() => ${constName}(payload)}>).`,
      ),
    );
  }
  return issues;
}

function runSubmitDisabledPath(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const submits = getSubmitActions(input.contract);
  if (submits.length === 0) return [];
  if (/disabled\s*=\s*\{/.test(src)) return [];
  return [
    mkIssue(
      "writes.submit.disabled_path",
      `Form has no \`disabled={...}\` expression anywhere — submit is likely unconditional.`,
      `Gate submit on validation: e.g. \`<Button disabled={!isValid} onClick={handleSubmit}>\`.`,
      "warn",
    ),
  ];
}

export const WRITES_CHECKS: readonly AxisCheck[] = [
  {
    id: "writes.action_hook_wired",
    axis: "writes",
    values: ACTIVE_WRITES,
    run: runActionHookWired,
  },
  {
    id: "writes.action_handler_attached",
    axis: "writes",
    values: ACTIVE_WRITES,
    run: runActionHandlerAttached,
  },
  {
    id: "writes.submit.disabled_path",
    axis: "writes",
    values: ["submit"],
    run: runSubmitDisabledPath,
  },
];
