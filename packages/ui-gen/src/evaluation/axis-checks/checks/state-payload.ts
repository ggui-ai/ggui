// packages/ui-gen/src/evaluation/axis-checks/checks/state-payload.ts
//
// Checks gated on state=payload or writes=submit. Ported from
// mode-checks/form.ts (submit-hook, submit-handler, state-covers-payload,
// initial-values-seeded, option-lists-consumed, no-orphan-payload-key).

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import {
  collectStateKeys,
  getArrStrProps,
  getInitialValuePropNames,
  getSubmitActions,
  mkIssue,
} from "../helpers.js";

function runSubmitHookPresent(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const submits = getSubmitActions(input.contract);
  const issues: EvalIssue[] = [];
  for (const s of submits) {
    const re = new RegExp(`useAction(?:<[^>]*>)?\\s*\\(\\s*['"\`]${s.name}['"\`]`);
    if (re.test(src)) continue;
    issues.push(
      mkIssue(
        "writes.submit.hook_present",
        `Submit action "${s.name}" has no useAction('${s.name}') call.`,
        `Add \`const ${s.name} = useAction<...>('${s.name}');\` and invoke it from the submit button.`,
      ),
    );
  }
  return issues;
}

function runSubmitHandlerAttached(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const submits = getSubmitActions(input.contract);
  const issues: EvalIssue[] = [];
  for (const s of submits) {
    const declRe = new RegExp(
      `const\\s+(\\w+)\\s*=\\s*useAction(?:<[^>]*>)?\\s*\\(\\s*['"\`]${s.name}['"\`]`,
    );
    const m = src.match(declRe);
    if (!m) continue;
    const constName = m[1];
    const rest = src.replace(m[0], "");
    if (new RegExp(`\\b${constName}\\s*\\(`).test(rest)) continue;
    issues.push(
      mkIssue(
        "writes.submit.handler_attached",
        `useAction result "${constName}" (for submit "${s.name}") is declared but never invoked.`,
        `Call ${constName}(payload) from the submit button's onClick handler, after validation.`,
      ),
    );
  }
  return issues;
}

function runStateCoversPayload(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const submits = getSubmitActions(input.contract);
  if (submits.length === 0) return [];
  const stateKeys = collectStateKeys(src);
  const issues: EvalIssue[] = [];
  for (const s of submits) {
    const missing = s.payloadKeys.filter((k) => !stateKeys.has(k));
    if (missing.length === 0) continue;
    issues.push(
      mkIssue(
        "state.payload.covers_submit",
        `Submit action "${s.name}" expects payload keys [${s.payloadKeys.join(", ")}] but state does not cover: ${missing.join(", ")}.`,
        `Add a state slot for each missing key so the final payload can be assembled.`,
      ),
    );
  }
  return issues;
}

function runInitialValuesSeeded(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const initialProps = getInitialValuePropNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of initialProps) {
    const re = new RegExp(
      `useState(?:<[^>]*>)?\\s*\\([\\s\\S]{0,400}?props\\.${name}\\b`,
    );
    if (re.test(src)) continue;
    issues.push(
      mkIssue(
        "state.payload.initial_values_seeded",
        `Prop "${name}" (pre-filled initial values) is never read in a useState initializer.`,
        `Seed form state from props.${name} so edit mode pre-fills.`,
      ),
    );
  }
  return issues;
}

function runOptionListsConsumed(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const arrStrNames = getArrStrProps(input.contract);
  const hasAnyMap = /\.map\s*\(/.test(src);
  const issues: EvalIssue[] = [];
  for (const name of arrStrNames) {
    const referenced = new RegExp(`\\bprops\\.${name}\\b`).test(src);
    if (referenced && hasAnyMap) continue;
    const reason = !referenced
      ? `Option list prop "${name}" (arr<str>) is never referenced — users cannot see the options.`
      : `Option list prop "${name}" (arr<str>) is referenced but the component has no .map() — options are not rendered as choices.`;
    issues.push(
      mkIssue(
        "state.payload.option_lists_consumed",
        reason,
        `GguiSession options with \`props.${name}.map(option => <RadioOption value={option} ... />)\`.`,
      ),
    );
  }
  return issues;
}

function runNoOrphanPayloadKey(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const submits = getSubmitActions(input.contract);
  if (submits.length === 0) return [];
  const body = src
    .replace(/interface\s+Action\w+[\s\S]*?\n}/g, "")
    .replace(/type\s+Action\w+[\s\S]*?\n;/g, "");
  const issues: EvalIssue[] = [];
  for (const s of submits) {
    const orphans: string[] = [];
    for (const key of s.payloadKeys) {
      const re = new RegExp(`\\b${key}\\b`);
      if (!re.test(body)) orphans.push(key);
    }
    if (orphans.length === 0) continue;
    issues.push(
      mkIssue(
        "state.payload.no_orphan_key",
        `Submit payload keys [${orphans.join(", ")}] never appear in the component body — missing from the submitted payload.`,
        `Add UI and state for these keys, or remove them from the ActionEntry if not needed.`,
        "warn",
      ),
    );
  }
  return issues;
}

export const STATE_PAYLOAD_CHECKS: readonly AxisCheck[] = [
  {
    id: "writes.submit.hook_present",
    axis: "writes",
    values: ["submit"],
    run: runSubmitHookPresent,
  },
  {
    id: "writes.submit.handler_attached",
    axis: "writes",
    values: ["submit"],
    run: runSubmitHandlerAttached,
  },
  {
    id: "state.payload.covers_submit",
    axis: "state",
    values: ["payload"],
    run: runStateCoversPayload,
  },
  {
    id: "state.payload.initial_values_seeded",
    axis: "state",
    values: ["payload", "draft"],
    run: runInitialValuesSeeded,
  },
  {
    id: "state.payload.option_lists_consumed",
    axis: "state",
    values: ["payload"],
    run: runOptionListsConsumed,
  },
  {
    id: "state.payload.no_orphan_key",
    axis: "state",
    values: ["payload"],
    run: runNoOrphanPayloadKey,
  },
];
