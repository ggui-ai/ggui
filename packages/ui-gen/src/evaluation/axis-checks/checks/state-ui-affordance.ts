// packages/ui-gen/src/evaluation/axis-checks/checks/state-ui-affordance.ts
//
// `state.ui_affordance.state_aria_present` (ggui#408) — a hand-rolled
// stateful control must expose its state in ARIA.
//
// Why this is a DETERMINISTIC check and not (only) an LLM criterion:
// the Experiment-53 baseline showed the defect class is structurally
// invisible to the LLM leg — `state=ui-affordance` with no writes
// classifies `riskTier=low`, and the low-risk bypass skips tier-1+2
// entirely, so 10/10 ARIA-less generations were never evaluated at
// all. Axis checks run BEFORE the bypass decision, and a `fail` among
// them disables the bypass for that round — which both surfaces the
// finding and routes it into the coding loop. Prototype validation
// against the 27-cell baseline corpus: precision 1.00, recall 0.80
// (both false negatives closed here: lowercase tags — `<div
// as={Clickable}>` is the WORSE variant since `as` is inert on a
// native element — and callback-prop indirection in extracted
// subcomponents).
//
// Detection predicate (v2 — "the element's own onClick mutates the
// affordance state"; v1's styling-dataflow precondition scored recall
// 0.30, do not resurrect it): an element fires when its `onClick`
// references a `useState` setter, a local handler that calls one, or
// an `on[A-Z]…` callback prop (extracted-subcomponent shape) — AND it
// is not a semantics-owning primitive, carries no state ARIA
// (`aria-checked/pressed/selected/expanded/current` or any `role=`),
// and contains no state-carrying primitive in its subtree (pushing
// duplicate ARIA onto a wrapper around `<Checkbox>` is itself a
// defect the judge fails — never demand it).
//
// Gate: `{axis: "state", values: ["ui-affordance"]}` ONLY. The
// predicate must not reach `state=payload/draft` (form-field wrappers
// with onClick would false-flag) or `state=merge` (kanban's per-item
// onClick is a MOVE, not a boolean affordance).

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import { mkIssue } from "../helpers.js";

const STATE_ARIA_OR_ROLE = /aria-(checked|pressed|selected|expanded|current)\s*=|role\s*=/;
const STATE_PRIMITIVE_IN_SUBTREE = /<(Checkbox|Toggle|Tabs|Accordion)[\s/>]/;
/** Primitives that own their own interaction semantics — never flagged. */
const SEMANTIC_PRIMITIVES = new Set(["Button", "Checkbox", "Toggle", "Link", "MenuItem"]);

/** Collect `const [x, setX] = useState(...)` setter names. */
function collectSetters(src: string): Set<string> {
  const setters = new Set<string>();
  for (const m of src.matchAll(/const\s*\[\s*\w+\s*,\s*(set\w+)\s*\]\s*=\s*useState/g)) {
    setters.add(m[1]);
  }
  return setters;
}

/** Collect local handler names whose body (nearby) calls a setter. */
function collectHandlers(src: string, setters: Set<string>): Set<string> {
  const handlers = new Set<string>();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*\{?/g)) {
    const body = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
    for (const s of setters) {
      if (body.includes(s)) {
        handlers.add(m[1]);
        break;
      }
    }
  }
  return handlers;
}

/** The attribute block of an opening tag: from after the tag name to its `>` (brace-aware). */
function attrBlock(src: string, start: number): { block: string; end: number } {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return { block: src.slice(start, i), end: i };
  }
  return { block: src.slice(start, start + 900), end: start + 900 };
}

/** The brace-balanced expression of `onClick={…}`, or null when absent. */
function onClickValue(block: string): string | null {
  const m = block.match(/onClick\s*=\s*\{/);
  if (!m || m.index === undefined) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < block.length; i++) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") {
      depth--;
      if (depth === 0) return block.slice(open + 1, i);
    }
  }
  return block.slice(open + 1);
}

function subtree(src: string, pos: number, tag: string): string {
  const close = src.indexOf(`</${tag}>`, pos);
  return src.slice(pos, close === -1 ? pos + 700 : close);
}

function runStateAriaPresent(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const setters = collectSetters(src);
  const handlers = collectHandlers(src, setters);
  const issues: EvalIssue[] = [];
  const flaggedLines = new Set<number>();

  // Locally-defined components: their CALL SITES can never satisfy the
  // check (the ARIA lives inside the definition, which this check
  // already covers via the callback-prop clause) — flagging the call
  // site is a permanently-unresolvable finding that stalls the
  // eval-fix loop in the recurrence guard (Experiment 54: exactly the
  // 2/27 stuck cells). Skip call sites of components defined in this
  // file; the definition's own inner element carries the check.
  const localComponents = new Set<string>();
  for (const m of src.matchAll(/(?:function\s+([A-Z]\w*)\s*\(|const\s+([A-Z]\w*)\s*=)/g)) {
    localComponents.add(m[1] ?? m[2]);
  }

  for (const m of src.matchAll(/<([A-Za-z][A-Za-z0-9]*)\b/g)) {
    const tag = m[1];
    if (m.index === undefined) continue;
    if (localComponents.has(tag)) continue;
    const { block, end } = attrBlock(src, m.index + m[0].length);
    const clickValue = onClickValue(block);
    if (clickValue === null) continue;
    const mutatesAffordance =
      [...setters].some((s) => clickValue.includes(s)) ||
      [...handlers].some((h) => new RegExp(`\\b${h}\\b`).test(clickValue)) ||
      // Extracted-subcomponent shape: the toggle handler arrives as an
      // `on[A-Z]…` callback prop and is invoked from onClick — inside a
      // ui-affordance component that IS the affordance mutation.
      /\bon[A-Z]\w*\b/.test(clickValue);
    if (!mutatesAffordance) continue;
    if (SEMANTIC_PRIMITIVES.has(tag)) continue;
    if (STATE_ARIA_OR_ROLE.test(block)) continue;
    if (STATE_PRIMITIVE_IN_SUBTREE.test(subtree(src, end, tag))) continue;

    const line = src.slice(0, m.index).split("\n").length;
    if (flaggedLines.has(line)) continue;
    flaggedLines.add(line);
    issues.push(
      mkIssue(
        "state.ui_affordance.state_aria_present",
        `Line ${line}: <${tag}> toggles the UI affordance from its onClick but exposes no state ARIA — its checked/selected/expanded state is invisible to assistive technology (styling is the only carrier).`,
        `Add the matching state attribute to the SAME element that carries the onClick: \`role="checkbox"\` + \`aria-checked={…}\` for a toggle row, \`aria-pressed\` for a toggle button, \`aria-selected\` for a selection, \`aria-expanded\` for an open/close affordance — or replace the hand-rolled control with the state-carrying primitive (Checkbox / Toggle / Tabs / Accordion). \`as={Clickable}\` adds button + keyboard semantics but NOT state.`,
      ),
    );
  }
  return issues;
}

export const STATE_UI_AFFORDANCE_CHECKS: readonly AxisCheck[] = [
  {
    id: "state.ui_affordance.state_aria_present",
    axis: "state",
    values: ["ui-affordance"],
    run: runStateAriaPresent,
  },
];
